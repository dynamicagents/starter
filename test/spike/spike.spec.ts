import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  createAgentHarness,
  type AgentHarness,
  type CapturedCallback
} from "@dynamicagents/core/testing";
import type { HitlRequestData } from "@dynamicagents/core/a2a";
import worker from "@/spike/worker";
import type { SpikeEnv, SpikeTenant } from "@/spike/env";

/**
 * The spike, driven end to end through core's real A2A edge.
 *
 * Everything below goes in as a gatekeeper-signed `SendMessage` and comes out
 * as a push callback — no Durable Object is poked to make a scenario happen.
 * The object is read only for the two facts a callback cannot carry: what the
 * work ledger holds, and whether a detached child actually stopped.
 *
 * **One tenant per scenario.** A turn queue is per Durable Object and
 * first-in-first-out, so two scenarios sharing an object would serialize and
 * each would see the other's callbacks.
 */

const spikeEnv = env as unknown as SpikeEnv;

/** The identity every harness token carries. It names the Durable Object. */
const CALLER_KEY = "custom:1:test-agent";

const TERMINAL_STATES = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED"
]);

function harnessFor(tenant: SpikeTenant): AgentHarness {
  return createAgentHarness({ worker, env: spikeEnv, tenant });
}

/** The object a tenant's turns run in — see `objectFor` in the spike Worker. */
function agentFor(tenant: SpikeTenant) {
  return spikeEnv.SpikeReactive.get(
    spikeEnv.SpikeReactive.idFromName(`${tenant}/${CALLER_KEY}`)
  );
}

/**
 * The callbacks for **one task**, in the state asked for.
 *
 * Filtered by task id rather than read off the harness whole: every harness
 * here captures the same gatekeeper webhook, so a callback still in flight when
 * the previous spec ended lands in the next one's list.
 */
function statesOf(
  harness: AgentHarness,
  taskId: string,
  state: string
): CapturedCallback[] {
  return harness.callbacks.filter(
    (callback) => callback.taskId === taskId && callback.state === state
  );
}

function terminals(harness: AgentHarness, taskId: string): CapturedCallback[] {
  return harness.callbacks.filter(
    (callback) =>
      callback.taskId === taskId && TERMINAL_STATES.has(callback.state)
  );
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until a condition holds.
 *
 * The turn runs on the object's alarm, not in the request that accepted it, so
 * there is nothing to await: a spec watches for the effect instead.
 */
async function until<T>(
  what: string,
  read: () => T | Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(50);
  }
}

const settled = (harness: AgentHarness, taskId: string, state: string) =>
  until(
    `a ${state} callback`,
    () => statesOf(harness, taskId, state),
    (callbacks) => callbacks.length > 0
  );

/**
 * One `SendMessage` under a caller-chosen `messageId`.
 *
 * The harness mints a fresh id per send, which is exactly what a redelivery
 * test cannot use: the whole point is the gatekeeper sending the same id twice.
 */
async function sendAs(
  harness: AgentHarness,
  tenant: SpikeTenant,
  messageId: string,
  text: string
): Promise<{ id: string }> {
  const res = await harness.rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "SendMessage",
    params: {
      tenant,
      message: { messageId, role: "ROLE_USER", parts: [{ text }] },
      configuration: {
        taskPushNotificationConfig: {
          url: harness.pushUrl,
          token: "spike-redelivery"
        }
      }
    }
  });
  const body = await res.json<{
    error?: { message: string };
    result?: { task?: { id: string } } & { id?: string };
  }>();
  if (body.error) throw new Error(`SendMessage refused: ${body.error.message}`);
  // The v1.0 response wraps the Task in a `task` key; the harness unwraps the
  // same way, because a result read off the wrong key is an `undefined` id that
  // matches no callback and fails as a timeout thirty seconds later.
  const task = body.result?.task ?? body.result;
  if (!task?.id) {
    throw new Error(`SendMessage returned no task: ${JSON.stringify(body)}`);
  }
  return { id: task.id };
}

/** `CancelTask`, the way a gatekeeper sends one. */
async function cancel(
  harness: AgentHarness,
  tenant: SpikeTenant,
  taskId: string
): Promise<void> {
  const res = await harness.rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "CancelTask",
    params: { tenant, id: taskId }
  });
  const body = await res.json<{ error?: { message: string } }>();
  if (body.error) throw new Error(`CancelTask refused: ${body.error.message}`);
}

/** The question a parked task is carrying, read off its callback. */
function questionOf(callback: CapturedCallback): HitlRequestData {
  const body = callback.body as {
    task?: { status?: { message?: { parts?: { data?: unknown }[] } } };
  };
  const parts = body.task?.status?.message?.parts ?? [];
  for (const part of parts) {
    const data = part.data as HitlRequestData | undefined;
    if (data?.requestId) return data;
  }
  throw new Error("the input-required callback carried no question");
}

describe("the A2A lifecycle on Think", () => {
  it("accepts a turn and calls back exactly once", async () => {
    const harness = harnessFor("spike-accept");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("echo:hello there");
    expect(String(accepted.status.state)).toContain("SUBMITTED");

    const done = await settled(harness, accepted.id, "TASK_STATE_COMPLETED");
    expect(done[0].text).toBe("hello there");
    // The accept-and-notify contract in one assertion: a task terminates once.
    expect(terminals(harness, accepted.id)).toHaveLength(1);
  });

  it("runs one turn for a redelivered messageId", async () => {
    const harness = harnessFor("spike-redeliver");
    using _ = harness.interceptGatekeeper();

    const messageId = "gatekeeper-redelivered-1";
    const first = await sendAs(
      harness,
      "spike-redeliver",
      messageId,
      "echo:said once"
    );
    const second = await sendAs(
      harness,
      "spike-redeliver",
      messageId,
      "echo:said once"
    );
    // The dedupe key is the gatekeeper's own message id, so the retry has to
    // land on the task the first one created.
    expect(second.id).toBe(first.id);

    await settled(harness, first.id, "TASK_STATE_COMPLETED");
    await pause(500);
    expect(terminals(harness, first.id)).toHaveLength(1);
    expect(statesOf(harness, first.id, "TASK_STATE_COMPLETED")[0].text).toBe(
      "said once"
    );
  });

  it("parks a task on a question for the caller", async () => {
    const harness = harnessFor("spike-ask");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("ask:which one?");
    const parked = await settled(
      harness,
      accepted.id,
      "TASK_STATE_INPUT_REQUIRED"
    );

    const question = questionOf(parked[0]);
    expect(question.prompt).toBe("which one?");
    expect(question.options?.map((option) => option.id)).toEqual(["yes", "no"]);
    // Parked is not finished: nothing terminal may have been sent.
    expect(terminals(harness, accepted.id)).toHaveLength(0);

    const inspection = await agentFor("spike-ask").inspect(accepted.id);
    expect(JSON.parse(inspection).row.state).toBe("input-required");
  });

  it("resumes a parked task when the question is answered", async () => {
    const harness = harnessFor("spike-answer");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("ask:which one?");
    const parked = await settled(
      harness,
      accepted.id,
      "TASK_STATE_INPUT_REQUIRED"
    );
    const question = questionOf(parked[0]);

    await harness.answer(accepted.id, question.requestId, { optionId: "yes" });

    const done = await settled(harness, accepted.id, "TASK_STATE_COMPLETED");
    // The label the person saw, not the id the wire carried: the agent shows
    // the model what the question offered.
    expect(done[0].text).toBe("Yes");
    expect(terminals(harness, accepted.id)).toHaveLength(1);
  });

  it("ignores a reply naming a question this task never asked", async () => {
    const harness = harnessFor("spike-foreign");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("ask:which one?");
    await settled(harness, accepted.id, "TASK_STATE_INPUT_REQUIRED");

    await harness.answer(accepted.id, "some-other-request", {
      optionId: "yes"
    });
    await pause(500);

    // Still parked, and nothing was sent: an answer to a question this task
    // did not ask must not resume it.
    const inspection = await agentFor("spike-foreign").inspect(accepted.id);
    expect(JSON.parse(inspection).row.state).toBe("input-required");
    expect(terminals(harness, accepted.id)).toHaveLength(0);
  });

  it("fails a task whose question expired unanswered", async () => {
    const harness = harnessFor("spike-timeout");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("ask:which one?");
    const parked = await settled(
      harness,
      accepted.id,
      "TASK_STATE_INPUT_REQUIRED"
    );
    const question = questionOf(parked[0]);

    // The SDK loads the task before it takes a message, and a terminal one
    // takes none — so the expiry is settled from the queue, after this returns.
    await harness.timeout(accepted.id, question.requestId);

    const failed = await settled(harness, accepted.id, "TASK_STATE_FAILED");
    expect(failed[0].text).toContain("Nobody answered in time");
    expect(terminals(harness, accepted.id)).toHaveLength(1);
  });

  it("cancels a turn that is still running", async () => {
    const harness = harnessFor("spike-cancel");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("wait:20");
    const agent = agentFor("spike-cancel");
    await until(
      "the turn to start",
      async () => JSON.parse(await agent.inspect(accepted.id)),
      (state) => state.row?.state === "working"
    );

    await cancel(harness, "spike-cancel", accepted.id);
    await pause(1_000);

    expect(JSON.parse(await agent.inspect(accepted.id)).row.state).toBe(
      "canceled"
    );
    // A canceled task never gets a completed or failed callback, whatever the
    // turn goes on to do.
    expect(terminals(harness, accepted.id)).toHaveLength(0);
  });

  it("fails a task when the turn errors", async () => {
    const harness = harnessFor("spike-error");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("boom");

    const failed = await settled(harness, accepted.id, "TASK_STATE_FAILED");
    expect(failed[0].text).toContain("Something went wrong");
    expect(terminals(harness, accepted.id)).toHaveLength(1);
  });
});

describe("detached delegation (G10)", () => {
  it("keeps the task working until the background run reports", async () => {
    const harness = harnessFor("spike-bg");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("bgdelegate:sleep:2");

    const done = await settled(harness, accepted.id, "TASK_STATE_COMPLETED");
    const working = statesOf(harness, accepted.id, "TASK_STATE_WORKING").map(
      (callback) => callback.text
    );
    // The `onChunk` flush: the sentence before the tool call, pushed as the
    // tool starts rather than after it.
    expect(working).toContain("Started in the background.");
    // …and the first turn's text again, when settlement found open work and
    // left the task open instead of answering.
    expect(working.length).toBeGreaterThanOrEqual(2);

    expect(done[0].text).toContain('Background task "SpikeGeneral"');
    expect(done[0].text).toContain("child did: sleep:2");
    expect(terminals(harness, accepted.id)).toHaveLength(1);

    const state = JSON.parse(await agentFor("spike-bg").inspect(accepted.id));
    expect(state.row.state).toBe("completed");
    expect(state.work).toHaveLength(1);
    expect(state.work[0].open).toBe(false);
    // The evidence a deployed run leaves behind, where no push sink is reachable.
    expect(
      state.deliveries.filter(
        (delivery: { state: string }) => delivery.state === "completed"
      )
    ).toHaveLength(1);
  });

  it("cancels the background run with the task", async () => {
    const harness = harnessFor("spike-bg-cancel");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("bgdelegate:sleep:20");
    const agent = agentFor("spike-bg-cancel");
    const running = await until(
      "the background run to start",
      async () => JSON.parse(await agent.inspect(accepted.id)),
      (state) => state.work?.length === 1 && state.work[0].open === true
    );
    expect(running.runs[0].status).not.toBe("completed");

    await cancel(harness, "spike-bg-cancel", accepted.id);
    await pause(2_000);

    const state = JSON.parse(await agent.inspect(accepted.id));
    expect(state.row.state).toBe("canceled");
    expect(state.work[0].open).toBe(false);
    // The child stopped: a cancel that only flips the row leaves a sub-agent
    // running and billing for the rest of its sleep.
    expect(state.runs[0].status).not.toBe("completed");
    expect(terminals(harness, accepted.id)).toHaveLength(0);
  });

  it("settles only once every background run has reported", async () => {
    const harness = harnessFor("spike-bg-two");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("bgdelegate2:sleep:1|sleep:3");

    await until(
      "the first child to report",
      () =>
        statesOf(harness, accepted.id, "TASK_STATE_WORKING").map(
          (callback) => callback.text
        ),
      (texts) => texts.some((text) => text.includes("child did: sleep:1"))
    );
    // One of two is not finished. This is the assertion the whole work ledger
    // exists for: without it the first report would settle the task.
    expect(terminals(harness, accepted.id)).toHaveLength(0);

    const done = await settled(harness, accepted.id, "TASK_STATE_COMPLETED");
    expect(done[0].text).toContain("child did: sleep:3");
    expect(terminals(harness, accepted.id)).toHaveLength(1);
  });

  it("ends the turn at a check_back and settles after the wake", async () => {
    const harness = harnessFor("spike-checkback");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("checkback:2");
    const agent = agentFor("spike-checkback");

    // The turn ends on the `stopWhen`, so the wait row is open almost at once
    // — and the task is still working, not answered.
    const waiting = await until(
      "the wait to be recorded",
      async () => JSON.parse(await agent.inspect(accepted.id)),
      (state) => state.work?.length === 1
    );
    expect(waiting.work[0].kind).toBe("wait");
    expect(terminals(harness, accepted.id)).toHaveLength(0);

    const done = await settled(harness, accepted.id, "TASK_STATE_COMPLETED");
    expect(done[0].text).toContain("Waited 2s: spike");
    expect(terminals(harness, accepted.id)).toHaveLength(1);

    const state = JSON.parse(await agent.inspect(accepted.id));
    expect(state.work[0].open).toBe(false);
  });
});

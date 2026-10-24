import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  createAgentHarness,
  TERMINAL_CALLBACK_STATES,
  type AgentHarness,
  type CapturedCallback
} from "@dynamicagents/core/testing";
import type { HitlRequestData } from "@dynamicagents/g2a-protocol";
import { copy } from "@/copy";
import worker, { waits, type TestEnv } from "./worker";

/**
 * Each one-step tenant's A2A lifecycle, driven end to end through core's edge,
 * its host and its pipeline, on a scripted model: every scenario goes in as a
 * gatekeeper-signed `SendMessage` and comes out as push callbacks.
 *
 * Core's own suite holds the lifecycle itself. What is checked here is that each
 * agent is wired into it: its host runs its pipeline on it, its plugins start,
 * its souls load, its retry is briefed, its sub-agent is
 * reachable under the tool name its model is told, and its mode — awaited or
 * in the background — is the one its spec declares.
 *
 * **One caller per spec.** An object runs its turns one at a time, so two specs
 * sharing one would serialize and see each other's callbacks.
 */

const testEnv = env as unknown as TestEnv;

/** `claude-coordinator`'s tasks are a pipeline: `./claude-coordinator-pipeline.spec.ts`. */
const TENANTS = [
  { tenant: "generic", background: false },
  { tenant: "coding", background: true }
] as const;

function harnessFor(tenant: string, label: string): AgentHarness {
  return createAgentHarness({
    worker,
    env: testEnv,
    tenant,
    identity: {
      key: `${tenant}:${label}:${crypto.randomUUID()}`,
      name: "Spec Caller",
      kind: "custom",
      workspaceId: 1
    }
  });
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `ready` answers something, so a spec synchronizes on the agent
 * rather than on a sleep long enough to usually be enough.
 */
async function until<T>(
  what: string,
  ready: () => T | undefined,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = ready();
    if (got !== undefined) return got;
    if (Date.now() >= deadline) throw new Error(`${what}: still waiting`);
    await pause(50);
  }
}

function terminals(harness: AgentHarness, taskId: string): CapturedCallback[] {
  return harness.callbacks.filter(
    (c) => c.taskId === taskId && TERMINAL_CALLBACK_STATES.has(c.state)
  );
}

/** What the agent said while it worked: the progress lines, without questions. */
function working(harness: AgentHarness, taskId: string): string[] {
  return harness.callbacks
    .filter(
      (c) =>
        c.taskId === taskId &&
        c.state === "TASK_STATE_WORKING" &&
        !questionIn(c) &&
        c.text
    )
    .map((c) => c.text);
}

/** The question a callback carries, on whatever status it rides, or `null`. */
function questionIn(callback: CapturedCallback): HitlRequestData | null {
  const body = callback.body as {
    task?: { status?: { message?: { parts?: { data?: unknown }[] } } };
  };
  for (const part of body.task?.status?.message?.parts ?? []) {
    const data = part.data as HitlRequestData | undefined;
    if (data?.requestId) return data;
  }
  return null;
}

/** The first question a task asked: it rides a `working` update. */
function asked(
  harness: AgentHarness,
  taskId: string
): Promise<HitlRequestData> {
  return until(
    `a question of task ${taskId}`,
    () => {
      const found = harness.callbacks.find(
        (c) => c.taskId === taskId && questionIn(c)
      );
      return found ? (questionIn(found) ?? undefined) : undefined;
    },
    20_000
  );
}

async function cancel(harness: AgentHarness, tenant: string, taskId: string) {
  const res = await harness.rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "CancelTask",
    params: { tenant, id: taskId }
  });
  const body = await res.json<{ error?: { message: string } }>();
  if (body.error) throw new Error(body.error.message);
}

describe.each(TENANTS)("$tenant", ({ tenant, background }) => {
  it("answers a turn and calls back exactly once", async () => {
    const harness = harnessFor(tenant, "turn");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("echo:hello there");
    const done = await harness.waitForTerminal(accepted.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toBe("hello there");
    await pause(300);
    expect(terminals(harness, accepted.id)).toHaveLength(1);
  });

  it("runs a failed turn once more, briefed as a retry", async () => {
    const harness = harnessFor(tenant, "flaky");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("flaky");
    const done = await harness.waitForTerminal(accepted.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toBe("recovered");
    await pause(300);
    expect(terminals(harness, accepted.id)).toHaveLength(1);
  });

  it("fails a turn that errors twice, in this deployment's words", async () => {
    const harness = harnessFor(tenant, "boom");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("boom");
    const failed = await harness.waitForTerminal(accepted.id);
    expect(failed.state).toBe("TASK_STATE_FAILED");
    expect(failed.text).toBe(copy.failed);
  });

  it("parks on a question, and completes once it is answered", async () => {
    const harness = harnessFor(tenant, "ask");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("ask:which one?");
    const question = await asked(harness, accepted.id);
    expect(question.questions[0]?.prompt).toBe("which one?");

    await harness.answer(accepted.id, question.requestId, {
      q1: { optionIds: ["q1.o1"] }
    });
    const done = await harness.waitForTerminal(accepted.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(terminals(harness, accepted.id)).toHaveLength(1);
  });

  it("takes a message that joins its task while a question waits", async () => {
    const harness = harnessFor(tenant, "join");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("ask:which one?");
    const question = await asked(harness, accepted.id);
    await harness.waitForState(accepted.id, "TASK_STATE_INPUT_REQUIRED");

    // Sent onto the open task, as the gatekeeper sends a thread's next message.
    const joined = await harness.send("echo:any news?", {
      taskId: accepted.id
    });
    expect(joined.id).toBe(accepted.id);
    await until(
      "the joined turn",
      () =>
        working(harness, accepted.id).includes("any news?") ? true : undefined,
      20_000
    );
    expect(terminals(harness, accepted.id)).toHaveLength(0);

    await harness.answer(accepted.id, question.requestId, {
      q1: { optionIds: ["q1.o1"] }
    });
    const done = await harness.waitForTerminal(accepted.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(terminals(harness, accepted.id)).toHaveLength(1);
  });

  it("cancels a turn that is still running, and never calls back as done", async () => {
    const harness = harnessFor(tenant, "cancel");
    using _ = harness.interceptGatekeeper();

    const from = waits.length;
    const accepted = await harness.send("wait:20");
    /**
     * Synchronized on the wait at both ends, because a pause is neither.
     * The cancel has to land while the turn is *inside* the tool, and what is
     * asserted below — that no callback said the task was done — only holds
     * once that tool is over: a turn still running would call back later, long
     * after a pause that looked settled.
     */
    const waiting = await until(
      "the turn to reach its wait",
      () => waits.slice(from).find((call) => call.tool === "parent"),
      20_000
    );
    await cancel(harness, tenant, accepted.id);
    await until("the wait to end", () => waiting.ended, 30_000);
    // What is left after it is local and bounded: the model turn that would
    // answer, and the settle core's ledger refuses against a canceled task.
    await pause(1_000);

    const task = await harness.rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "GetTask",
      params: { tenant, id: accepted.id }
    });
    const body = await task.json<{
      result?: { status?: { state?: string } };
    }>();
    expect(body.result?.status?.state).toBe("TASK_STATE_CANCELED");
    expect(terminals(harness, accepted.id)).toHaveLength(0);
    // And the work was not started again, so there is no later turn to answer.
    expect(waits.slice(from)).toEqual([waiting]);
  });

  if (background) {
    it("keeps the task working while its sub-agent runs, then answers once", async () => {
      const harness = harnessFor(tenant, "background");
      using _ = harness.interceptGatekeeper();

      const accepted = await harness.send("delegate:sleep:1");
      const done = await harness.waitForTerminal(accepted.id);

      // The sentence before the call, pushed as the call started.
      expect(working(harness, accepted.id)).toContain("Delegating.");
      expect(done.state).toBe("TASK_STATE_COMPLETED");
      expect(done.text).toContain("child did: sleep:1");
      await pause(300);
      expect(terminals(harness, accepted.id)).toHaveLength(1);
    });
  } else {
    it("waits for its sub-agent in the same turn, and answers with its result", async () => {
      const harness = harnessFor(tenant, "awaited");
      using _ = harness.interceptGatekeeper();

      const accepted = await harness.send("delegate:sleep:1");
      const done = await harness.waitForTerminal(accepted.id);
      expect(done.state).toBe("TASK_STATE_COMPLETED");
      expect(done.text).toContain("child did: sleep:1");
      expect(terminals(harness, accepted.id)).toHaveLength(1);
    });
  }
});

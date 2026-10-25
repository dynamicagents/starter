import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import type { HitlRequestData } from "@dynamicagents/g2a-protocol";
import {
  createAgentHarness,
  TERMINAL_CALLBACK_STATES,
  type AgentHarness,
  type CapturedCallback
} from "@dynamicagents/core/testing";
import { requireArtifactsStub } from "@dynamicagents/core/artifacts";
import type { TaskResult } from "@dynamicagents/core/workflow";
import worker, { type TestEnv } from "./worker";

/**
 * `claude-coordinator` through the real host and workflow, on the scripted agent:
 * one step, the whole task, in which planning and approving are the agent's own
 * tool calls. `plan:` starts a planning session, `approve:<id>` asks the caller
 * to approve a plan, `delegate:` starts a writing session.
 */

const testEnv = env as unknown as TestEnv;

function setup(label: string) {
  const key = `claude-coordinator-pipeline:${label}:${crypto.randomUUID()}`;
  const harness = createAgentHarness({
    worker,
    env: testEnv,
    tenant: "claude-coordinator",
    identity: { key, name: "Spec Caller", kind: "custom", workspaceId: 1 }
  });
  // Named by the caller's **scope** and never by the identity key, which is one
  // half of it: the edge routes a turn to the scope, so a spec that opens a plan
  // on this object has to be on the object the turn will run on. A plan opened
  // on any other carries an owner the approval gate refuses, and the only
  // symptom is a question nobody is ever asked.
  const coder = testEnv.TEST_CLAUDE_COORDINATOR_AGENT.get(
    testEnv.TEST_CLAUDE_COORDINATOR_AGENT.idFromName(harness.callerScope)
  );
  return { harness, coder };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(
  what: string,
  read: () => Promise<T> | T,
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

/** The `count`th question a task asked. Questions ride `working` updates. */
async function question(
  harness: AgentHarness,
  taskId: string,
  count = 1
): Promise<HitlRequestData> {
  const asked = await until(
    `question ${count}`,
    () => harness.callbacks.filter((c) => c.taskId === taskId && questionIn(c)),
    (c) => c.length >= count
  );
  return questionIn(asked[count - 1]!)!;
}

async function status(taskId: string) {
  return (await testEnv.TEST_CLAUDE_COORDINATOR_WORKFLOW.get(taskId)).status();
}

async function cancel(harness: AgentHarness, taskId: string) {
  const res = await harness.rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "CancelTask",
    params: { tenant: "claude-coordinator", id: taskId }
  });
  const body = await res.json<{ error?: { message: string } }>();
  if (body.error) throw new Error(body.error.message);
}

describe("a task is one step", () => {
  it("runs the whole task on the caller's agent", async () => {
    const { harness } = setup("one-step");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("delegate:sleep:1");
    await using instance = await introspectWorkflowInstance(
      testEnv.TEST_CLAUDE_COORDINATOR_WORKFLOW,
      task.id
    );

    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toContain("child did: sleep:1");
    expect(working(harness, task.id)).toContain("Delegating.");
    await instance.waitForStatus("complete");
    const output = (await instance.getOutput()) as TaskResult;
    expect(output.verdict.steps).toEqual(["main"]);
    await pause(300);
    expect(terminals(harness, task.id)).toHaveLength(1);
  });

  it("runs a failed step once more, briefed as a retry", async () => {
    const { harness } = setup("retry");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("flaky");
    await using instance = await introspectWorkflowInstance(
      testEnv.TEST_CLAUDE_COORDINATOR_WORKFLOW,
      task.id
    );

    const done = await harness.waitForTerminal(task.id);
    expect(done.text).toBe("recovered");
    await instance.waitForStatus("complete");
    const output = (await instance.getOutput()) as TaskResult;
    expect(output.verdict.steps).toEqual(["main", "main:retry"]);
  });

  it("relays a question, and finishes on its answer", async () => {
    const { harness } = setup("ask");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("ask:which one?");
    const asked = await question(harness, task.id);
    expect(asked.questions[0]?.prompt).toBe("which one?");
    await harness.answer(task.id, asked.requestId, {
      q1: { optionIds: ["q1.o1"] }
    });
    expect((await harness.waitForTerminal(task.id)).text).toBe("Yes");
  });
});

describe("a plan", () => {
  it("is written by a planning session in the background", async () => {
    const { harness } = setup("plan");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("plan:sleep:1");

    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toContain("child did: sleep:1");
    expect(working(harness, task.id)).toContain("Planning.");
  });

  /**
   * Approved through core's `ask_user`, on the caller's own plan: the question
   * carries the plan's link, and approving it locks the plan.
   */
  it("is put to the caller with its link, and locked once approved", async () => {
    const { harness, coder } = setup("approve");
    using _ = harness.interceptGatekeeper();
    const id = await coder.openPlan();
    const artifacts = requireArtifactsStub(testEnv);
    await artifacts.addEntry(id, { label: "plan", text: "# Plan\n\nthe plan" });

    const task = await harness.send(`approve:${id}`);
    const asked = await question(harness, task.id);
    expect(asked.questions).toEqual([
      {
        kind: "approval",
        id: "q1",
        prompt: "Approve the plan?",
        artifact: { id, url: expect.stringMatching(new RegExp(`/a/${id}$`)) }
      }
    ]);
    await harness.answer(task.id, asked.requestId, {
      q1: { optionIds: ["approve"] }
    });

    expect((await harness.waitForTerminal(task.id)).text).toBe("Approved.");
    expect(await artifacts.artifactState(id)).toMatchObject({
      status: "approved",
      locked: true
    });
  });

  it("takes a message that joins its task while the approval waits", async () => {
    const { harness, coder } = setup("join");
    using _ = harness.interceptGatekeeper();
    const id = await coder.openPlan();
    await requireArtifactsStub(testEnv).addEntry(id, {
      label: "plan",
      text: "# Plan\n\nthe plan"
    });

    const task = await harness.send(`approve:${id}`);
    const asked = await question(harness, task.id);
    await harness.waitForState(task.id, "TASK_STATE_INPUT_REQUIRED");

    // Sent onto the open task, as the gatekeeper sends a thread's next message.
    const joined = await harness.send("echo:any news?", { taskId: task.id });
    expect(joined.id).toBe(task.id);
    await until(
      "the joined turn",
      () => working(harness, task.id),
      (lines) => lines.includes("any news?"),
      20_000
    );
    expect(terminals(harness, task.id)).toHaveLength(0);

    await harness.answer(task.id, asked.requestId, {
      q1: { optionIds: ["approve"] }
    });
    expect((await harness.waitForTerminal(task.id)).text).toBe("Approved.");
  });

  it("is not put to the caller when it is not theirs", async () => {
    const { harness } = setup("approve-foreign");
    using _ = harness.interceptGatekeeper();
    // A plan another caller's agent opened: its link may have been shared, but
    // it is not this caller's to approve.
    const other = setup("approve-owner");
    const id = await other.coder.openPlan();

    const task = await harness.send(`approve:${id}`);
    const done = await harness.waitForTerminal(task.id);
    expect(done.text).toMatch(
      /Not an artifact you can ask the person to approve/
    );
    expect(
      harness.callbacks.some(
        (c) => c.taskId === task.id && c.state === "TASK_STATE_INPUT_REQUIRED"
      )
    ).toBe(false);
    expect(await requireArtifactsStub(testEnv).artifactState(id)).toMatchObject(
      { locked: false }
    );
  });
});

describe("stopping", () => {
  it("cancels while a session runs: no callback, the instance ends", async () => {
    const { harness } = setup("cancel");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("delegate:sleep:30");
    await until(
      "the session",
      () => working(harness, task.id),
      (w) => w.includes("Delegating.")
    );
    await cancel(harness, task.id);
    await until(
      "terminated",
      () => status(task.id),
      (s) => s.status === "terminated"
    );
    await pause(300);
    expect(terminals(harness, task.id)).toHaveLength(0);
  });

  it("cancels at an approval", async () => {
    const { harness, coder } = setup("cancel-approval");
    using _ = harness.interceptGatekeeper();
    const id = await coder.openPlan();
    const task = await harness.send(`approve:${id}`);
    await question(harness, task.id);
    await cancel(harness, task.id);
    await until(
      "terminated",
      () => status(task.id),
      (s) => s.status === "terminated"
    );
    expect(terminals(harness, task.id)).toHaveLength(0);
  });

  it("tells the agent an approval expired, and finishes on what it says", async () => {
    const { harness, coder } = setup("expire");
    using _ = harness.interceptGatekeeper();
    const id = await coder.openPlan();
    const task = await harness.send(`approve:${id}`);
    const asked = await question(harness, task.id);
    await harness.timeout(task.id, asked.requestId);
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toMatch(
      /^Nobody answered "Approve the plan\?" before it expired/
    );
  });
});

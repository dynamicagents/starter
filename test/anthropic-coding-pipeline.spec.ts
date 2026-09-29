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
import { copy } from "@/copy";
import worker, { type TestEnv } from "./worker";

/**
 * `anthropic-coding` through the real host and workflow, on the scripted agent:
 * one step, the whole task, in which planning and approving are the agent's own
 * tool calls. `plan:` starts a planning session, `approve:<id>` asks the caller
 * to approve a plan, `delegate:` starts a writing session.
 */

const testEnv = env as unknown as TestEnv;

function setup(label: string) {
  const key = `anthropic-coding-pipeline:${label}:${crypto.randomUUID()}`;
  const harness = createAgentHarness({
    worker,
    env: testEnv,
    tenant: "anthropic-coding",
    identity: { key, name: "Spec Caller", kind: "custom", workspaceId: 1 }
  });
  const coder = testEnv.TEST_ANTHROPIC_CODING_AGENT.get(
    testEnv.TEST_ANTHROPIC_CODING_AGENT.idFromName(key)
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

function working(harness: AgentHarness, taskId: string): string[] {
  return harness.callbacks
    .filter((c) => c.taskId === taskId && c.state === "TASK_STATE_WORKING")
    .map((c) => c.text);
}

async function question(
  harness: AgentHarness,
  taskId: string,
  count = 1
): Promise<HitlRequestData> {
  const asked = await until(
    `question ${count}`,
    () =>
      harness.callbacks.filter(
        (c) => c.taskId === taskId && c.state === "TASK_STATE_INPUT_REQUIRED"
      ),
    (c) => c.length >= count
  );
  const body = asked[asked.length - 1]!.body as {
    task?: { status?: { message?: { parts?: { data?: unknown }[] } } };
  };
  for (const part of body.task?.status?.message?.parts ?? []) {
    const data = part.data as HitlRequestData | undefined;
    if (data?.requestId) return data;
  }
  throw new Error("the input-required callback carried no question");
}

async function status(taskId: string) {
  return (await testEnv.TEST_ANTHROPIC_CODING_WORKFLOW.get(taskId)).status();
}

async function cancel(harness: AgentHarness, taskId: string) {
  const res = await harness.rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "CancelTask",
    params: { tenant: "anthropic-coding", id: taskId }
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
      testEnv.TEST_ANTHROPIC_CODING_WORKFLOW,
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
      testEnv.TEST_ANTHROPIC_CODING_WORKFLOW,
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
    expect(asked.prompt).toBe("which one?");
    await harness.answer(task.id, asked.requestId, { optionId: "option_1" });
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
    expect(asked.requestKind).toBe("approval");
    expect(asked.prompt).toContain(`/a/${id}`);
    await harness.answer(task.id, asked.requestId, { optionId: "approve" });

    expect((await harness.waitForTerminal(task.id)).text).toBe("Approved.");
    expect(await artifacts.artifactState(id)).toMatchObject({
      status: "approved",
      locked: true
    });
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
    expect(done.text).toContain("Nothing was asked");
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

  it("fails the task in its words when an approval expires", async () => {
    const { harness, coder } = setup("expire");
    using _ = harness.interceptGatekeeper();
    const id = await coder.openPlan();
    const task = await harness.send(`approve:${id}`);
    const asked = await question(harness, task.id);
    await harness.timeout(task.id, asked.requestId);
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_FAILED");
    expect(done.text).toBe(copy.questionExpired);
  });
});

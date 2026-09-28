import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  introspectWorkflowInstance,
  runInDurableObject
} from "cloudflare:test";
import type { HitlRequestData } from "@dynamicagents/g2a-protocol";
import {
  createAgentHarness,
  TERMINAL_CALLBACK_STATES,
  type AgentHarness,
  type CapturedCallback
} from "@dynamicagents/core/testing";
import type { TaskResult } from "@dynamicagents/core/workflow";
import { activeToolsFor, PLAN_TOOLS } from "@/agents/claude-coder/roles";
import { copy, PIPELINE_COPY } from "@/copy";
import worker, { type TestEnv } from "./worker";

/**
 * claude-coder's pipeline — plan, approve, code — through the real host and
 * workflow, on the scripted agent. The plan and the code steps are jobs on the
 * caller's ClaudeCoder; the approval is the pipeline's own question.
 *
 * The scripted agent reads the task's text as its plan step's script, and the
 * approved plan as its code step's: `echo:delegate:sleep:1` plans
 * "delegate:sleep:1", and the code step then starts a writing session.
 */

const testEnv = env as unknown as TestEnv;

function setup(label: string) {
  const key = `claude-coder-pipeline:${label}:${crypto.randomUUID()}`;
  const harness = createAgentHarness({
    worker,
    env: testEnv,
    tenant: "claude-coder",
    identity: { key, name: "Spec Caller", kind: "custom", workspaceId: 1 }
  });
  const coder = testEnv.TEST_CLAUDE_CODER.get(
    testEnv.TEST_CLAUDE_CODER.idFromName(key)
  );
  const turns = async () =>
    JSON.parse(await coder.debugTurns()) as {
      role: string | null;
      active: string[] | null;
    }[];
  return { harness, coder, turns };
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
  return (await testEnv.TEST_CLAUDE_CODER_TASK.get(taskId)).status();
}

async function cancel(harness: AgentHarness, taskId: string) {
  const res = await harness.rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "CancelTask",
    params: { tenant: "claude-coder", id: taskId }
  });
  const body = await res.json<{ error?: { message: string } }>();
  if (body.error) throw new Error(body.error.message);
}

describe("plan → approve → code", () => {
  it("asks to approve the plan, then builds it in a writing session", async () => {
    const { harness } = setup("approve");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("echo:delegate:sleep:1");
    await using instance = await introspectWorkflowInstance(
      testEnv.TEST_CLAUDE_CODER_TASK,
      task.id
    );

    const plan = await question(harness, task.id);
    expect(plan.requestKind).toBe("approval");
    expect(plan.prompt).toBe(
      `delegate:sleep:1\n\n${PIPELINE_COPY.approveHint}`
    );
    await harness.answer(task.id, plan.requestId, { optionId: "approve" });

    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toContain("child did: sleep:1");
    expect(working(harness, task.id)).toContain("Delegating.");
    await instance.waitForStatus("complete");
    const output = (await instance.getOutput()) as TaskResult;
    expect(output.verdict.steps).toHaveLength(3);
    expect(output.verdict.steps.slice(1)).toEqual(["approve:0", "code"]);
    await pause(300);
    expect(terminals(harness, task.id)).toHaveLength(1);
  });

  it("writes the plan again on a comment, for as long as it takes", async () => {
    const { harness } = setup("replan");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("echo:plan A");

    const first = await question(harness, task.id, 1);
    await harness.answer(task.id, first.requestId, { text: "smaller" });
    const second = await question(harness, task.id, 2);
    expect(second.prompt).toContain("1. smaller");
    expect(working(harness, task.id)).toContain(PIPELINE_COPY.replanning);
    await harness.answer(task.id, second.requestId, { text: "still too big" });

    const third = await question(harness, task.id, 3);
    expect(third.prompt).toContain("2. still too big");
    await harness.answer(task.id, third.requestId, {
      optionId: "approve",
      text: "go"
    });

    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toContain("plan A");
    expect(terminals(harness, task.id)).toHaveLength(1);
  });

  it("stops at the plan when it is rejected, and builds nothing", async () => {
    const { harness, turns } = setup("reject");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("echo:the findings");
    await using instance = await introspectWorkflowInstance(
      testEnv.TEST_CLAUDE_CODER_TASK,
      task.id
    );
    const plan = await question(harness, task.id);
    expect(plan.prompt).toContain("the findings");
    await harness.answer(task.id, plan.requestId, { optionId: "reject" });

    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toBe(PIPELINE_COPY.stopped);
    await instance.waitForStatus("complete");
    const output = (await instance.getOutput()) as TaskResult;
    expect(output.verdict.outcome).toBe("rejected");
    expect(output.verdict.steps.slice(1)).toEqual(["approve:0"]);
    expect((await turns()).map((t) => t.role)).not.toContain("code");
    expect(terminals(harness, task.id)).toHaveLength(1);
  });

  it("plans through a reading session that runs in the background", async () => {
    const { harness } = setup("read");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("delegate:sleep:1");
    const plan = await question(harness, task.id);
    expect(plan.prompt).toContain("child did: sleep:1");
    await harness.answer(task.id, plan.requestId, { optionId: "approve" });
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
  });

  it("runs a failed step once more, briefed as a retry", async () => {
    const { harness } = setup("retry");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("echo:flaky");
    await using instance = await introspectWorkflowInstance(
      testEnv.TEST_CLAUDE_CODER_TASK,
      task.id
    );
    const plan = await question(harness, task.id);
    await harness.answer(task.id, plan.requestId, { optionId: "approve" });

    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toBe("recovered");
    await instance.waitForStatus("complete");
    const output = (await instance.getOutput()) as TaskResult;
    expect(output.verdict.steps.slice(1)).toEqual([
      "approve:0",
      "code",
      "code:retry"
    ]);
    await pause(300);
    expect(terminals(harness, task.id)).toHaveLength(1);
  });

  it("relays a question the code step asks, and finishes on its answer", async () => {
    const { harness } = setup("ask");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("echo:ask:which one?");
    const plan = await question(harness, task.id, 1);
    await harness.answer(task.id, plan.requestId, { optionId: "approve" });
    const asked = await question(harness, task.id, 2);
    expect(asked.prompt).toBe("which one?");
    await harness.answer(task.id, asked.requestId, { optionId: "option_1" });
    const done = await harness.waitForTerminal(task.id);
    expect(done.text).toBe("Yes");
  });
});

describe("the plan reads and writes nothing", () => {
  /**
   * The real ClaudeCoder's tools, less a plan's: exact, like cf-coder's surface
   * spec, so a writer that appears later fails here rather than in a plan.
   */
  it("keeps only reading tools, and the reading session", async () => {
    const names = await runInDurableObject(
      testEnv.ClaudeCoder.get(
        testEnv.ClaudeCoder.idFromName(`surface:${crypto.randomUUID()}`)
      ),
      (instance) => {
        const think = [
          "read",
          "write",
          "edit",
          "delete",
          "list",
          "find",
          "grep"
        ];
        return [
          ...new Set([
            ...think,
            ...Object.keys(
              (instance as unknown as { getTools(): object }).getTools()
            )
          ])
        ];
      }
    );
    const plan = activeToolsFor("plan", names).sort();
    expect(plan).toEqual(
      [...PLAN_TOOLS].filter((name) => names.includes(name)).sort()
    );
    for (const writer of [
      "write",
      "edit",
      "delete",
      "claude_code",
      "repo_commit",
      "repo_push",
      "repo_open_pr",
      "scratch_open",
      "check_back"
    ]) {
      expect(plan).not.toContain(writer);
    }
    expect(plan).toContain("claude_code_read");
    expect(activeToolsFor("code", names)).toContain("claude_code");
  });

  it("gives each turn the tools its job's role allows", async () => {
    const { harness, turns } = setup("roles");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("echo:the plan");
    const plan = await question(harness, task.id);
    await harness.answer(task.id, plan.requestId, { optionId: "approve" });
    await harness.waitForTerminal(task.id);
    const seen = await turns();
    const planTurn = seen.find((t) => t.role === "plan");
    const codeTurn = seen.find((t) => t.role === "code");
    expect(planTurn?.active).not.toContain("claude_code");
    expect(planTurn?.active).toContain("claude_code_read");
    expect(codeTurn?.active).toContain("claude_code");
  });
});

describe("stopping", () => {
  it("cancels while the plan is being read: no callback, the instance ends", async () => {
    const { harness } = setup("cancel-plan");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("delegate:sleep:30");
    await harness.waitForState(task.id, "TASK_STATE_WORKING");
    await cancel(harness, task.id);
    await until(
      "terminated",
      () => status(task.id),
      (s) => s.status === "terminated"
    );
    await pause(300);
    expect(terminals(harness, task.id)).toHaveLength(0);
  });

  it("cancels at the approval", async () => {
    const { harness } = setup("cancel-approval");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("echo:a plan");
    await question(harness, task.id);
    await cancel(harness, task.id);
    await until(
      "terminated",
      () => status(task.id),
      (s) => s.status === "terminated"
    );
    expect(terminals(harness, task.id)).toHaveLength(0);
  });

  it("cancels while the work is being written", async () => {
    const { harness } = setup("cancel-code");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("echo:delegate:sleep:30");
    const plan = await question(harness, task.id);
    await harness.answer(task.id, plan.requestId, { optionId: "approve" });
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

  it("fails the task in its words when the approval expires", async () => {
    const { harness } = setup("expire");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("echo:a plan");
    const plan = await question(harness, task.id);
    await harness.timeout(task.id, plan.requestId);
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_FAILED");
    expect(done.text).toBe(copy.questionExpired);
    await until(
      "terminated",
      () => status(task.id),
      (s) => s.status === "terminated"
    );
  });
});

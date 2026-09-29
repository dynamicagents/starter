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
import worker, { type TestEnv } from "./worker";

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

/** `anthropic-coding`'s tasks are a pipeline: `./anthropic-coding-pipeline.spec.ts`. */
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

function questionOf(callback: CapturedCallback): HitlRequestData {
  const body = callback.body as {
    task?: { status?: { message?: { parts?: { data?: unknown }[] } } };
  };
  for (const part of body.task?.status?.message?.parts ?? []) {
    const data = part.data as HitlRequestData | undefined;
    if (data?.requestId) return data;
  }
  throw new Error("the input-required callback carried no question");
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
    const [parked] = await harness.waitForState(
      accepted.id,
      "TASK_STATE_INPUT_REQUIRED"
    );
    const question = questionOf(parked!);
    expect(question.prompt).toBe("which one?");

    await harness.answer(accepted.id, question.requestId, {
      optionId: question.options![0]!.id
    });
    const done = await harness.waitForTerminal(accepted.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(terminals(harness, accepted.id)).toHaveLength(1);
  });

  it("cancels a turn that is still running, and never calls back as done", async () => {
    const harness = harnessFor(tenant, "cancel");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("wait:20");
    await pause(1_500);
    await cancel(harness, tenant, accepted.id);
    await pause(1_500);

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

import type { ThinkModel } from "@cloudflare/think";
import type { SubAgentSpec } from "@dynamicagents/core";
import { handleArtifactRoute } from "@dynamicagents/core/artifacts";
import type { SubAgentClass } from "@dynamicagents/core/subagent";
import {
  call,
  scriptedModel,
  type MockStep,
  type ModelTurnView
} from "@dynamicagents/core/testing";
import { createA2AWorker, defineAgent } from "@dynamicagents/core/worker";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { hostManifest } from "@/host-manifest";
import { Reactive } from "@/agents/reactive/agent";
import { ReactiveGeneral } from "@/agents/reactive/children";
import { manifest as reactiveManifest } from "@/agents/reactive/manifest";
import { CfCoder } from "@/agents/cf-coder/agent";
import { CfCoderCode } from "@/agents/cf-coder/children";
import { manifest as cfCoderManifest } from "@/agents/cf-coder/manifest";
import { ClaudeCoder } from "@/agents/claude-coder/agent";
import { ClaudeCoderSession } from "@/agents/claude-coder/children";
import { manifest as claudeCoderManifest } from "@/agents/claude-coder/manifest";

/**
 * The Worker the suite runs: this deployment's own, plus each agent on a
 * scripted model.
 *
 * Workers AI has no local mode, so an agent's real `getModel()` cannot finish a
 * turn here. Each `Test*` class below is the real agent with only its model
 * swapped — and its sub-agents' — mounted under the real tenant, so a spec drives
 * the agent's actual plugins, souls and lifecycle through core's A2A edge. The
 * classes are bound for tests only, in `vitest.config.ts`.
 */

export * from "@/index";

export interface TestEnv extends Env {
  TEST_REACTIVE: DurableObjectNamespace<TestReactive>;
  TEST_CF_CODER: DurableObjectNamespace<TestCfCoder>;
  TEST_CLAUDE_CODER: DurableObjectNamespace<TestClaudeCoder>;
}

function after(text: string, prefix: string): string | undefined {
  return text.startsWith(prefix) ? text.slice(prefix.length) : undefined;
}

/** The text of the most recent tool result, as the model was shown it. */
function lastToolOutput(view: ModelTurnView): string {
  for (let i = view.prompt.length - 1; i >= 0; i--) {
    const message = view.prompt[i]!;
    if (message.role !== "tool") continue;
    const part = message.content.find((p) => p.type === "tool-result") as
      { output?: { value: unknown } } | undefined;
    const value = part?.output?.value;
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  return "";
}

/**
 * A parent's script, keyed on the message that started the turn. Anything it
 * does not claim is echoed, which is how a follow-up turn answers: a finished
 * background run arrives as an ordinary user message.
 */
function parentRule(subAgentTool: string) {
  return (view: ModelTurnView): MockStep => {
    const text = view.lastUserText;
    if (text === "boom") return { error: "told to fail" };
    const ask = after(text, "ask:");
    if (ask !== undefined) {
      return view.answered
        ? { text: "asked" }
        : call("ask_user", { question: ask, options: ["Yes", "No"] });
    }
    const wait = after(text, "wait:");
    if (wait !== undefined) {
      return view.answered
        ? { text: `waited ${wait}` }
        : call("test_wait", { seconds: Number(wait) });
    }
    const delegate = after(text, "delegate:");
    if (delegate !== undefined) {
      return view.answered
        ? { text: lastToolOutput(view) }
        : call(subAgentTool, { task: delegate }, "Delegating.");
    }
    return { text: after(text, "echo:") ?? text };
  };
}

/** A sub-agent's script: `sleep:N` sleeps in a tool, narrating first. */
function childRule(view: ModelTurnView): MockStep {
  const text = view.lastUserText;
  if (text === "fail") return { error: "child told to fail" };
  const sleep = after(text, "sleep:");
  if (sleep !== undefined) {
    return view.answered
      ? { text: `child did: ${text}` }
      : call("child_sleep", { seconds: Number(sleep) }, `working on ${text}`);
  }
  return { text: `child did: ${text}` };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

/** A tool that waits in the turn, for a spec that cancels one mid-flight. */
const sleepTool = (name: string) =>
  tool({
    description: `Wait (${name}).`,
    inputSchema: z.object({ seconds: z.number().min(0) }),
    execute: async ({ seconds }, { abortSignal }) => {
      await sleep(seconds * 1000, abortSignal);
      return { slept: seconds };
    }
  });

// --- reactive -----------------------------------------------------------------

export class TestReactiveGeneral extends ReactiveGeneral {
  static override spec = ReactiveGeneral.spec;
  override getModel(): ThinkModel {
    return scriptedModel(childRule);
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), child_sleep: sleepTool("child") };
  }
}

export class TestReactive extends Reactive {
  override getModel(): ThinkModel {
    return scriptedModel(parentRule("general"));
  }
  override getSubAgents(): SubAgentClass[] {
    return [TestReactiveGeneral];
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), test_wait: sleepTool("parent") };
  }
}

// --- cf-coder -----------------------------------------------------------------

export class TestCfCoderCode extends CfCoderCode {
  static override spec = CfCoderCode.spec;
  override getModel(): ThinkModel {
    return scriptedModel(childRule);
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), child_sleep: sleepTool("child") };
  }
}

export class TestCfCoder extends CfCoder {
  override getModel(): ThinkModel {
    return scriptedModel(parentRule("code"));
  }
  override getSubAgents(): SubAgentClass[] {
    return [TestCfCoderCode];
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), test_wait: sleepTool("parent") };
  }
}

// --- claude-coder -------------------------------------------------------------

/**
 * The writer's spec with a workspace nobody has to clone: the real `prepare`
 * needs a checkout in a container, which the suite never starts. Its `settle`
 * is the real one, and finds no worktree to release.
 */
const SESSION_SPEC = {
  ...ClaudeCoderSession.spec,
  prepare: async () => ({
    workspaceName: "test-workspace",
    dir: "/workspace/t"
  })
} as SubAgentSpec<never, never>;

export class TestClaudeCoderSession extends ClaudeCoderSession {
  static override spec = SESSION_SPEC;
  override getModel(): ThinkModel {
    return scriptedModel(childRule);
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), child_sleep: sleepTool("child") };
  }
}

export class TestClaudeCoder extends ClaudeCoder {
  override getModel(): ThinkModel {
    return scriptedModel(parentRule("claude_code"));
  }
  override getSubAgents(): SubAgentClass[] {
    return [TestClaudeCoderSession];
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), test_wait: sleepTool("parent") };
  }
}

// --- the Worker ---------------------------------------------------------------

const a2a = createA2AWorker<TestEnv>({
  manifest: hostManifest,
  agents: [
    defineAgent({
      tenant: "reactive",
      manifest: reactiveManifest,
      agent: (env: TestEnv) => env.TEST_REACTIVE
    }),
    defineAgent({
      tenant: "cf-coder",
      manifest: cfCoderManifest,
      agent: (env: TestEnv) => env.TEST_CF_CODER
    }),
    defineAgent({
      tenant: "claude-coder",
      manifest: claudeCoderManifest,
      agent: (env: TestEnv) => env.TEST_CLAUDE_CODER
    })
  ]
});

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    return (await handleArtifactRoute(request, env)) ?? a2a(request, env);
  }
} satisfies ExportedHandler<TestEnv>;

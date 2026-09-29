import type { ThinkModel, TurnConfig, TurnContext } from "@cloudflare/think";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { SubAgentSpec } from "@dynamicagents/core";
import { handleArtifactRoute } from "@dynamicagents/core/artifacts";
import type { SubAgentClass } from "@dynamicagents/core/subagent";
import type { TaskParams } from "@dynamicagents/core/workflow";
import {
  call,
  scriptedModel,
  type MockStep,
  type ModelTurnView
} from "@dynamicagents/core/testing";
import { createA2AWorker, defineAgent } from "@dynamicagents/core/worker";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { RETRY_BRIEF } from "@/copy";
import { hostManifest } from "@/host-manifest";
import { GenericAgent } from "@/agents/generic/agent";
import { GenericChild } from "@/agents/generic/children";
import { GenericHost } from "@/agents/generic/host";
import { manifest as genericManifest } from "@/agents/generic/manifest";
import { GenericWorkflow } from "@/agents/generic/workflow";
import { CodingAgent } from "@/agents/coding/agent";
import { CodingChild } from "@/agents/coding/children";
import { CodingHost } from "@/agents/coding/host";
import { manifest as codingManifest } from "@/agents/coding/manifest";
import { CodingWorkflow } from "@/agents/coding/workflow";
import { AnthropicCodingAgent } from "@/agents/anthropic-coding/agent";
import {
  AnthropicCodingReaderChild,
  AnthropicCodingWriterChild
} from "@/agents/anthropic-coding/children";
import { AnthropicCodingHost } from "@/agents/anthropic-coding/host";
import { manifest as anthropicCodingManifest } from "@/agents/anthropic-coding/manifest";
import { RETRY_WORK, ROLE_BRIEFS } from "@/agents/anthropic-coding/soul";
import { AnthropicCodingWorkflow } from "@/agents/anthropic-coding/workflow";

/**
 * The Worker the suite runs: this deployment's own, plus each agent on a
 * scripted model.
 *
 * Workers AI has no local mode, so an agent's real `getModel()` cannot finish a
 * turn here. Each `Test*` class below is the real agent with only its model
 * swapped — and its sub-agents' — behind its tenant's real host and pipeline,
 * pointed at it, so a spec drives the agent's actual plugins, souls and
 * lifecycle through core's A2A edge. The classes are bound for tests only, in
 * `vitest.config.ts`.
 */

export * from "@/index";

export interface TestEnv extends Env {
  TEST_GENERIC_AGENT: DurableObjectNamespace<TestGenericAgent>;
  TEST_GENERIC_HOST: DurableObjectNamespace<TestGenericHost>;
  TEST_GENERIC_WORKFLOW: Workflow<TaskParams>;
  TEST_CODING_AGENT: DurableObjectNamespace<TestCodingAgent>;
  TEST_CODING_HOST: DurableObjectNamespace<TestCodingHost>;
  TEST_CODING_WORKFLOW: Workflow<TaskParams>;
  TEST_ANTHROPIC_CODING_AGENT: DurableObjectNamespace<TestAnthropicCodingAgent>;
  TEST_ANTHROPIC_CODING_HOST: DurableObjectNamespace<TestAnthropicCodingHost>;
  TEST_ANTHROPIC_CODING_WORKFLOW: Workflow<TaskParams>;
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

/** `text` less each of `briefs` that leads it, in order. */
function unbrief(text: string, briefs: readonly string[]): string {
  let rest = text;
  for (const brief of briefs) {
    if (rest.startsWith(brief)) rest = rest.slice(brief.length).trimStart();
  }
  return rest;
}

/**
 * A parent's script, keyed on the message that started the turn, less the
 * retry's brief and whatever else `scriptOf` strips. Anything it does not claim
 * is echoed, which is how a follow-up turn answers: a finished background run
 * arrives as an ordinary user message.
 */
function parentRule(
  subAgentTool: string,
  scriptOf: (text: string) => string = (text) => text
) {
  return (view: ModelTurnView): MockStep => {
    const retry = view.lastUserText.startsWith(RETRY_BRIEF);
    const text = scriptOf(unbrief(view.lastUserText, [RETRY_BRIEF]));
    if (text === "boom") return { error: "told to fail" };
    // Fails a job's first attempt only: its retry is known by the brief.
    if (text === "flaky") {
      return retry ? { text: "recovered" } : { error: "told to fail once" };
    }
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

// --- generic -----------------------------------------------------------------

export class TestGenericChild extends GenericChild {
  static override spec = GenericChild.spec;
  override getModel(): ThinkModel {
    return scriptedModel(childRule);
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), child_sleep: sleepTool("child") };
  }
}

/** generic's host, pointed at the scripted pipeline. */
export class TestGenericHost extends GenericHost {
  protected override readonly workflowBinding = "TEST_GENERIC_WORKFLOW";
  protected override readonly hostBinding = "TEST_GENERIC_HOST";
}

/** generic's pipeline, on the scripted agent. It declares `run()`, as every pipeline must. */
export class TestGenericWorkflow extends GenericWorkflow {
  protected override readonly generic = "TEST_GENERIC_AGENT";
  override run(event: WorkflowEvent<TaskParams>, step: WorkflowStep) {
    return super.run(event, step);
  }
}

export class TestGenericAgent extends GenericAgent {
  override getModel(): ThinkModel {
    return scriptedModel(parentRule("general"));
  }
  override getSubAgents(): SubAgentClass[] {
    return [TestGenericChild];
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), test_wait: sleepTool("parent") };
  }
}

// --- coding -----------------------------------------------------------------

export class TestCodingChild extends CodingChild {
  static override spec = CodingChild.spec;
  override getModel(): ThinkModel {
    return scriptedModel(childRule);
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), child_sleep: sleepTool("child") };
  }
}

/** `coding`'s host, pointed at the scripted pipeline. */
export class TestCodingHost extends CodingHost {
  protected override readonly workflowBinding = "TEST_CODING_WORKFLOW";
  protected override readonly hostBinding = "TEST_CODING_HOST";
}

/** `coding`'s pipeline, on the scripted agent. */
export class TestCodingWorkflow extends CodingWorkflow {
  protected override readonly coder = "TEST_CODING_AGENT";
  override run(event: WorkflowEvent<TaskParams>, step: WorkflowStep) {
    return super.run(event, step);
  }
}

export class TestCodingAgent extends CodingAgent {
  override getModel(): ThinkModel {
    return scriptedModel(parentRule("code"));
  }
  override getSubAgents(): SubAgentClass[] {
    return [TestCodingChild];
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), test_wait: sleepTool("parent") };
  }
}

// --- anthropic-coding -------------------------------------------------------------

/**
 * The writer's spec with a workspace nobody has to clone: the real `prepare`
 * needs a checkout in a container, which the suite never starts. Its `settle`
 * is the real one, and finds no worktree to release.
 */
const SESSION_SPEC = {
  ...AnthropicCodingWriterChild.spec,
  prepare: async () => ({
    workspaceName: "test-workspace",
    dir: "/workspace/t"
  })
} as SubAgentSpec<never, never>;

export class TestAnthropicCodingWriterChild extends AnthropicCodingWriterChild {
  static override spec = SESSION_SPEC;
  override getModel(): ThinkModel {
    return scriptedModel(childRule);
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), child_sleep: sleepTool("child") };
  }
}

/** The reader's spec, with the same stand-in workspace as the writer's. */
const READER_SPEC = {
  ...AnthropicCodingReaderChild.spec,
  prepare: async () => ({
    workspaceName: "test-workspace",
    dir: "/workspace/t"
  }),
  settle: async () => {}
} as SubAgentSpec<never, never>;

export class TestAnthropicCodingReaderChild extends AnthropicCodingReaderChild {
  static override spec = READER_SPEC;
  override getModel(): ThinkModel {
    return scriptedModel(childRule);
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), child_sleep: sleepTool("child") };
  }
}

/**
 * What a job's first message scripts, less what AnthropicCodingAgent adds and the
 * pipeline frames: where a retry's work is, and the role's brief, in front;
 * and for the code step, the approved plan is the script.
 */
function anthropicCodingScript(text: string): string {
  const script = unbrief(text, [RETRY_WORK, ...Object.values(ROLE_BRIEFS)]);
  const plan =
    /^The approved plan:\n\n([\s\S]*?)\n\nThe original request:/.exec(script);
  return plan ? plan[1]! : script;
}

export class TestAnthropicCodingAgent extends AnthropicCodingAgent {
  override getModel(): ThinkModel {
    return scriptedModel((view) =>
      parentRule(
        this.turnStepJob()?.role === "plan"
          ? "claude_code_read"
          : "claude_code",
        anthropicCodingScript
      )(view)
    );
  }
  override getSubAgents(): SubAgentClass[] {
    return [TestAnthropicCodingWriterChild, TestAnthropicCodingReaderChild];
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), test_wait: sleepTool("parent") };
  }

  /** Every turn's role and active tools, durably, for the surface spec. */
  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    const config = await super.beforeTurn(ctx);
    this.sql`CREATE TABLE IF NOT EXISTS test_turns (role TEXT, active TEXT)`;
    this.sql`INSERT INTO test_turns VALUES (${this.turnStepJob()?.role ?? null},
      ${JSON.stringify(config?.activeTools ?? null)})`;
    return config;
  }

  async debugTurns(): Promise<string> {
    this.sql`CREATE TABLE IF NOT EXISTS test_turns (role TEXT, active TEXT)`;
    return JSON.stringify(
      this.sql<{ role: string | null; active: string }>`
        SELECT role, active FROM test_turns`.map((r) => ({
        role: r.role,
        active: JSON.parse(r.active) as string[] | null
      }))
    );
  }
}

/** `anthropic-coding`'s host, pointed at the scripted pipeline. */
export class TestAnthropicCodingHost extends AnthropicCodingHost {
  protected override readonly workflowBinding =
    "TEST_ANTHROPIC_CODING_WORKFLOW";
  protected override readonly hostBinding = "TEST_ANTHROPIC_CODING_HOST";
}

/** `anthropic-coding`'s pipeline, on the scripted agent. */
export class TestAnthropicCodingWorkflow extends AnthropicCodingWorkflow {
  protected override readonly coder = "TEST_ANTHROPIC_CODING_AGENT";
  override run(event: WorkflowEvent<TaskParams>, step: WorkflowStep) {
    return super.run(event, step);
  }
}

// --- the Worker ---------------------------------------------------------------

const a2a = createA2AWorker<TestEnv>({
  manifest: hostManifest,
  agents: [
    defineAgent({
      tenant: "generic",
      manifest: genericManifest,
      agent: (env: TestEnv) => env.TEST_GENERIC_HOST
    }),
    defineAgent({
      tenant: "coding",
      manifest: codingManifest,
      agent: (env: TestEnv) => env.TEST_CODING_HOST
    }),
    defineAgent({
      tenant: "anthropic-coding",
      manifest: anthropicCodingManifest,
      agent: (env: TestEnv) => env.TEST_ANTHROPIC_CODING_HOST
    })
  ]
});

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    return (await handleArtifactRoute(request, env)) ?? a2a(request, env);
  }
} satisfies ExportedHandler<TestEnv>;

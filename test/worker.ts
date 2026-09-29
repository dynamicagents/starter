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
import { Generic } from "@/agents/generic/agent";
import { GenericGeneral } from "@/agents/generic/children";
import { GenericTasks } from "@/agents/generic/host";
import { manifest as genericManifest } from "@/agents/generic/manifest";
import { GenericTask } from "@/agents/generic/task";
import { CfCoder } from "@/agents/cf-coder/agent";
import { CfCoderCode } from "@/agents/cf-coder/children";
import { CfCoderTasks } from "@/agents/cf-coder/host";
import { manifest as cfCoderManifest } from "@/agents/cf-coder/manifest";
import { CfCoderTask } from "@/agents/cf-coder/task";
import { ClaudeCoder } from "@/agents/claude-coder/agent";
import {
  ClaudeCoderReader,
  ClaudeCoderSession
} from "@/agents/claude-coder/children";
import { ClaudeCoderTasks } from "@/agents/claude-coder/host";
import { manifest as claudeCoderManifest } from "@/agents/claude-coder/manifest";
import { RETRY_WORK, ROLE_BRIEFS } from "@/agents/claude-coder/soul";
import { ClaudeCoderTask } from "@/agents/claude-coder/task";

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
  TEST_GENERIC: DurableObjectNamespace<TestGeneric>;
  TEST_GENERIC_TASKS: DurableObjectNamespace<TestGenericTasks>;
  TEST_GENERIC_TASK: Workflow<TaskParams>;
  TEST_CF_CODER: DurableObjectNamespace<TestCfCoder>;
  TEST_CF_CODER_TASKS: DurableObjectNamespace<TestCfCoderTasks>;
  TEST_CF_CODER_TASK: Workflow<TaskParams>;
  TEST_CLAUDE_CODER: DurableObjectNamespace<TestClaudeCoder>;
  TEST_CLAUDE_CODER_TASKS: DurableObjectNamespace<TestClaudeCoderTasks>;
  TEST_CLAUDE_CODER_TASK: Workflow<TaskParams>;
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

export class TestGenericGeneral extends GenericGeneral {
  static override spec = GenericGeneral.spec;
  override getModel(): ThinkModel {
    return scriptedModel(childRule);
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), child_sleep: sleepTool("child") };
  }
}

/** generic's host, pointed at the scripted pipeline. */
export class TestGenericTasks extends GenericTasks {
  protected override readonly workflowBinding = "TEST_GENERIC_TASK";
  protected override readonly hostBinding = "TEST_GENERIC_TASKS";
}

/** generic's pipeline, on the scripted agent. It declares `run()`, as every pipeline must. */
export class TestGenericTask extends GenericTask {
  protected override readonly generic = "TEST_GENERIC";
  override run(event: WorkflowEvent<TaskParams>, step: WorkflowStep) {
    return super.run(event, step);
  }
}

export class TestGeneric extends Generic {
  override getModel(): ThinkModel {
    return scriptedModel(parentRule("general"));
  }
  override getSubAgents(): SubAgentClass[] {
    return [TestGenericGeneral];
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

/** cf-coder's host, pointed at the scripted pipeline. */
export class TestCfCoderTasks extends CfCoderTasks {
  protected override readonly workflowBinding = "TEST_CF_CODER_TASK";
  protected override readonly hostBinding = "TEST_CF_CODER_TASKS";
}

/** cf-coder's pipeline, on the scripted agent. */
export class TestCfCoderTask extends CfCoderTask {
  protected override readonly coder = "TEST_CF_CODER";
  override run(event: WorkflowEvent<TaskParams>, step: WorkflowStep) {
    return super.run(event, step);
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

/** The reader's spec, with the same stand-in workspace as the writer's. */
const READER_SPEC = {
  ...ClaudeCoderReader.spec,
  prepare: async () => ({
    workspaceName: "test-workspace",
    dir: "/workspace/t"
  }),
  settle: async () => {}
} as SubAgentSpec<never, never>;

export class TestClaudeCoderReader extends ClaudeCoderReader {
  static override spec = READER_SPEC;
  override getModel(): ThinkModel {
    return scriptedModel(childRule);
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), child_sleep: sleepTool("child") };
  }
}

/**
 * What a job's first message scripts, less what ClaudeCoder adds and the
 * pipeline frames: where a retry's work is, and the role's brief, in front;
 * and for the code step, the approved plan is the script.
 */
function claudeCoderScript(text: string): string {
  const script = unbrief(text, [RETRY_WORK, ...Object.values(ROLE_BRIEFS)]);
  const plan =
    /^The approved plan:\n\n([\s\S]*?)\n\nThe original request:/.exec(script);
  return plan ? plan[1]! : script;
}

export class TestClaudeCoder extends ClaudeCoder {
  override getModel(): ThinkModel {
    return scriptedModel((view) =>
      parentRule(
        this.turnStepJob()?.role === "plan"
          ? "claude_code_read"
          : "claude_code",
        claudeCoderScript
      )(view)
    );
  }
  override getSubAgents(): SubAgentClass[] {
    return [TestClaudeCoderSession, TestClaudeCoderReader];
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

/** claude-coder's host, pointed at the scripted pipeline. */
export class TestClaudeCoderTasks extends ClaudeCoderTasks {
  protected override readonly workflowBinding = "TEST_CLAUDE_CODER_TASK";
  protected override readonly hostBinding = "TEST_CLAUDE_CODER_TASKS";
}

/** claude-coder's pipeline, on the scripted agent. */
export class TestClaudeCoderTask extends ClaudeCoderTask {
  protected override readonly coder = "TEST_CLAUDE_CODER";
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
      agent: (env: TestEnv) => env.TEST_GENERIC_TASKS
    }),
    defineAgent({
      tenant: "cf-coder",
      manifest: cfCoderManifest,
      agent: (env: TestEnv) => env.TEST_CF_CODER_TASKS
    }),
    defineAgent({
      tenant: "claude-coder",
      manifest: claudeCoderManifest,
      agent: (env: TestEnv) => env.TEST_CLAUDE_CODER_TASKS
    })
  ]
});

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    return (await handleArtifactRoute(request, env)) ?? a2a(request, env);
  }
} satisfies ExportedHandler<TestEnv>;

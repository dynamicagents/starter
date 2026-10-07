import type { ThinkModel } from "@cloudflare/think";
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
import { ClaudeCoordinatorAgent } from "@/agents/claude-coordinator/agent";
import {
  ClaudeCoordinatorPlannerChild,
  ClaudeCoordinatorWriterChild
} from "@/agents/claude-coordinator/children";
import { ClaudeCoordinatorHost } from "@/agents/claude-coordinator/host";
import { manifest as claudeCoordinatorManifest } from "@/agents/claude-coordinator/manifest";
import { createPlan } from "@/agents/claude-coordinator/plans";
import { RETRY_WORK } from "@/agents/claude-coordinator/soul";
import { ClaudeCoordinatorWorkflow } from "@/agents/claude-coordinator/workflow";

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
  TEST_CLAUDE_COORDINATOR_AGENT: DurableObjectNamespace<TestClaudeCoordinatorAgent>;
  TEST_CLAUDE_COORDINATOR_HOST: DurableObjectNamespace<TestClaudeCoordinatorHost>;
  TEST_CLAUDE_COORDINATOR_WORKFLOW: Workflow<TaskParams>;
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
    // An approval of an artifact; its answer arrives as the next message, and
    // is echoed as the reply. A refused one fails the call, and the model echoes
    // the call's error instead.
    const artifact = after(text, "approve:");
    if (artifact !== undefined) {
      return view.answered
        ? { text: lastToolOutput(view) }
        : call("ask_user", { question: "Approve the plan?", artifact });
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

/**
 * One call of the wait tool below, as a spec watches it: a cancel spec has to
 * know the turn reached the wait, and that the wait is over before it can say a
 * late callback never came.
 */
export interface WaitCall {
  /** Which tool: a parent's `test_wait`, or a sub-agent's `child_sleep`. */
  tool: string;
  seconds: number;
  /** Set when the wait is over: aborted with the turn, or slept in full. */
  ended?: "aborted" | "slept";
}

/**
 * Every wait so far, in call order. The Durable Objects share this module with
 * the spec, which is also how `interceptGatekeeper`'s `fetch` stub catches their
 * callbacks.
 */
export const waits: WaitCall[] = [];

/** A tool that waits in the turn, for a spec that cancels one mid-flight. */
const sleepTool = (name: string) =>
  tool({
    description: `Wait (${name}).`,
    inputSchema: z.object({ seconds: z.number().min(0) }),
    execute: async ({ seconds }, { abortSignal }) => {
      const call: WaitCall = { tool: name, seconds };
      waits.push(call);
      try {
        await sleep(seconds * 1000, abortSignal);
      } catch (err) {
        call.ended = "aborted";
        throw err;
      }
      call.ended = "slept";
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

// --- claude-coordinator -------------------------------------------------------------

/**
 * The writer's spec with a workspace nobody has to clone: the real `prepare`
 * needs a checkout in a container, which the suite never starts. Its `settle`
 * is the real one, and finds no worktree to release.
 */
const SESSION_SPEC = {
  ...ClaudeCoordinatorWriterChild.spec,
  prepare: async () => ({
    workspaceName: "test-workspace",
    dir: "/workspace/t"
  })
} as SubAgentSpec<never, never>;

export class TestClaudeCoordinatorWriterChild extends ClaudeCoordinatorWriterChild {
  static override spec = SESSION_SPEC;
  override getModel(): ThinkModel {
    return scriptedModel(childRule);
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), child_sleep: sleepTool("child") };
  }
}

/**
 * The planner's spec with a reduced `prepare`: it opens a plan, or takes the one
 * named, and hands over the stand-in workspace in place of a worktree. It
 * does not check ownership or the lock, which `preparePlanner` does and
 * `claude-coordinator.spec.ts` covers. `settle` is the real one.
 */
const PLANNER_SPEC = {
  ...ClaudeCoordinatorPlannerChild.spec,
  prepare: async (ctx: {
    input: { plan?: string };
    parent: { env: Env; storage: DurableObjectStorage };
  }) => {
    const id =
      ctx.input.plan ?? (await createPlan(ctx.parent.env, ctx.parent.storage));
    return {
      workspaceName: "test-workspace",
      dir: "/workspace/t",
      plan: { id, isNew: ctx.input.plan === undefined }
    };
  }
} as SubAgentSpec<never, never>;

export class TestClaudeCoordinatorPlannerChild extends ClaudeCoordinatorPlannerChild {
  static override spec = PLANNER_SPEC;
  override getModel(): ThinkModel {
    return scriptedModel(childRule);
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), child_sleep: sleepTool("child") };
  }
}

/** What a job's first message scripts, less where a retry's work is. */
function claudeCoordinatorScript(text: string): string {
  return unbrief(text, [RETRY_WORK]);
}

/**
 * The real agent on a scripted model. `delegate:` starts a writing session and
 * `plan:` a planning one; `approve:<id>` asks the caller to approve a plan.
 */
export class TestClaudeCoordinatorAgent extends ClaudeCoordinatorAgent {
  override getModel(): ThinkModel {
    return scriptedModel((view) => {
      const plan = after(
        unbrief(view.lastUserText, [RETRY_BRIEF, RETRY_WORK]),
        "plan:"
      );
      if (plan !== undefined) {
        return view.answered
          ? { text: lastToolOutput(view) }
          : call("claude_code_plan", { task: plan }, "Planning.");
      }
      return parentRule("claude_code", claudeCoordinatorScript)(view);
    });
  }
  override getSubAgents(): SubAgentClass[] {
    return [
      TestClaudeCoordinatorWriterChild,
      TestClaudeCoordinatorPlannerChild
    ];
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), test_wait: sleepTool("parent") };
  }

  /** Open a plan for this caller, as a planning session's `prepare` does. */
  async openPlan(): Promise<string> {
    return createPlan(this.env, this.ctx.storage);
  }
}

/** `claude-coordinator`'s host, pointed at the scripted pipeline. */
export class TestClaudeCoordinatorHost extends ClaudeCoordinatorHost {
  protected override readonly workflowBinding =
    "TEST_CLAUDE_COORDINATOR_WORKFLOW";
  protected override readonly hostBinding = "TEST_CLAUDE_COORDINATOR_HOST";
}

/** `claude-coordinator`'s pipeline, on the scripted agent. */
export class TestClaudeCoordinatorWorkflow extends ClaudeCoordinatorWorkflow {
  protected override readonly coder = "TEST_CLAUDE_COORDINATOR_AGENT";
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
      tenant: "claude-coordinator",
      manifest: claudeCoordinatorManifest,
      agent: (env: TestEnv) => env.TEST_CLAUDE_COORDINATOR_HOST
    })
  ]
});

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    return (await handleArtifactRoute(request, env)) ?? a2a(request, env);
  }
} satisfies ExportedHandler<TestEnv>;

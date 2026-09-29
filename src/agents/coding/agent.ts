import type {
  ThinkModel,
  ThinkScheduledTasks,
  TurnConfig,
  TurnContext
} from "@cloudflare/think";
import type { AgentPlugin } from "@dynamicagents/core";
import { StepAgent } from "@dynamicagents/core/agent";
import type { SubAgentClass } from "@dynamicagents/core/subagent";
import type { StepJob } from "@dynamicagents/core/workflow";
import { computerWorkspace } from "@dynamicagents/plugins/computer";
import { workspaceName } from "@dynamicagents/plugins/workspace";
import type { ContextConfig } from "agents/context";
import type { LanguageModel, ToolSet } from "ai";
import { CODING } from "@/config";
import { RETRY_BRIEF } from "@/copy";
import { agentModel } from "@/model";
import { activeRepo } from "@/workspace/active-repo";
import { WORKSPACE_WRITERS } from "@/workspace/container";
import { sweepIdleWorkspaces } from "@/workspace/lifecycle";
import { CodingChild } from "./children";
import { coding } from "./definition";
import { container, parentPlugins } from "./plugins";
import { MEMORY, SOUL } from "./soul";

/** This agent's log prefix and workspace label. */
const LABEL = "coding";

/**
 * The coding agent.
 *
 * A delegating agent like `generic`: the job, the turn and delegation are
 * `@dynamicagents/core/agent`, and the A2A task is `./host.ts`'s. What makes it
 * the odd one out is the container underneath — so the members below are mostly
 * lifecycle, not inference: a weekly reclaim sweep for workspaces nothing is
 * calling into, and a parent that can read the checkout but not change it.
 */
export class CodingAgent extends StepAgent<Env> {
  protected readonly compactAfterTokens = CODING.compactAfterTokens;
  protected readonly keepRecentTokens = CODING.keepRecentTokens;

  /**
   * Which repository the caller is working on. One instance for the object:
   * it caches what it last read, and the plugins and the workspace below must
   * agree on it.
   */
  readonly #active = activeRepo(this.ctx.storage);
  readonly #container = container(this.env, () =>
    workspaceName(this.callerKey(), this.#active.get())
  );

  /** Think's file tools, over the checkout rather than this object's SQLite. */
  override workspace = computerWorkspace(this.#container);
  /**
   * Off, because the parent has no shell: Think's own `bash` would run over the
   * same workspace and could write anything the file tools are kept from.
   */
  override workspaceBash = false as const;

  override getModel(): ThinkModel {
    return agentModel(
      this.env,
      { modelId: CODING.modelId, name: this.name },
      { agent: coding.tenant, taskId: this.turnTaskId(), phase: "turn" }
    );
  }

  /** Compaction runs over a history every task shares, so it has no task. */
  protected override compactionModel(): LanguageModel {
    return agentModel(
      this.env,
      { modelId: CODING.modelId, name: this.name },
      { agent: coding.tenant, phase: "compaction" }
    );
  }

  override configureContext(): ContextConfig[] {
    return [
      { label: "soul", provider: { get: async () => SOUL } },
      { label: "memory", description: MEMORY },
      ...super.configureContext()
    ];
  }

  override getPlugins(): AgentPlugin<Env>[] {
    return parentPlugins(this.env, this.#active, this.#container);
  }

  override getSubAgents(): SubAgentClass[] {
    return [CodingChild];
  }

  /** `check_back`, for the wait between opening a pull request and its review. */
  override getTools(): ToolSet {
    return { ...super.getTools(), check_back: this.checkBackTool() };
  }

  /**
   * The turn core configures, minus Think's own file writers. Core's own list
   * wins where it sets one: a turn for a job that has ended gets no tools.
   */
  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    const base = await super.beforeTurn(ctx);
    return {
      ...base,
      activeTools:
        base?.activeTools ??
        Object.keys(ctx.tools).filter((name) => !WORKSPACE_WRITERS.has(name))
    };
  }

  /** A retry is told so, and to carry on from what the first attempt left. */
  protected override formatStepJobInput(job: StepJob): string {
    return job.attempt > 1 ? `${RETRY_BRIEF}\n\n${job.input}` : job.input;
  }

  /**
   * The workspace reclaim sweep, beside core's own weekly cleanup and an hour
   * after it, so the two never contend for the same instance.
   *
   * A **backstop**, not the mechanism. Each workspace arms its own `idle-reclaim`
   * alarm on every use, and that is what normally fires. The body is in
   * `@/workspace/lifecycle.ts`, which carries the one case it covers.
   */
  override getScheduledTasks(): ThinkScheduledTasks {
    return {
      ...super.getScheduledTasks(),
      reclaimIdleWorkspaces: {
        schedule: "every week on sunday at 02:00 in UTC",
        handler: () =>
          sweepIdleWorkspaces({
            storage: this.ctx.storage,
            callerKey: this.callerKey(),
            binding: this.env.CODING_WORKSPACE,
            label: LABEL
          })
      }
    };
  }
}

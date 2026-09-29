import type { ThinkModel } from "@cloudflare/think";
import type { AgentPlugin } from "@dynamicagents/core";
import { StepAgent } from "@dynamicagents/core/agent";
import type { SubAgentClass } from "@dynamicagents/core/subagent";
import type { StepJob } from "@dynamicagents/core/workflow";
import type { ContextConfig } from "agents/context";
import type { LanguageModel } from "ai";
import { GENERIC } from "@/config";
import { RETRY_BRIEF } from "@/copy";
import { agentModel } from "@/model";
import { GenericChild } from "./children";
import { generic } from "./definition";
import { plugins } from "./plugins";
import { MEMORY, SOUL } from "./soul";

/**
 * The generic agent: the flagship.
 *
 * The job, the turn and delegation are `@dynamicagents/core/agent`, and the A2A
 * task is `./host.ts`'s. What is actually *this agent* is the members below plus
 * `./plugins.ts`, `./soul.ts` and `./children.ts` — and `../coding/agent.ts`
 * is the same members with different answers. If adding a domain to an agent
 * needed more than that, the plugin contract would be wrong.
 */
export class GenericAgent extends StepAgent<Env> {
  protected readonly compactAfterTokens = GENERIC.compactAfterTokens;
  protected readonly keepRecentTokens = GENERIC.keepRecentTokens;

  override getModel(): ThinkModel {
    return agentModel(
      this.env,
      { modelId: GENERIC.modelId, name: this.name },
      { agent: generic.tenant, taskId: this.turnTaskId(), phase: "turn" }
    );
  }

  /** Compaction runs over a history every task shares, so it has no task. */
  protected override compactionModel(): LanguageModel {
    return agentModel(
      this.env,
      { modelId: GENERIC.modelId, name: this.name },
      { agent: generic.tenant, phase: "compaction" }
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
    return plugins(this.env);
  }

  override getSubAgents(): SubAgentClass[] {
    return [GenericChild];
  }

  /** A retry is told so, and to carry on from what the first attempt left. */
  protected override formatStepJobInput(job: StepJob): string {
    return job.attempt > 1 ? `${RETRY_BRIEF}\n\n${job.input}` : job.input;
  }
}

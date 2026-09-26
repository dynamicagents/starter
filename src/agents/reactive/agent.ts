import type { ThinkModel } from "@cloudflare/think";
import type { AgentPlugin } from "@dynamicagents/core";
import { A2AAgent } from "@dynamicagents/core/agent";
import type { SubAgentClass } from "@dynamicagents/core/subagent";
import type { ContextConfig } from "agents/context";
import type { LanguageModel } from "ai";
import { REACTIVE } from "@/config";
import { copy } from "@/copy";
import { agentModel } from "@/model";
import { ReactiveGeneral } from "./children";
import { reactive } from "./definition";
import { plugins } from "./plugins";
import { MEMORY, SOUL } from "./soul";

/**
 * The reactive agent: the flagship.
 *
 * The A2A task, the turn and delegation are `@dynamicagents/core/agent`. What is
 * actually *this agent* is the members below plus `./plugins.ts`, `./soul.ts`
 * and `./children.ts` — and `../cf-coder/agent.ts` is the same members with
 * different answers. If adding a domain to an agent needed more than that, the
 * plugin contract would be wrong.
 */
export class Reactive extends A2AAgent<Env> {
  protected readonly copy = copy;
  protected readonly compactAfterTokens = REACTIVE.compactAfterTokens;
  protected readonly keepRecentTokens = REACTIVE.keepRecentTokens;

  override getModel(): ThinkModel {
    return agentModel(
      this.env,
      { modelId: REACTIVE.modelId, name: this.name },
      { agent: reactive.tenant, taskId: this.turnTaskId(), phase: "turn" }
    );
  }

  /** Compaction runs over a history every task shares, so it has no task. */
  protected override compactionModel(): LanguageModel {
    return agentModel(
      this.env,
      { modelId: REACTIVE.modelId, name: this.name },
      { agent: reactive.tenant, phase: "compaction" }
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
    return [ReactiveGeneral];
  }
}

import type { AgentPlugin, CoreConfigOverrides } from "@dynamicagents/core";
import type { PluginHost } from "@dynamicagents/core/host";
import {
  RoundAgentBase,
  type RoundPolicy,
  type SubagentClass
} from "@dynamicagents/core/round";
import { REACTIVE_CONFIG } from "@/config";
import { reactive } from "./definition";
import { roundPolicy } from "@/round-policy";
import { plugins } from "./plugins";
import { soulPrompt } from "./soul";
import { ReactiveSubagent } from "./subagent";

/**
 * The reactive agent: the flagship. Round loop, delegation, subagent execution.
 *
 * All of which is `@dynamicagents/core/round`. What is actually *this agent* is the
 * methods below plus `./plugins.ts` and `./soul.ts` — and
 * `../arc-player/agent.ts` is the same methods with different answers. If adding
 * a domain to an agent needed more than that, the plugin contract would be
 * wrong.
 */
export class ReactiveAgent extends RoundAgentBase<Env> {
  /**
   * `agentName` is what AI Gateway logs this agent's calls under. It is the
   * tenant, read off the definition, so the two cannot disagree — a config that
   * spreads a sibling's would otherwise carry the sibling's name. Every agent
   * and subagent here does the same.
   */
  protected agentConfig(): CoreConfigOverrides {
    return { ...REACTIVE_CONFIG, agentName: reactive.tenant };
  }

  protected agentPlugins(host: PluginHost<Env>): AgentPlugin[] {
    return plugins(host);
  }

  protected agentSoul(capabilities: string): string {
    return soulPrompt(capabilities);
  }

  /** The words the loop says. Core ships none — see `src/round-policy.ts`. */
  protected roundPolicy(): RoundPolicy {
    return roundPolicy;
  }

  protected subagentClass(): SubagentClass {
    return ReactiveSubagent;
  }
}

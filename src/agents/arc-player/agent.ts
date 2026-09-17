import type { AgentPlugin, CoreConfigOverrides } from "@dynamicagents/core";
import type { PluginHost } from "@dynamicagents/core/host";
import {
  RoundAgentBase,
  type RoundPolicy,
  type SubagentClass
} from "@dynamicagents/core/round";
import { makeScorecardStore } from "@dynamicagents/plugins/arc-agi";
import { ARC_PLAYER_CONFIG } from "@/config";
import { arcPlayer } from "./definition";
import { roundPolicy } from "@/round-policy";
import { plugins } from "./plugins";
import { soulPrompt } from "./soul";
import { ArcPlayerSubagent } from "./subagent";

/**
 * The arc-player: the same round loop as the reactive agent, a different soul, a
 * different plugin list. Nothing else.
 *
 * This is the example that tests whether the plugin contract is real. It reuses
 * `@dynamicagents/core/round` **unchanged** and adds a whole domain — a delegable
 * subtask type, a catalogue tool, a scorecard ledger, a leased external session —
 * by naming one plugin in `plugins.ts`. If it had needed a hook, a flag, or a
 * conditional anywhere in the shared code, the contract would be leaking.
 *
 * It is a separate Durable Object class because a wrangler binding maps to one
 * class and these need different configurations. That is the only reason.
 */
export class ArcPlayerAgent extends RoundAgentBase<Env> {
  protected agentConfig(): CoreConfigOverrides {
    return { ...ARC_PLAYER_CONFIG, agentName: arcPlayer.tenant };
  }

  protected agentPlugins(host: PluginHost<Env>): AgentPlugin[] {
    return plugins(host);
  }

  protected agentSoul(capabilities: string): string {
    return soulPrompt(capabilities);
  }

  protected roundPolicy(): RoundPolicy {
    return roundPolicy;
  }

  protected subagentClass(): SubagentClass {
    return ArcPlayerSubagent;
  }

  /**
   * Age out the scorecard ledger alongside core's task and subtask rows.
   *
   * The plugin owns the retention window and the sweep; it cannot own the
   * schedule, because a plugin cannot register a cron. This override is the
   * documented other half — `cleanupOldTasks` runs it weekly. Without it the
   * `arc_scorecards` rows accumulate for the life of the object.
   */
  protected override cleanupAgentState(): void {
    super.cleanupAgentState();
    makeScorecardStore(this.ctx.storage).cleanup();
  }
}

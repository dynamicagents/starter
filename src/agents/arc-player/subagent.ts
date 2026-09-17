import type { AgentPlugin, CoreConfigOverrides } from "@dynamicagents/core";
import type { PluginHost } from "@dynamicagents/core/host";
import { RecipeSubagentHost } from "@dynamicagents/core/round";
import { ARC_PLAYER_CONFIG } from "@/config";
import { arcPlayer } from "./definition";
import { plugins } from "./plugins";

/**
 * The arc-player's subagent facet — where a game is actually played.
 *
 * Its own class, and its own plugin list, so an execution here can reach the
 * `arc-game` tool family and the reactive agent's children cannot. The framework
 * resolves a facet by `this.constructor.name`, so this must stay a named, exported
 * class (and the bundler must keep class names — see `scripts/verify-isolation.mjs`).
 */
export class ArcPlayerSubagent extends RecipeSubagentHost<Env> {
  protected agentConfig(): CoreConfigOverrides {
    return { ...ARC_PLAYER_CONFIG, agentName: arcPlayer.tenant };
  }

  protected agentPlugins(host: PluginHost<Env>): AgentPlugin[] {
    return plugins(host);
  }
}

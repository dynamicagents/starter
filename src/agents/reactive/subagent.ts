import type { AgentPlugin, CoreConfigOverrides } from "@dynamicagents/core";
import type { PluginHost } from "@dynamicagents/core/host";
import { RecipeSubagentHost } from "@dynamicagents/core/round";
import { REACTIVE_CONFIG } from "@/config";
import { reactive } from "./definition";
import { plugins } from "./plugins";

/**
 * The reactive agent's subagent facet.
 *
 * Named, exported, and trivial by design: the framework resolves a facet by
 * `this.constructor.name`, and the only thing that distinguishes one agent's
 * children from another's is which plugins they can reach. Everything else is
 * `RecipeSubagentHost`.
 */
export class ReactiveSubagent extends RecipeSubagentHost<Env> {
  protected agentConfig(): CoreConfigOverrides {
    return { ...REACTIVE_CONFIG, agentName: reactive.tenant };
  }

  protected agentPlugins(host: PluginHost<Env>): AgentPlugin[] {
    return plugins(host);
  }
}

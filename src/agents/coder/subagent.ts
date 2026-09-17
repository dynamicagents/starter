import type { AgentPlugin, CoreConfigOverrides } from "@dynamicagents/core";
import type { PluginHost } from "@dynamicagents/core/host";
import { RecipeSubagentHost } from "@dynamicagents/core/round";
import { CODER_CONFIG } from "@/config";
import { coder } from "./definition";
import { subagentPlugins } from "./plugins";

/**
 * The coder agent's subagent facet.
 *
 * Named and exported by design: the framework resolves a facet by
 * `this.constructor.name`. It needs no wrangler binding — only the export from
 * `src/index.ts` — but it does need a test-only one; see `vitest.config.ts`.
 */
export class CoderSubagent extends RecipeSubagentHost<Env> {
  protected agentConfig(): CoreConfigOverrides {
    return { ...CODER_CONFIG, agentName: coder.tenant };
  }

  /**
   * The **subagent's** list, which is deliberately not its parent's.
   *
   * This is the half with hands: a full shell, a writer, an editor and a
   * browser — and no git, because the parent owns the history. The base class
   * documents its default as "the same plugins as its parent"; this agent is the
   * one that must not take it.
   */
  protected agentPlugins(host: PluginHost<Env>): AgentPlugin[] {
    return subagentPlugins(host);
  }

  // No `modelRuntime` override, in either this class or the parent. A facet must
  // resolve the same provider as the round that delegated to it — two overrides
  // both satisfy `ModelRuntime`, so a drifted pair would run every subtask on a
  // different model with nothing downstream able to tell. Both inheriting core's
  // default is the version of that guarantee with no second definition to drift.
  // `agentConfig` above carries the other half: it must return what the parent
  // returns, and does.
}

import type { ThinkModel } from "@cloudflare/think";
import type { AgentPlugin, SubAgentSpec } from "@dynamicagents/core";
import { SubAgent } from "@dynamicagents/core/subagent";
import { computerWorkspace } from "@dynamicagents/plugins/computer";
import { CODING } from "@/config";
import { agentModel, transientChatError, turnTask } from "@/model";
import { CODE } from "./code";
import { coding } from "./definition";
import { childPlugins, place } from "./plugins";

/**
 * The `code` sub-agent: the half with hands.
 *
 * It works in its parent's sandbox, whose name its spec's `prepare` resolves
 * on the parent and hands over as `runtime()`. A run that arrives without one is
 * a wiring fault, so the fallback refuses rather than naming a sandbox nobody
 * chose.
 */
export class CodingChild extends SubAgent<Env> {
  static override spec = CODE as SubAgentSpec<never, never>;

  readonly #place = place(this.env, () => {
    throw new Error(
      "coding: this run carries no sandbox name; the `code` spec's prepare supplies one"
    );
  });

  override workspace = computerWorkspace(this.#place, () =>
    this.pluginContext().runtime()
  );

  /**
   * A turn the platform cut is continued rather than failed. `src/model.ts`
   * holds the why, and what it costs.
   */
  override classifyChatError(error: unknown) {
    return transientChatError(error) ?? super.classifyChatError(error);
  }

  override getModel(): ThinkModel {
    return agentModel(
      this.env,
      { modelId: CODING.modelId, name: this.name },
      {
        agent: coding.tenant,
        taskId: turnTask(this.activeTurnMetadata),
        phase: "subagent",
        subAgent: "CodingChild"
      }
    );
  }

  override getPlugins(): AgentPlugin<Env>[] {
    return childPlugins(this.env);
  }
}

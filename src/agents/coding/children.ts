import type { ThinkModel } from "@cloudflare/think";
import type { AgentPlugin, SubAgentSpec } from "@dynamicagents/core";
import { SubAgent } from "@dynamicagents/core/subagent";
import { sandboxWorkspace } from "@dynamicagents/plugins/computer";
import { CODING } from "@/config";
import { agentModel, turnTask } from "@/model";
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

  override workspace = sandboxWorkspace(this.#place, () =>
    this.pluginContext().runtime()
  );

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

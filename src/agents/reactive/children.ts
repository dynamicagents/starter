import type { ThinkModel } from "@cloudflare/think";
import type { AgentPlugin, SubAgentSpec } from "@dynamicagents/core";
import { SubAgent } from "@dynamicagents/core/subagent";
import { z } from "zod";
import { REACTIVE } from "@/config";
import { agentModel, turnTask } from "@/model";
import { reactive } from "./definition";
import { plugins } from "./plugins";
import { GENERAL_SOUL } from "./soul";

/**
 * The catch-all: any self-contained unit of work with no domain of its own.
 *
 * **Awaited.** Research, drafting and reading a page finish in minutes, well
 * inside the fifteen minutes a turn can last, so the parent waits for the
 * result in the same turn rather than answering in a later one.
 */
const GENERAL: SubAgentSpec<{ task: string }> = {
  name: "general",
  description:
    "Hand a self-contained piece of work to a sub-agent and wait for its result: research, drafting, summarizing, reading a web page. It cannot see this conversation, so put everything it needs in the task.",
  inputSchema: z.object({
    task: z
      .string()
      .describe(
        "The work, with everything needed to do it: the sub-agent sees nothing else"
      )
  }),
  soul: GENERAL_SOUL,
  formatInput: (input) => input.task
};

export class ReactiveGeneral extends SubAgent<Env> {
  static override spec = GENERAL as SubAgentSpec<never, never>;

  override getModel(): ThinkModel {
    return agentModel(
      this.env,
      { modelId: REACTIVE.modelId, name: this.name },
      {
        agent: reactive.tenant,
        taskId: turnTask(this.activeTurnMetadata),
        phase: "subagent",
        subAgent: "ReactiveGeneral"
      }
    );
  }

  override getPlugins(): AgentPlugin<Env>[] {
    return plugins(this.env);
  }
}

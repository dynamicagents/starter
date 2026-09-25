import { Think, type ThinkModel } from "@cloudflare/think";
import type { ToolSet, UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { SpikeEnv } from "./env";
import { spikeFakeModel } from "./fake-model";
import { sleepTool } from "./tools";

/**
 * The sub-agent the parent dispatches, detached.
 *
 * It is an ordinary `Think` agent: agent tools give it its own Durable Object
 * storage, its own messages, its own recovery and its own resumable stream, and
 * the parent holds nothing but a run row. Nothing here knows about A2A — the
 * task lifecycle is the parent's.
 */
export class SpikeGeneral extends Think<SpikeEnv> {
  maxSteps = Infinity;
  chatRecovery = { maxRecoveryWork: Infinity };
  /** just-bash in a child that never shells out is dead weight in the bundle. */
  workspaceBash = false as const;

  getModel(): ThinkModel {
    return this.env.SPIKE_FAKE_MODEL
      ? spikeFakeModel()
      : createWorkersAI({ binding: this.env.AI })("@cf/zai-org/glm-4.6");
  }

  getSystemPrompt(): string {
    return "You are the spike's sub-agent. Do the job you are given and say what you did.";
  }

  override getTools(): ToolSet {
    return {
      spike_sleep: sleepTool(async ({ key, text }) => {
        await this.reportProgress(
          { milestone: "note", message: text, data: { key, text } },
          { persist: true }
        );
      })
    };
  }

  /**
   * The dispatch envelope, as the model reads it.
   *
   * Overridden because the default stringifies the whole input: the spike's
   * rules key on the task text, so the message carries that and nothing else.
   */
  protected override formatAgentToolInput(input: unknown): UIMessage {
    const task = (input as { task?: unknown })?.task;
    return {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: typeof task === "string" ? task : "" }]
    };
  }
}

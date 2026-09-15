import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { resolveConfig } from "@dynamicagents/core";
import {
  runHandleTask,
  type HandleTaskParams,
  type TaskVerdict
} from "@dynamicagents/core/round";
import { CLAUDE_CODER_CONFIG } from "@/config";
import { failureCopy, roundPolicy } from "@/round-policy";
import { claudeCoder } from "./definition";

/** The claude-coder agent's task workflow: core's orchestration, its own binding. */
export class ClaudeCoderWorkflow extends WorkflowEntrypoint<
  Env,
  HandleTaskParams
> {
  /**
   * No `catch` here — see `../coder/workflow.ts`. It matters more for this agent
   * than most: its rounds are long and its subtasks longer, so a step that keeps
   * failing burns its retries over a much wider wall-clock window and the
   * silence at the end is correspondingly more expensive to diagnose.
   */
  async run(
    event: Readonly<WorkflowEvent<HandleTaskParams>>,
    step: WorkflowStep
  ): Promise<TaskVerdict> {
    return await runHandleTask(event.payload, step, {
      resolveAgent: (identity) => claudeCoder.resolveAgent(this.env, identity),
      config: resolveConfig(CLAUDE_CODER_CONFIG),
      policy: roundPolicy,
      failureCopy,
      signingKey: this.env.A2A_SIGNING_KEY,
      label: "claude-coder"
    });
  }
}

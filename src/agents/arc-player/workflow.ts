import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { resolveConfig } from "@dynamicagents/core";
import {
  runHandleTask,
  type HandleTaskParams,
  type TaskVerdict
} from "@dynamicagents/core/round";
import { ARC_PLAYER_CONFIG } from "@/config";
import { failureCopy, roundPolicy } from "@/round-policy";
import { arcPlayer } from "./definition";

/**
 * The arc-player's task workflow: core's orchestration, its own binding.
 *
 * See `../reactive/workflow.ts` — the two are the same five lines with different
 * deps, which is the whole cost of a second round agent. Two classes exist because
 * a wrangler workflow binding names exactly one class and each agent's instances
 * must be its own.
 */
export class ArcHandleTaskWorkflow extends WorkflowEntrypoint<
  Env,
  HandleTaskParams
> {
  async run(
    event: Readonly<WorkflowEvent<HandleTaskParams>>,
    step: WorkflowStep
  ): Promise<TaskVerdict> {
    return await runHandleTask(event.payload, step, {
      resolveAgent: (identity) => arcPlayer.resolveAgent(this.env, identity),
      config: resolveConfig(ARC_PLAYER_CONFIG),
      policy: roundPolicy,
      failureCopy,
      signingKey: this.env.A2A_SIGNING_KEY,
      // Names this agent in core's abandoned-task log line, which is the only
      // record when a step exhausts its retries and the Task is failed for it.
      label: "arc-player"
    });
  }
}

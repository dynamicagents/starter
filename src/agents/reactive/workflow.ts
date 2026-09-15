import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { resolveConfig } from "@dynamicagents/core";
import {
  runHandleTask,
  type HandleTaskParams,
  type TaskVerdict
} from "@dynamicagents/core/round";
import { REACTIVE_CONFIG } from "@/config";
import { failureCopy, roundPolicy } from "@/round-policy";
import { reactive } from "./definition";

/**
 * The reactive agent's task workflow.
 *
 * A thin entrypoint over core's `runHandleTask` rather than a copy of it. Two
 * classes exist (this and `ArcHandleTaskWorkflow`) because a wrangler workflow
 * binding names exactly one class and each agent's instances must be its own; the
 * round loop, wave scheduling and delivery underneath are core's.
 *
 * `reactive.resolveAgent` is the same declaration `src/index.ts` mounts the tenant
 * with, so the workflow and the tenant can never address different Durable
 * Objects — the failure that used to type-check perfectly and surface as a task
 * that never called back.
 */
export class HandleTaskWorkflow extends WorkflowEntrypoint<
  Env,
  HandleTaskParams
> {
  async run(
    event: Readonly<WorkflowEvent<HandleTaskParams>>,
    step: WorkflowStep
  ): Promise<TaskVerdict> {
    return await runHandleTask(event.payload, step, {
      resolveAgent: (identity) => reactive.resolveAgent(this.env, identity),
      config: resolveConfig(REACTIVE_CONFIG),
      policy: roundPolicy,
      failureCopy,
      signingKey: this.env.A2A_SIGNING_KEY,
      // Names this agent in core's abandoned-task log line, which is the only
      // record when a step exhausts its retries and the Task is failed for it.
      label: "reactive"
    });
  }
}

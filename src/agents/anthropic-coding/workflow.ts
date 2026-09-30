import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
  TaskWorkflow,
  type PipelineResult,
  type TaskParams,
  type TaskStep
} from "@dynamicagents/core/workflow";

/**
 * `anthropic-coding`'s pipeline: one step, the whole task, on the caller's own
 * `AnthropicCodingAgent`.
 *
 * Planning and approving are the agent's tools, not steps here: whether a
 * change gets a plan, and whether the caller approves it before it is built, is
 * the agent's to judge and the caller's to set — see `./soul.ts`. A step every
 * task needs, whatever it asks, goes here.
 */
export class AnthropicCodingWorkflow extends TaskWorkflow<Env> {
  /** The step agent's binding. A test worker points it at a scripted one. */
  protected readonly coder: string = "AnthropicCodingAgent";

  override run(event: WorkflowEvent<TaskParams>, step: WorkflowStep) {
    return super.run(event, step);
  }

  protected async pipeline(
    event: WorkflowEvent<TaskParams>,
    step: TaskStep
  ): Promise<PipelineResult> {
    const reply = await step.agent("main", {
      agent: this.coder,
      input: event.payload.text
    });
    return { reply };
  }
}

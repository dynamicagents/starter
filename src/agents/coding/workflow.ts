import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
  TaskWorkflow,
  type PipelineResult,
  type TaskParams,
  type TaskStep
} from "@dynamicagents/core/workflow";

/**
 * `coding`'s pipeline: one step, the whole task, on the caller's own
 * `CodingAgent`. A step before it or after it — triage, a judge — goes here.
 */
export class CodingWorkflow extends TaskWorkflow<Env> {
  /** The step agent's binding. A test worker points it at a scripted one. */
  protected readonly coder: string = "CodingAgent";

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

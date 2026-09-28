import { TaskHost } from "@dynamicagents/core/task";
import { copy } from "@/copy";

/**
 * The reactive tenant's task host: it owns each A2A task, and `ReactiveTask`
 * (`./task.ts`) runs it. The mechanism is core's `/task`.
 */
export class ReactiveTasks extends TaskHost<Env> {
  protected readonly copy = copy;
  protected readonly workflowBinding: string = "REACTIVE_TASK";
  protected readonly hostBinding: string = "ReactiveTasks";
}

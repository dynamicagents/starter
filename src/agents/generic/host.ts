import { TaskHost } from "@dynamicagents/core/task";
import { copy } from "@/copy";

/**
 * The generic tenant's task host: it owns each A2A task, and `GenericTask`
 * (`./task.ts`) runs it. The mechanism is core's `/task`.
 */
export class GenericTasks extends TaskHost<Env> {
  protected readonly copy = copy;
  protected readonly workflowBinding: string = "GENERIC_TASK";
  protected readonly hostBinding: string = "GenericTasks";
}

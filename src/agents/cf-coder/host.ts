import { TaskHost } from "@dynamicagents/core/task";
import { copy } from "@/copy";

/**
 * The cf-coder tenant's task host: it owns each A2A task, and `CfCoderTask`
 * (`./task.ts`) runs it. The mechanism is core's `/task`.
 */
export class CfCoderTasks extends TaskHost<Env> {
  protected readonly copy = copy;
  protected readonly workflowBinding: string = "CF_CODER_TASK";
  protected readonly hostBinding: string = "CfCoderTasks";
}

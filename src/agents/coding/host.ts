import { TaskHost } from "@dynamicagents/core/task";
import { copy } from "@/copy";

/**
 * The coding tenant's task host: it owns each A2A task, and `CodingWorkflow`
 * (`./workflow.ts`) runs it. The mechanism is core's `/task`.
 */
export class CodingHost extends TaskHost<Env> {
  protected readonly copy = copy;
  protected readonly workflowBinding: string = "CODING_WORKFLOW";
  protected readonly hostBinding: string = "CodingHost";
}

import { TaskHost } from "@dynamicagents/core/task";
import { copy } from "@/copy";

/**
 * The generic tenant's task host: it owns each A2A task, and `GenericWorkflow`
 * (`./workflow.ts`) runs it. The mechanism is core's `/task`.
 */
export class GenericHost extends TaskHost<Env> {
  protected readonly copy = copy;
  protected readonly workflowBinding: string = "GENERIC_WORKFLOW";
  protected readonly hostBinding: string = "GenericHost";
}

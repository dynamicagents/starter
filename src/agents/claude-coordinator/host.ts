import { TaskHost } from "@dynamicagents/core/task";
import { copy } from "@/copy";

/**
 * The claude-coordinator tenant's task host: it owns each A2A task, and
 * `ClaudeCoordinatorWorkflow` (`./workflow.ts`) runs it. The mechanism is core's `/task`.
 */
export class ClaudeCoordinatorHost extends TaskHost<Env> {
  protected readonly copy = copy;
  protected readonly workflowBinding: string = "CLAUDE_COORDINATOR_WORKFLOW";
  protected readonly hostBinding: string = "ClaudeCoordinatorHost";
}

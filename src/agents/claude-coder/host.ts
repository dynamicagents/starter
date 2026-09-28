import { TaskHost } from "@dynamicagents/core/task";
import { copy } from "@/copy";

/**
 * The claude-coder tenant's task host: it owns each A2A task, and
 * `ClaudeCoderTask` (`./task.ts`) runs it. The mechanism is core's `/task`.
 */
export class ClaudeCoderTasks extends TaskHost<Env> {
  protected readonly copy = copy;
  protected readonly workflowBinding: string = "CLAUDE_CODER_TASK";
  protected readonly hostBinding: string = "ClaudeCoderTasks";
}

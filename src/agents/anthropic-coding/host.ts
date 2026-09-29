import { TaskHost } from "@dynamicagents/core/task";
import { copy } from "@/copy";

/**
 * The anthropic-coding tenant's task host: it owns each A2A task, and
 * `AnthropicCodingWorkflow` (`./workflow.ts`) runs it. The mechanism is core's `/task`.
 */
export class AnthropicCodingHost extends TaskHost<Env> {
  protected readonly copy = copy;
  protected readonly workflowBinding: string = "ANTHROPIC_CODING_WORKFLOW";
  protected readonly hostBinding: string = "AnthropicCodingHost";
}

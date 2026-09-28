import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
  HITL_APPROVE_OPTION_ID,
  HITL_REJECT_OPTION_ID
} from "@dynamicagents/g2a-protocol";
import {
  TaskWorkflow,
  type PipelineResult,
  type TaskParams,
  type TaskStep
} from "@dynamicagents/core/workflow";
import { PIPELINE_COPY } from "@/copy";

/**
 * claude-coder's pipeline: plan, then put the plan to the caller. Approved, it
 * is built. Answered in words, it is written again with them, for as long as
 * the caller keeps commenting. Rejected, the task stops at the plan — which
 * makes a question with no change behind it a plan the caller stops at. The
 * question's expiry or a cancel ends it otherwise.
 *
 * Both steps run on ClaudeCoder, the caller's own instance, so the plan and
 * the work share its checkout, its worktrees and its conversation. What a role
 * lets the agent do is the agent's: see `./roles.ts`.
 */
export class ClaudeCoderTask extends TaskWorkflow<Env> {
  /** The step agent's binding. A test worker points it at a scripted one. */
  protected readonly coder: string = "ClaudeCoder";

  override run(event: WorkflowEvent<TaskParams>, step: WorkflowStep) {
    return super.run(event, step);
  }

  protected async pipeline(
    event: WorkflowEvent<TaskParams>,
    step: TaskStep
  ): Promise<PipelineResult> {
    const request = event.payload.text;
    const comments: string[] = [];
    for (let n = 0; ; n++) {
      const plan = await step.agent("plan", {
        agent: this.coder,
        role: "plan",
        key: String(n),
        input: planInput(request, comments)
      });
      // The approval's own pair, and a typed answer beside it: the comment.
      const answer = await step.ask(`approve:${n}`, {
        kind: "approval",
        prompt: `${plan}\n\n${PIPELINE_COPY.approveHint}`,
        allowFreeform: true
      });
      if (answer.optionId === HITL_APPROVE_OPTION_ID) {
        const reply = await step.agent("code", {
          agent: this.coder,
          role: "code",
          input: codeInput(request, plan, answer.text)
        });
        return { reply };
      }
      if (answer.optionId === HITL_REJECT_OPTION_ID) {
        return { reply: PIPELINE_COPY.stopped, outcome: "rejected" };
      }
      comments.push(answer.text ?? PIPELINE_COPY.noComment);
      await step.say(PIPELINE_COPY.replanning);
    }
  }
}

/** The request, then each earlier plan's comment, oldest first. */
function planInput(request: string, comments: readonly string[]): string {
  if (comments.length === 0) return request;
  const replies = comments.map((reply, i) => `${i + 1}. ${reply}`).join("\n");
  return `${request}\n\nThe caller commented on the earlier plan${comments.length > 1 ? "s" : ""}:\n${replies}`;
}

/** The approved plan first, then what was asked, then anything said with the approval. */
function codeInput(request: string, plan: string, note?: string): string {
  return [
    `The approved plan:\n\n${plan}`,
    `The original request:\n\n${request}`,
    ...(note ? [`The caller added, approving it:\n\n${note}`] : [])
  ].join("\n\n");
}

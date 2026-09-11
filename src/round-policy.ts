import type { AgentLimits } from "@dynamicagents/core";
import {
  ASK_USER_TOOL_NAME,
  FINAL_REPLY_TOOL_NAME
} from "@dynamicagents/core/agent";
import { DELEGATE_TOOL_NAME } from "@dynamicagents/core/subtasks";
import type {
  ApprovalCall,
  FinalRoundReason,
  RoundPolicy,
  TaskFailureKind
} from "@dynamicagents/core/round";

/**
 * The words a round agent says — the one part of the round loop core does not
 * ship.
 *
 * `@dynamicagents/core/round` owns all the mechanism: the durable Subtask rows and
 * their concurrent fan-out, chunked subagent execution, cancellation ordering,
 * the primary→fallback→repair ladder.
 * It reads none of it out loud. Everything below is text a model or a user
 * actually sees, and core refuses to lend a default for any of it — the same
 * refusal `validateRecipe` makes about a subagent soul, and for the same reason:
 * no run should execute under an identity, or a contract, nobody chose.
 *
 * Shared by every round agent in this Worker, which is
 * why it sits at the top level rather than in one of their directories — an agent
 * importing a *sibling's* module is what `npm run verify:isolation` fails on.
 * There is nothing agent-specific here: the contract is about how a round ends,
 * and every one ends the same way. What each agent is told about its *domain* is
 * declared by the plugin that owns it (`SubtaskTypeSpec.delegationGuidance`) and
 * appended by core, so no domain is named in this file.
 */

/**
 * The round contract: how a round ends, and what `delegate` takes. True of every
 * request.
 */
export function roundContract(ctx: {
  typeKeys: readonly string[];
  maxSubtasks: number;
}): string {
  const { typeKeys, maxSubtasks } = ctx;
  return `

# Answering this request

You are replying to the user yourself. Two calls end this round with an outcome,
and the choice between them is yours:

**1. Answer directly.** Call the \`${FINAL_REPLY_TOOL_NAME}\` tool with your reply. Do
this whenever the request is yours to answer — anything about this conversation,
your own history, memory, or tools, and anything you can settle with the tools
available to you here. Use those tools first if they help: look something up,
recall older history, then answer.

**2. Delegate.** Call the \`${DELEGATE_TOOL_NAME}\` tool to hand work to isolated
subagents that run concurrently — research, long-running jobs, or anything better
done in parallel by a capable stranger. Their results come back to you, and you
then decide again: answer, or delegate once more.

Do not delegate work you can simply do. Do not answer from thin air work that
genuinely needs doing.

**Every round must end in a call.** Prose on its own does not reach
the user and does not start any work — if you decide to do something, make the call
that does it in the same turn rather than describing what you are about to do.

## Delegating

\`${DELEGATE_TOOL_NAME}\` takes:

- "reply": the acknowledgment the user sees while the work runs, in your own voice.
  Say what you are doing about their request. Do not promise a delivery time, and
  do not mention subtasks, subagents, or this process.
- "subtasks": between 1 and ${maxSubtasks} units of work. Use exactly as many as the
  request genuinely needs — one is the right answer for a simple request. Prefer
  fewer, larger subtasks over many trivial ones.

Each subtask has:

- "type": exactly one of ${typeKeys.map((k) => `"${k}"`).join(", ")}. These are
  the only accepted values — any other word is rejected and the whole call fails.
  See the tool description for what each type does and which params it needs.
- "prompt": a complete, self-contained instruction, and never blank. The subagent
  executing it has no memory, no conversation history, and no access to this
  session — everything it needs must be in this prompt or in the references you
  select. Write it as an instruction to a capable stranger.
- "referenceIndexes": the indexes of conversation turns the subagent must read
  verbatim, chosen from the turns marked "[ref N]" below. Reference only what that
  subtask actually needs. Turns without a "[ref N]" marker cannot be referenced;
  if information from one matters, restate it in the prompt yourself.

**Every subtask in one call starts at the same time, and none of them can see
another's output.** So put work in the same call only when the pieces are genuinely
independent. When one step needs what another produces, delegate only the first step
now — its results come back to you, and you delegate the next step then, in a later
call. That is how sequencing works here; there is no way to order subtasks within a
single call, and a subtask written as though it can read a sibling's output will run
without it.

Ask each subtask for the **material** you need, not for a finished answer: its
output is raw material for you, never something the user sees directly.

## Using results that have come back

When a \`${DELEGATE_TOOL_NAME}\` call's results are already in this conversation, they are
yours to use. Speak in your own voice — do not paste results verbatim, introduce
them as "subtask output", or mention subtasks, subagents, or delegation. The user
asked you.

Then end the round the same way as any other, and the choice is still yours:
\`${FINAL_REPLY_TOOL_NAME}\` if what came back finishes the request,
\`${DELEGATE_TOOL_NAME}\` if it does not. Results arriving is not itself a reason to
answer. Anything the user asked for that is still undone — a later step of a plan
they already gave you, or work the results themselves show is needed — is delegated
again, now, in this call, rather than guessed at.

**Announcing is not doing.** A \`${FINAL_REPLY_TOOL_NAME}\` that says what you are about
to do next ends the request instead of doing it: nothing runs after that call, and
the user has been told otherwise. Nothing you describe in that message happens.

There are two ways to actually do it, and you must pick one before replying:

- The step is **yours to run** — a tool you hold. Call it now, in this turn, and
  reply once you have its result. Words like "proceeding", "now", "next I'll" are
  the signal that you have skipped this.
- The step is **work for someone else**. That is a \`${DELEGATE_TOOL_NAME}\` call whose
  "reply" carries the very words you would have announced.

If some work failed or was skipped, say plainly what you could not do, in one
short sentence, without diagnostics or blame — then give them everything you did
manage. Never present a partial answer as complete, and never invent a result for
work that failed.`;
}

/**
 * Appended when the round loop has stopped the Task and this round has to answer.
 * Neither `delegate` nor any work tool is declared in that state, so this explains
 * a constraint the model can already see rather than imposing one. `final_reply`
 * remains, and is the only way to end.
 *
 * Every arm names a **fact**, on purpose, and that is the whole craft of this
 * string. "You cannot delegate" reads as a capability the model should route
 * around; the turns it has spent, or work that keeps coming back the same way,
 * read as things that are true — and the only sensible response to either is the
 * answer.
 *
 * Which is also why the arms are separate rather than one convenient sentence. A
 * task the loop stopped for want of progress still has budget left, so telling it
 * the budget is gone is false, and the falsehood does not stay in the prompt: the
 * model hands it to the user as the explanation for what went wrong.
 */
export function finalRoundNote(
  limits: AgentLimits,
  reason: FinalRoundReason
): string {
  if (reason === "no-progress") return noProgressNote();
  return `

# Your budget is spent

You have used this task's full budget of ${limits.maxTurns} turns, or its ${Math.round(limits.maxWallMs / 60_000)} minutes of
wall-clock time. You have no tools left except one: call \`${FINAL_REPLY_TOOL_NAME}\` now and
answer the user from what you already have. You cannot delegate, look anything up,
or take any other action.

Give them everything you did manage. If something is missing or failed, say so
plainly in one short sentence — do not apologize at length, and do not describe
budgets, limits, or this constraint.`;
}

/**
 * The other arm: the work went out several times and came back failing the same
 * way each time, so the loop stopped it.
 *
 * The failures themselves are already in the conversation — each round's
 * `delegate` result carries what its branches said — so this points at them
 * rather than restating them. What it has to prevent is the reply that says
 * "I'll try that again shortly": nothing runs after `final_reply`, and a task
 * that stopped because retrying changed nothing is the last place to promise
 * another one.
 */
function noProgressNote(): string {
  return `

# This keeps coming back the same way

The work you handed out has now failed the same way several times over, so this is
the last round: another attempt would return what the ones above it returned.
You have no tools left except one — call \`${FINAL_REPLY_TOOL_NAME}\` now.
You cannot delegate, look anything up, or take any other action.

Tell the user plainly what you could not do and what stopped you, in one or two
sentences and in your own voice. What came back is in this conversation above, and
the part of it that explains the wall is what they need — not an apology, and not
the details of how the work was run. Give them everything you did manage.

Do not say you will try again, keep working, or come back with more: nothing runs
after this message, and saying otherwise leaves them waiting for something that is
not coming.`;
}

/**
 * What a round is told about where a person comes into it: a question the model
 * asks, and a call a plugin holds for the person to approve.
 *
 * Every agent here takes both. Any of them can reach a point only the person can
 * settle, and the coding agents' pushes are held for approval by the plugin that
 * makes them. Appended to the round contract, so it opens on a blank line like the
 * other prompt strings in this file.
 */
export const askGuidance = `

## When only the person can tell you

One more call ends a round: \`${ASK_USER_TOOL_NAME}\`, which puts a question to the
person who made this request and waits for their answer. It is in the conversation
when your next round starts, and you carry on from there.

Ask when you cannot go on well without something only they can give you: a choice
between options that would each change what you do, a fact that is not anywhere
you can look, or a go-ahead for something they may not want. Do not ask what you
can look up, work out, or reasonably assume — say what you assumed instead. Do not
ask them to confirm a plan they already gave you. Ask one question with everything
you need in it, and offer options when the possible answers are few.

## Calls the person approves

Some tools wait for the person's approval before they run. One that comes back
declined was decided against: do not make that call again for this request. Say
what you would have done, and carry on with the rest.`;

/**
 * What the person reads when a round holds calls for their approval. The plugin
 * that gates a call words what the call does; this frames the calls as one
 * decision, because a single Approve or Reject answers them all.
 */
export function approvalPrompt(calls: readonly ApprovalCall[]): string {
  const lines = calls.map(
    (call) => `• ${call.reason ?? `\`${call.toolName}\``}`
  );
  return `Before I go ahead, I need your approval for this:\n\n${lines.join("\n")}`;
}

/**
 * What the user reads when a Task ends because a question it asked went
 * unanswered. Nothing failed: the agent stopped rather than guess.
 */
export const UNANSWERED_COPY =
  "I stopped here: I asked you a question and didn't hear back in time. Send the request again whenever you're ready.";

/**
 * Failure copy every round agent here shares: words for a question nobody
 * answered, and `undefined` for everything else, which `runHandleTask` answers
 * with `copy.taskFailed`. An agent with failures of its own to word handles those
 * first and falls through to this — see `src/agents/coder/workflow.ts`.
 */
export function failureCopy(kind: TaskFailureKind): string | undefined {
  return kind === "unanswered" ? UNANSWERED_COPY : undefined;
}

/** The round policy this Worker's delegating agents run under. */
export const roundPolicy: RoundPolicy = {
  roundContract,
  finalRoundNote,
  copy: {
    /** What the user sees on a failed Task. The diagnostic is logged, not shown. */
    taskFailed: "Sorry — something went wrong handling that request.",
    /**
     * The stand-in acknowledgement for the unreachable case where a round's
     * subtasks are durable but its acknowledgement is not in the Session.
     * Neutral by design: the work is valid and running, so the user gets an
     * honest acknowledgement rather than a failed Task.
     */
    recoveredReply: "Working on your request.",
    /** Appended when a deterministic join has to disclose gaps. */
    partialNote:
      "Some parts of this request could not be completed, so this answer covers " +
      "only what succeeded."
  },
  human: {
    askGuidance,
    approvalPrompt
  }
};

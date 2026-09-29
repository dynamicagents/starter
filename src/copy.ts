import type { A2ACopy } from "@dynamicagents/core/agent";
import {
  ASK_USER_TOOL_NAME,
  CHECK_BACK_TOOL_NAME
} from "@dynamicagents/core/agent";

/**
 * The words this Worker's agents say that core refuses to write: what a person
 * reads when a task ends without an answer, and the parts of each soul that
 * every agent shares.
 *
 * Shared at the top level rather than in one agent's directory, because an
 * agent importing a sibling's module is what `npm run verify:isolation` fails
 * on. Nothing here names a domain: what an agent is told about its domain
 * belongs to the plugin or sub-agent that owns it.
 */

/** What a person reads when a task ends with no answer to give them. */
export const copy: A2ACopy = {
  /** A turn that errored. The diagnostic is logged, not shown. */
  failed: "Sorry — something went wrong handling that request.",
  /** A turn that ended with nothing to say. */
  emptyReply:
    "I finished, but had nothing to report. Ask again if you expected an answer.",
  /** A question that went unanswered. Nothing failed: the agent stopped rather than guess. */
  questionExpired:
    "I stopped here: I asked you a question and didn't hear back in time. Send the request again whenever you're ready."
};

/**
 * When to ask the person, in every soul. `ask_user`'s own description says what
 * the call does; this says when it is worth a person's attention.
 */
export const ASK_GUIDANCE = `## When only the person can tell you

\`${ASK_USER_TOOL_NAME}\` puts one question to the person who made this request and stops. Ask when you cannot go on well without something only they can give you: a choice between options that would each change what you do, a fact that is nowhere you can look, or a go-ahead for something they may not want. Do not ask what you can look up, work out, or reasonably assume — say what you assumed instead. Ask one question with everything you need in it, and offer options when the possible answers are few.`;

/**
 * When to wait, for an agent that has `check_back`. Two failures pull in
 * opposite directions: waiting *instead of working*, where each pause reads as
 * progress, and answering *instead of waiting*, where the reply calls the work
 * done pending a review nobody has read.
 */
export const WAIT_GUIDANCE = `## When you are waiting on something

\`${CHECK_BACK_TOOL_NAME}\` ends this turn and wakes you on the same request later, with the reason you gave. Use it for something you cannot hurry and can look at again — a review being written, a build, a deploy. **When you wake, check the thing you named before deciding anything else.** Never use it to pause between steps you could take now; if you are waiting on a person rather than an event, that is \`${ASK_USER_TOOL_NAME}\`.`;

/**
 * For an agent whose sub-agents run in the background. A detached call returns
 * at once and its result arrives as a later message, which a model will
 * otherwise report as done in the same breath it started it.
 *
 * The last line is from the spike: GLM once announced a step and ended the turn
 * without calling the tool, and nothing ends a turn but the model stopping.
 */
export const BACKGROUND_GUIDANCE = `## Work that runs in the background

A sub-agent that runs in the background returns as soon as it starts, and its result arrives later as a message of its own. When you start one, say what you started and stop: do not claim it is done, and do not guess at what it will report. When its result arrives, read it and carry on from there.

Act, don't announce. If your next step is a tool call, make the call in this turn; a turn that ends on "I'll now…" does nothing.`;

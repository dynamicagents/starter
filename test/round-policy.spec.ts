import { describe, it, expect } from "vitest";
import {
  ASK_USER_TOOL_NAME,
  CHECK_BACK_TOOL_NAME,
  FINAL_REPLY_TOOL_NAME
} from "@dynamicagents/core/agent";
import { DELEGATE_TOOL_NAME } from "@dynamicagents/core/subtasks";
import {
  approvalPrompt,
  askGuidance,
  failureCopy,
  finalRoundNote,
  roundContract,
  roundPolicy,
  UNANSWERED_COPY,
  waitGuidance
} from "@/round-policy";

/**
 * The repo-owned half of the round loop: the words, not the mechanism.
 * `@dynamicagents/core/round` owns the DAG scheduler and the primary→fallback
 * ladder and pins none of this prose, so it is this file's to keep correct.
 */

describe("roundContract", () => {
  it("names the delegate and final-reply tools by their real names", () => {
    const text = roundContract({ deferrable: false });
    expect(text).toContain(DELEGATE_TOOL_NAME);
    expect(text).toContain(FINAL_REPLY_TOOL_NAME);
  });
});

describe("finalRoundNote", () => {
  const limits = { maxTurns: 20, maxWallMs: 60_000 };

  it("tells a budget-spent round it has no way out but answering", () => {
    const note = finalRoundNote(limits, "budget");
    expect(note).toContain("Your budget is spent");
    expect(note).toContain(FINAL_REPLY_TOOL_NAME);
    // Names the budget as a fact rather than as a withheld capability — a
    // model told "you cannot delegate" tries to route around it.
    expect(note).toContain("20 turns");
  });

  it("says delegation is unavailable rather than staying silent about it", () => {
    // `delegate` is not declared as a tool in this state — nothing in this
    // module asserts that; it lives in the runtime's control-tool wiring. What
    // this text owns is telling the model so in plain words, rather than
    // leaving it to notice the tool is simply gone from its schema.
    for (const reason of [
      "budget",
      "no-progress",
      "unresponsive-tools"
    ] as const) {
      expect(finalRoundNote(limits, reason)).toContain("cannot delegate");
    }
  });

  it("renders wall-clock minutes, not raw milliseconds", () => {
    const note = finalRoundNote(
      { maxTurns: 20, maxWallMs: 30 * 60_000 },
      "budget"
    );
    expect(note).toContain("30");
    expect(note).not.toContain("1800000");
  });

  it("never tells a stalled round its budget is spent", () => {
    // The reason this takes a reason at all. A task the loop stopped for want of
    // progress still has budget left, and a model told otherwise does not just
    // hold a wrong belief — it hands that belief to the user as the explanation
    // for what went wrong.
    const note = finalRoundNote(limits, "no-progress");
    expect(note).not.toContain("budget");
    expect(note).not.toContain("20 turns");
    // What it says instead is the thing that is actually true.
    expect(note).toContain("failed the same way");
    expect(note).toContain(FINAL_REPLY_TOOL_NAME);
  });

  it("tells a round whose tools stopped answering that, and not the budget", () => {
    const note = finalRoundNote(limits, "unresponsive-tools");
    expect(note).toContain("stopped answering");
    expect(note).not.toContain("budget");
    // A write abandoned rather than refused may have landed — a pull request
    // opened by a call whose answer never came back.
    expect(note).toContain("may have gone through");
    expect(note).toContain(FINAL_REPLY_TOOL_NAME);
  });

  it("forbids the reply that promises another attempt", () => {
    // `final_reply` ends the task; nothing runs after it. A round stopped
    // *because* retrying changed nothing is the last place to announce a retry —
    // "announcing is not doing", which the round contract above already guards
    // for the ordinary case.
    expect(finalRoundNote(limits, "no-progress")).toContain(
      "Do not say you will try again"
    );
  });
});

describe("roundPolicy", () => {
  it("wires the two functions above, not a redeclared copy of them", () => {
    expect(roundPolicy.roundContract).toBe(roundContract);
    expect(roundPolicy.finalRoundNote).toBe(finalRoundNote);
  });

  it("declares non-empty copy for every user-facing string", () => {
    expect(roundPolicy.copy.taskFailed.length).toBeGreaterThan(0);
    expect(roundPolicy.copy.recoveredReply.length).toBeGreaterThan(0);
    expect(roundPolicy.copy.partialNote.length).toBeGreaterThan(0);
  });
});

describe("where the person comes in", () => {
  it("does not tell the model its two endings are the only ones", () => {
    // `ask_user` ends a round too wherever it is offered, and every agent here
    // offers it, so a contract counting two calls would be false.
    const contract = roundContract({ deferrable: false });
    expect(contract).not.toContain("two ways to end this round");
    expect(contract).not.toContain("one of those two calls");
    expect(askGuidance).toContain(ASK_USER_TOOL_NAME);
  });

  it("keeps asking open once results have come back", () => {
    // Returned work is exactly where a choice only the person can make shows up,
    // and a section naming only answering and delegating steers the model away
    // from asking there.
    const contract = roundContract({ deferrable: false });
    const afterResults = contract.slice(
      contract.indexOf("## Using results that have come back"),
      contract.indexOf("**Announcing is not doing.**")
    );
    expect(afterResults).toContain(ASK_USER_TOOL_NAME);
  });

  // Nothing this Worker installs is gated any more, so `askGuidance` no longer
  // describes approvals — prompt copy for a non-event is read every round and
  // acted on never. The copy itself stays: core requires it, and it is what a
  // plugin that gates a call in future would use, so it is still pinned.
  it("frames held calls as one decision, in each gating plugin's words", () => {
    const prompt = approvalPrompt([
      {
        toolName: "repo_push",
        input: {},
        reason: "Push the branch `fix` of web to its remote."
      },
      { toolName: "repo_pr_comment", input: {} }
    ]);

    expect(prompt).toContain("Push the branch `fix` of web to its remote.");
    // A rule that gave no words still names the call, so the person knows what
    // they are allowing.
    expect(prompt).toContain("repo_pr_comment");
  });

  it("words a question that went unanswered, and leaves the rest to the policy", () => {
    expect(failureCopy("unanswered")).toBe(UNANSWERED_COPY);
    expect(failureCopy("exhausted")).toBeUndefined();
    expect(failureCopy("credential")).toBeUndefined();
  });

  it("gives the round agents the person's part of the round", () => {
    // Asking is not an agent setting: the contract carries when to ask, and the
    // copy carries what the person reads for an approval.
    const contract = roundContract({ deferrable: false });
    expect(contract.endsWith(askGuidance)).toBe(true);
    expect(roundPolicy.copy.approvalPrompt).toBe(approvalPrompt);
  });
});

/**
 * The fourth ending.
 *
 * Every assertion here is about a round being told the truth about what it may
 * do — the failure mode of prompt copy for an optional call is describing one the
 * model will not be given, and it is invisible until a round tries it.
 */
describe("a round that may wait", () => {
  const contract = (deferrable: boolean) => roundContract({ deferrable });

  it("describes the wait only to a round that has one", () => {
    expect(contract(true)).toContain(CHECK_BACK_TOOL_NAME);
    // The agents without an allowance — reactive, proactive — and
    // any coding round that has spent one. A contract naming a call the round is
    // not handed is a contract inviting a rejected call.
    expect(contract(false)).not.toContain(CHECK_BACK_TOOL_NAME);
  });

  it("adds waiting to the ways of actually doing something, not of describing it", () => {
    // The paragraph exists because a model that announces its next step ends the
    // request instead of taking it. Waiting is a third way to take it, and it has
    // to live there or it reads as permission to say "I'll check back later".
    const announcing = contract(true).slice(
      contract(true).indexOf("**Announcing is not doing.**")
    );
    expect(announcing).toContain(CHECK_BACK_TOOL_NAME);
    expect(announcing).toContain("sentence saying you will check later");
  });

  it("says the checks cost turns, because they do", () => {
    // Core charges every round its turns, deferred ones included — only the time
    // spent waiting is forgiven. Told a poll was free, a model polls at the floor
    // and spends the working budget on checks that come back identical.
    expect(waitGuidance).toContain("Checking is not free");
    expect(waitGuidance).not.toMatch(/no turn/i);
  });

  it("sends a wait on a person to the question instead", () => {
    // The two are easy to confuse and cost completely different things: a wait is
    // free and ends by itself, a question interrupts someone and may never be
    // answered.
    expect(waitGuidance).toContain(ASK_USER_TOOL_NAME);
  });

  it("tells the round that wakes to look before deciding", () => {
    // Without this the round reads the marker, concludes what it concluded
    // before, and waits again — which is how an allowance is spent on one
    // decision.
    expect(waitGuidance).toContain("[check_back]");
    expect(waitGuidance).toContain("before deciding anything else");
  });

  it("ends a spent allowance without withdrawing anything else", () => {
    const note = roundPolicy.deferralsSpentNote?.() ?? "";
    expect(note).toContain(CHECK_BACK_TOOL_NAME);
    // Still an open round: every other ending survives, which is what makes this
    // not a `finalRoundNote`.
    expect(note).toContain("Everything else still is");
    expect(note).not.toContain("no tools left");
    // And the promise it exists to prevent, for the reason `noProgressNote` does.
    expect(note).toContain("do not offer to keep checking");
  });

  it("supplies the note core refuses to invent", () => {
    // `buildTurnInstructions` throws when an agent enables deferrals without it,
    // and both coders enable them — so a policy missing this fails at DO start
    // rather than at the round that runs out.
    expect(roundPolicy.deferralsSpentNote).toBeDefined();
  });
});

describe("what is no longer said", () => {
  it("stops describing approvals nothing can trigger", () => {
    // `repo_open_pr` was the only gated call in this Worker and no longer is, so
    // the paragraph describing approvals described a non-event — read every
    // round, acted on never.
    expect(askGuidance).not.toContain("approval");
    expect(askGuidance).not.toContain("declined");
  });

  it("keeps the words a gated call would use", () => {
    // Core requires `approvalPrompt` and the machinery is untouched, so a plugin
    // that gates a call in future needs nothing here to change.
    expect(roundPolicy.copy.approvalPrompt).toBe(approvalPrompt);
  });
});

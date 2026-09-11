import { describe, it, expect } from "vitest";
import {
  ASK_USER_TOOL_NAME,
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
  UNANSWERED_COPY
} from "@/round-policy";

/**
 * The repo-owned half of the round loop: the words, not the mechanism.
 * `@dynamicagents/core/round` owns the DAG scheduler and the primary→fallback
 * ladder and pins none of this prose, so it is this file's to keep correct.
 */

describe("roundContract", () => {
  const contract = (typeKeys: string[], maxSubtasks = 8) =>
    roundContract({ typeKeys, maxSubtasks });

  it("names every installed subtask type, and only those", () => {
    const text = contract(["general"]);
    expect(text).toContain('"general"');
    // The enum is what the model may emit; a type nobody installed must not
    // appear in the prose either, or the model is invited to name it.
    expect(text).not.toContain('"arc-game"');
  });

  it("names the delegate and final-reply tools by their real names", () => {
    const text = contract(["general"]);
    expect(text).toContain(DELEGATE_TOOL_NAME);
    expect(text).toContain(FINAL_REPLY_TOOL_NAME);
  });

  it("states the caller's own maxSubtasks ceiling", () => {
    expect(contract(["general"], 8)).toContain("between 1 and 8");
    expect(contract(["general"], 3)).toContain("between 1 and 3");
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
    for (const reason of ["budget", "no-progress"] as const) {
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
    const contract = roundContract({ typeKeys: ["general"], maxSubtasks: 8 });
    expect(contract).not.toContain("two ways to end this round");
    expect(contract).not.toContain("one of those two calls");
    expect(askGuidance).toContain(ASK_USER_TOOL_NAME);
  });

  it("tells the model not to make a declined call again", () => {
    expect(askGuidance).toContain("do not make that call again");
  });

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
    expect(roundPolicy.human?.askGuidance).toBe(askGuidance);
    expect(roundPolicy.human?.approvalPrompt).toBe(approvalPrompt);
  });
});

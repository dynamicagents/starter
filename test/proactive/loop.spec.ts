import { describe, it, expect } from "vitest";
import { APICallError, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import {
  countingModel,
  FakeSession,
  mockModel,
  rateLimitedModel,
  throwingModel
} from "@dynamicagents/core/testing";
import { sessionMessage, type ModelPair } from "@dynamicagents/core/agent";
import { noReplyTool, NO_REPLY_TOOL_NAME } from "@dynamicagents/plugins/triage";
import {
  runTurn,
  TRANSIENT_REPLY,
  type RunTurnArgs
} from "@/agents/proactive/loop";

/**
 * The proactive loop — the second consumer's turn, and the evidence that core
 * stopped at the right place.
 *
 * Everything asserted here is a shape the reactive round loop does not have: a
 * flat step ceiling instead of a metered budget, an ending that is allowed to be
 * silence, and a `no_reply` that is honoured or ignored depending on whether the
 * agent has already spoken. Core ships none of it — and if core had been built
 * from the reactive agent alone, it would have shipped a control-tool abstraction
 * this file would be fighting.
 */

const MODELS = { primary: "@cf/test/primary", fallback: "@cf/test/fallback" };

function pair(primary: ReturnType<typeof mockModel>, fallback = primary) {
  return {
    primary: () => primary,
    fallback: () => fallback,
    primaryId: () => MODELS.primary,
    fallbackId: () => MODELS.fallback
  } as unknown as ModelPair;
}

/**
 * A pair that fails while being *built*, before there is a model to call.
 *
 * Only the catch-all below wants this. A failure of the inference itself has to
 * come out of the model, or the pair never sees it — and which slot ended up
 * answering is the question the failure specs ask.
 */
function failing(error: unknown) {
  const throwing = () => {
    throw error;
  };
  return {
    primary: throwing,
    fallback: throwing,
    primaryId: () => MODELS.primary,
    fallbackId: () => MODELS.fallback
  } as unknown as ModelPair;
}

/** As Workers AI fails: an internal code mapped onto its documented status. */
function workersAiFailure(statusCode: number, message: string) {
  return new APICallError({
    message,
    url: `workers-ai:binding/run/${MODELS.primary}`,
    requestBodyValues: {},
    statusCode
  });
}

/** History with the inbound turn already appended — the DO's job, not the loop's. */
function withTurn(session: FakeSession, text: string) {
  const message = sessionMessage("user", text);
  session.appendMessage(message);
  return session.messages;
}

function args(overrides: Partial<RunTurnArgs> = {}): RunTurnArgs {
  const session = overrides.session ?? new FakeSession();
  return {
    session,
    history: withTurn(session as FakeSession, "is anyone there?"),
    systemSuffix: "",
    tools: { [NO_REPLY_TOOL_NAME]: noReplyTool },
    models: pair(mockModel({ text: "here is your answer" })),
    maxSteps: 8,
    unexpectedReply: "something went wrong",
    ...overrides
  };
}

describe("replying", () => {
  it("returns the model's text and persists it", async () => {
    const session = new FakeSession();
    const outcome = await runTurn(args({ session }));

    expect(outcome).toEqual({ kind: "reply", text: "here is your answer" });
    expect(session.messages.at(-1)?.role).toBe("assistant");
  });

  it("does not append the user turn — the DO already did", async () => {
    // The append moved to the caller when triage became a plugin gate: the
    // message has to be in history *before* the gate runs, so appending here as
    // well would duplicate every turn.
    const session = new FakeSession();
    await runTurn(args({ session }));
    expect(session.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("treats an empty response as transient rather than as an answer", async () => {
    const outcome = await runTurn(
      args({ models: pair(mockModel({ text: "   " })) })
    );
    expect(outcome).toEqual({ kind: "reply", text: TRANSIENT_REPLY });
  });
});

describe("declining late, via the no_reply tool", () => {
  it("ends the turn in silence when nothing has been said yet", async () => {
    const session = new FakeSession();
    const outcome = await runTurn(
      args({
        session,
        models: pair(
          mockModel({ toolCall: { toolName: NO_REPLY_TOOL_NAME, input: {} } })
        )
      })
    );

    expect(outcome).toEqual({ kind: "no_reply" });
    // Nothing assistant-shaped is persisted: the agent read the channel and
    // chose not to speak.
    expect(session.messages.some((m) => m.role === "assistant")).toBe(false);
  });

  it("ignores a no_reply once the agent has already streamed content", async () => {
    // The guard that makes `no_reply` a *late* decision rather than a way to
    // discard a turn the user has already seen. Hiding the tool is not enough —
    // the SDK resolves a call against the unfiltered map, so a model that names
    // it after speaking would execute it happily.
    const streamed: string[] = [];
    const outcome = await runTurn(
      args({
        models: pair(
          mockModel(
            { text: "let me check", toolCall: { toolName: "noop", input: {} } },
            { toolCall: { toolName: NO_REPLY_TOOL_NAME, input: {} } },
            { text: "actually, here it is" }
          )
        ),
        tools: {
          [NO_REPLY_TOOL_NAME]: noReplyTool,
          // A real tool, so the first step can carry text *and* a tool call —
          // which is what makes it an intermediate step, which is what streams
          // the content that then disqualifies the `no_reply`.
          noop: tool({
            description: "does nothing",
            inputSchema: z.object({}),
            execute: async () => "ok"
          })
        },
        onContent: (text) => {
          streamed.push(text);
        }
      })
    );

    expect(streamed).toContain("let me check");
    expect(outcome.kind).not.toBe("no_reply");
  });
});

describe("failure handling", () => {
  it("reports an unexpected failure as `failed`, not as a reply", async () => {
    // The distinction is load-bearing: A2A v1.0 carries no structured task
    // error, so the terminal state is the only way to tell the gatekeeper the turn
    // broke rather than answered.
    const outcome = await runTurn(
      args({
        models: failing(new Error("boom")),
        unexpectedReply: "sorry, it broke"
      })
    );
    expect(outcome).toEqual({ kind: "failed", text: "sorry, it broke" });
  });

  it("hands a capacity blip to the other model", async () => {
    // The two slots are different models, and the second may have capacity the
    // first does not. Both outcomes are an answer, so only the call counts tell
    // which model gave it.
    const primary = rateLimitedModel(1, { text: "never reached" });
    const fallback = countingModel({ text: "here is your answer" });

    const outcome = await runTurn(
      args({ models: pair(primary.model, fallback.model) })
    );

    expect(outcome).toEqual({ kind: "reply", text: "here is your answer" });
    expect(primary.calls()).toBe(1);
    expect(fallback.calls()).toBe(1);
  });

  it("keeps a fallback that takes over after the agent spoke from going silent", async () => {
    // The primary speaks, then cannot make its next call. The fallback takes
    // the turn from there — and names `no_reply`, which would discard a turn the
    // user has already seen. What was said stays said, and is not said twice.
    const spoke = mockModel({
      text: "let me check",
      toolCall: { toolName: "noop", input: {} }
    });
    let calls = 0;
    const primary = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls += 1;
        if (calls > 1) throw workersAiFailure(400, "5007: bad input");
        return spoke.doGenerate(options);
      }
    });
    const fallback = mockModel(
      { toolCall: { toolName: NO_REPLY_TOOL_NAME, input: {} } },
      { text: "here is what I found" }
    );
    const streamed: string[] = [];

    const outcome = await runTurn(
      args({
        models: pair(primary, fallback),
        tools: {
          [NO_REPLY_TOOL_NAME]: noReplyTool,
          noop: tool({
            description: "does nothing",
            inputSchema: z.object({}),
            execute: async () => "ok"
          })
        },
        onContent: (text) => {
          streamed.push(text);
        }
      })
    );

    expect(outcome).toEqual({ kind: "reply", text: "here is what I found" });
    expect(streamed).toEqual(["let me check"]);
  });

  it("reports a transient capacity blip as a reply telling the user to retry", async () => {
    // What one looks like by the time this loop catches it: both slots refused
    // every attempt the SDK made, and it wrapped them in a `RetryError`. Core
    // unwraps that to the attempt the call ended on, which is still a 429 —
    // nothing is broken and the work is recoverable, so the turn genuinely
    // completed, by saying "try again".
    const primary = rateLimitedModel(Number.POSITIVE_INFINITY, {
      text: "unreachable"
    });
    const fallback = rateLimitedModel(Number.POSITIVE_INFINITY, {
      text: "unreachable"
    });

    const outcome = await runTurn(
      args({ models: pair(primary.model, fallback.model) })
    );

    expect(outcome).toEqual({ kind: "reply", text: TRANSIENT_REPLY });
    // Every attempt asked both slots. The attempt count itself is pinned in
    // core, where the chunk headroom is sized against it.
    expect(primary.calls()).toBeGreaterThan(1);
    expect(fallback.calls()).toBeGreaterThan(1);
  });

  it("reports a blocked account as a failure rather than as a blip", async () => {
    // Its sentence reads like an outage and its status does not. Telling this
    // caller to try again is telling them to wait out something that will not
    // clear until an operator clears it.
    const blocked = () =>
      throwingModel(
        workersAiFailure(403, "3023: Service unavailable for account")
      );
    const primary = blocked();
    const fallback = blocked();

    const outcome = await runTurn(
      args({
        models: pair(primary.model, fallback.model),
        unexpectedReply: "sorry, it broke"
      })
    );

    expect(outcome).toEqual({ kind: "failed", text: "sorry, it broke" });
    // Once each: a status the provider marked non-retryable is not waited on,
    // by the SDK or by anything here.
    expect(primary.calls()).toBe(1);
    expect(fallback.calls()).toBe(1);
  });
});

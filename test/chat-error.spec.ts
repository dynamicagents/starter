import { describe, it, expect } from "vitest";
import type { ChatErrorClassification } from "@cloudflare/think";
import { StepAgent } from "@dynamicagents/core/agent";
import { SubAgent } from "@dynamicagents/core/subagent";
import * as worker from "@/index";
import { transientChatError } from "@/model";

/**
 * What a failed turn is classified as, for every class that runs one.
 *
 * Think continues a turn after a stream error only for `"transient"` or
 * `"rate_limit"` and ends it for anything else, `undefined` included. Core
 * answers with the context-overflow classifier alone and leaves the rest to the
 * deployment, so this is where a dropped connection stops being a failed step
 * job: `src/model.ts` holds the why and what it costs.
 *
 * Driven over every turn-running class this Worker exports rather than over a
 * list written here, because the failure this guards is a class that does not
 * override it: it would inherit core's, fail a turn its siblings continue, and
 * nothing would say so. A class added tomorrow is in this set the moment
 * `src/index.ts` exports it.
 */

/**
 * Every class this Worker exports that runs turns through Think, by the
 * prototype the hook lives on.
 *
 * The prototype rather than the class, because for the Claude Code runs the
 * override is on the abstract base they share and only its `classifyChatError`
 * is the one under test. The module's other exports — hosts, workflows,
 * sandboxes, the fetch handler — are not constructors of turn-running classes
 * and fall out here.
 */
const TURN_CLASSES = Object.entries(worker).flatMap(([name, value]) => {
  const prototype: unknown = (value as { prototype?: unknown }).prototype;
  return typeof value === "function" &&
    (prototype instanceof StepAgent || prototype instanceof SubAgent)
    ? [{ name, prototype: prototype as ClassifiesChatError }]
    : [];
});

interface ClassifiesChatError {
  classifyChatError(error: unknown): ChatErrorClassification | undefined;
}

/**
 * One class's answer for one error.
 *
 * Called on the prototype rather than on an instance: the hook reads its
 * argument and nothing else, and its `super` is resolved where it was written,
 * so a Durable Object would add setup without adding coverage.
 */
function classify(
  prototype: ClassifiesChatError,
  error: unknown
): ChatErrorClassification | undefined {
  return prototype.classifyChatError.call(undefined, error);
}

/** The runtime's message for a connection that died under a request. */
const CONNECTION_LOST = "Network connection lost.";
/** One of the provider strings the classifier core delegates to matches. */
const OVERFLOW = "prompt is too long: 250000 tokens > 200000 maximum";

describe("the shape a dropped connection arrives as", () => {
  it("is the platform's, read through its own predicate", () => {
    expect(transientChatError(new Error(CONNECTION_LOST))).toBe("transient");
    // Think hands a classifier an `Error`, an AI SDK error, or — for an
    // in-stream provider error — the message string. All three reach this.
    expect(transientChatError(CONNECTION_LOST)).toBe("transient");
    // A wrapper carries the platform error in `cause`, and may not pass on its
    // signal properties, so the chain is what has to be read.
    expect(
      transientChatError(
        new Error("SQL query failed", { cause: new Error(CONNECTION_LOST) })
      )
    ).toBe("transient");
    // An isolate the platform superseded mid-invocation, which is the same
    // answer: the next wake runs the new code.
    expect(
      transientChatError(new Error("reset because its code was updated"))
    ).toBe("transient");
  });

  it("says nothing about an error that is not the platform's", () => {
    expect(
      transientChatError(new Error("ENOENT: no such file"))
    ).toBeUndefined();
    expect(transientChatError(new Error(OVERFLOW))).toBeUndefined();
    expect(transientChatError(undefined)).toBeUndefined();
  });

  /**
   * The cost of reading a message rather than a typed signal, accepted
   * deliberately: a permanently broken connection is retried through
   * `chatRecovery.maxAttempts` with backoff before the turn ends and the step
   * job fails. `src/model.ts` states the trade.
   */
  it("cannot tell a permanent failure of that shape from a momentary one", () => {
    expect(
      transientChatError(new Error(`the provider is gone: ${CONNECTION_LOST}`))
    ).toBe("transient");
  });
});

describe("every class that runs a turn", () => {
  it("is found, so a new one cannot miss this", () => {
    // Named rather than counted: the set is what `src/index.ts` exports.
    const names = TURN_CLASSES.map(({ name }) => name);
    expect(names).toContain("GenericAgent");
    expect(names).toContain("CodingAgent");
    expect(names).toContain("ClaudeCoordinatorAgent");
    expect(names).toContain("GenericChild");
    expect(names).toContain("CodingChild");
    expect(names).toContain("ClaudeCoordinatorWriterChild");
  });

  it.each(TURN_CLASSES)(
    "$name continues a turn the platform cut",
    ({ prototype }) => {
      expect(classify(prototype, new Error(CONNECTION_LOST))).toBe("transient");
      expect(classify(prototype, CONNECTION_LOST)).toBe("transient");
    }
  );

  it.each(TURN_CLASSES)("$name still compacts an overflow", ({ prototype }) => {
    // The delegation is the point: this one is core's answer, not this
    // deployment's, and it is what `contextOverflow.reactive` acts on.
    expect(classify(prototype, new Error(OVERFLOW))).toBe("context_overflow");
  });

  it.each(TURN_CLASSES)(
    "$name leaves anything else terminal",
    ({ prototype }) => {
      expect(
        classify(prototype, new Error("ENOENT: no such file"))
      ).toBeUndefined();
    }
  );
});

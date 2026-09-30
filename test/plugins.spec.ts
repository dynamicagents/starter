import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  PluginSetupError,
  assemblePlugins,
  definePlugin,
  type SubAgentSpec
} from "@dynamicagents/core";
import { GenericChild } from "@/agents/generic/children";
import { CodingChild } from "@/agents/coding/children";
import {
  AnthropicCodingReaderChild,
  AnthropicCodingWriterChild
} from "@/agents/anthropic-coding/children";
import { CODING, ANTHROPIC_CODING, GENERIC } from "@/config";

/**
 * The seam between this repo and the packages it composes: what happens when
 * they disagree, and whether a sub-agent written *here* is indistinguishable
 * from one a plugin publishes.
 */

const SPECS: [string, SubAgentSpec<unknown, unknown>][] = [
  ["GenericChild", GenericChild.spec],
  ["CodingChild", CodingChild.spec],
  ["AnthropicCodingWriterChild", AnthropicCodingWriterChild.spec],
  ["AnthropicCodingReaderChild", AnthropicCodingReaderChild.spec]
] as [string, SubAgentSpec<unknown, unknown>][];

describe("a sub-agent this repo binds", () => {
  it.each(SPECS)("%s declares a soul and a description", (_, spec) => {
    // Core refuses to lend a soul, so that no run executes under an identity
    // nobody chose — which is why the ones below live in the starter.
    expect(spec.soul.length).toBeGreaterThan(0);
    expect(spec.description.length).toBeGreaterThan(0);
  });

  it("runs in the background exactly where a run can outlast a turn", () => {
    // Research and drafting finish in minutes; an implementation run and a
    // Claude Code session can each outlast the fifteen minutes a turn may last.
    expect(
      Object.fromEntries(SPECS.map(([name, spec]) => [name, !!spec.detached]))
    ).toEqual({
      GenericChild: false,
      CodingChild: true,
      AnthropicCodingWriterChild: true,
      AnthropicCodingReaderChild: true
    });
  });

  it("hands each coder run its workspace from the parent, never from its input", () => {
    for (const [, spec] of SPECS.slice(1)) {
      expect(spec.prepare).toBeTypeOf("function");
    }
    // The model writes the input, and a workspace name there would let it name
    // another caller's container.
    for (const [, spec] of SPECS) {
      const shape = (spec.inputSchema as { shape?: Record<string, unknown> })
        .shape;
      expect(Object.keys(shape ?? {})).not.toContain("workspaceName");
    }
  });
});

describe("contract skew between the repos", () => {
  it("fails at startup on a missing declared binding, not at the first tool call", () => {
    // A plugin cannot add its own wrangler binding, which is the whole reason it
    // declares `requires`. Failing here beats failing inside a request someone is
    // waiting on.
    const needsSecret = definePlugin({
      name: "needs-secret",
      requires: { secrets: ["NOT_A_REAL_SECRET"] }
    });

    expect(() => assemblePlugins([needsSecret], env)).toThrow(PluginSetupError);
    expect(() => assemblePlugins([needsSecret], env)).toThrow(
      /missing bindings or secrets/
    );
  });
});

describe("tuning", () => {
  it("runs anthropic-coding's parent on the full-size model, and only it", () => {
    expect(ANTHROPIC_CODING.modelId).not.toBe(CODING.modelId);
    expect(GENERIC.modelId).toBe(CODING.modelId);
    // Everything else is `coding`'s, so a change to one reaches the other.
    expect({ ...ANTHROPIC_CODING, modelId: CODING.modelId }).toEqual(CODING);
  });

  it.each([GENERIC, CODING, ANTHROPIC_CODING])(
    "compacts on the flash model",
    (tuning) => {
      expect(tuning.compactionModelId).toBe(CODING.modelId);
    }
  );

  it.each([GENERIC, CODING, ANTHROPIC_CODING])(
    "keeps a recent tail inside the compaction threshold",
    (tuning) => {
      expect(tuning.keepRecentTokens).toBeLessThan(tuning.compactAfterTokens);
    }
  );
});

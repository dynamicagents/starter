import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  PluginSetupError,
  assemblePlugins,
  definePlugin,
  type SubAgentSpec
} from "@dynamicagents/core";
import { GenericGeneral } from "@/agents/generic/children";
import { CfCoderCode } from "@/agents/cf-coder/children";
import {
  ClaudeCoderReader,
  ClaudeCoderSession
} from "@/agents/claude-coder/children";
import { CF_CODER, CLAUDE_CODER, GENERIC } from "@/config";

/**
 * The seam between this repo and the packages it composes: what happens when
 * they disagree, and whether a sub-agent written *here* is indistinguishable
 * from one a plugin publishes.
 */

const SPECS: [string, SubAgentSpec<unknown, unknown>][] = [
  ["GenericGeneral", GenericGeneral.spec],
  ["CfCoderCode", CfCoderCode.spec],
  ["ClaudeCoderSession", ClaudeCoderSession.spec],
  ["ClaudeCoderReader", ClaudeCoderReader.spec]
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
      GenericGeneral: false,
      CfCoderCode: true,
      ClaudeCoderSession: true,
      ClaudeCoderReader: true
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
  it("runs claude-coder's parent on the full-size model, and only it", () => {
    expect(CLAUDE_CODER.modelId).not.toBe(CF_CODER.modelId);
    expect(GENERIC.modelId).toBe(CF_CODER.modelId);
    // Everything else is cf-coder's, so a change to one reaches the other.
    expect({ ...CLAUDE_CODER, modelId: CF_CODER.modelId }).toEqual(CF_CODER);
  });

  it.each([GENERIC, CF_CODER, CLAUDE_CODER])(
    "keeps a recent tail inside the compaction threshold",
    (tuning) => {
      expect(tuning.keepRecentTokens).toBeLessThan(tuning.compactAfterTokens);
    }
  );
});

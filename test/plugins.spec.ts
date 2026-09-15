import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  createAgentRuntime,
  definePlugin,
  resolveConfig,
  RuntimeSetupError,
  validateRecipe,
  type AgentPlugin
} from "@dynamicagents/core";
import { BROWSER_FAMILY } from "@dynamicagents/plugins/browser";
import { WORKSPACE_FAMILY } from "@dynamicagents/plugins/workspace";
import { general } from "@/agents/reactive/general";
import { REACTIVE_CONFIG } from "@/config";

/**
 * The seam between this repo and the packages it composes: what happens when
 * they disagree, and whether a plugin written *here* is indistinguishable from a
 * published one.
 */

describe("a plugin this repo writes", () => {
  it("registers its subtask type like any published one", () => {
    const runtime = createAgentRuntime({
      config: REACTIVE_CONFIG,
      plugins: [general()]
    });

    expect(runtime.types.keys).toEqual(["general"]);
    expect(runtime.types.spec("general")?.params).toBeNull();
  });

  it("declares a soul, which core refuses to supply a default for", () => {
    // `validateRecipe` rejects a recipe with no soul rather than lending it one,
    // so that no run ever executes under an identity nobody chose. That refusal
    // is exactly why this plugin lives in the starter and not in a library.
    const runtime = createAgentRuntime({
      config: REACTIVE_CONFIG,
      plugins: [general()]
    });
    const recipe = runtime.types.resolveRecipe("general");

    expect(recipe.soul.length).toBeGreaterThan(0);
    expect(() =>
      validateRecipe({ ...recipe, soul: "" }, runtime.policy)
    ).toThrow();
  });

  it("degrades rather than breaks when a named tool family is not installed", () => {
    // The recipe names `browser` and `workspace`, but a family no installed
    // plugin registered is dropped by `validateRecipe` — so uninstalling
    // `/browser` leaves a working subagent with fewer tools, not a broken one.
    const runtime = createAgentRuntime({
      config: REACTIVE_CONFIG,
      plugins: [general()] // neither family installed
    });
    const validated = validateRecipe(
      runtime.types.resolveRecipe("general"),
      runtime.policy
    );

    expect(validated.toolFamilies).not.toContain(BROWSER_FAMILY);
    expect(validated.toolFamilies).not.toContain(WORKSPACE_FAMILY);
  });
});

describe("contract skew between the three repos", () => {
  /**
   * Core, plugins and the starter publish from separate repos, so a version
   * train always leaves one of them briefly behind. Without this assert the
   * failure is a structural-type mismatch several frames from its cause; with
   * it, it is a sentence naming the plugin and both versions, at DO start.
   *
   * Asserted as a unit test rather than by installing a deliberately mismatched
   * `@dynamicagents/core`, which would need a published bad version to exist.
   */
  it("refuses a plugin built against a different contract version", () => {
    const stale: AgentPlugin = {
      ...definePlugin({ key: "stale" }),
      contractVersion: 999
    };

    expect(() =>
      createAgentRuntime({ config: REACTIVE_CONFIG, plugins: [stale] })
    ).toThrow(RuntimeSetupError);
    expect(() =>
      createAgentRuntime({ config: REACTIVE_CONFIG, plugins: [stale] })
    ).toThrow(/contract v999/);
  });

  it("refuses two plugins claiming the same key", () => {
    expect(() =>
      createAgentRuntime({
        config: REACTIVE_CONFIG,
        plugins: [general(), general()]
      })
    ).toThrow(/duplicate plugin key/);
  });

  it("fails at startup on a missing declared binding, not at the first tool call", () => {
    // A plugin cannot add its own wrangler binding, which is the whole reason it
    // declares `requires`. Failing here beats failing inside a request someone is
    // waiting on.
    const needsSecret = definePlugin({
      key: "needs-secret",
      requires: { secrets: ["NOT_A_REAL_SECRET"] }
    });

    expect(() =>
      createAgentRuntime({
        config: REACTIVE_CONFIG,
        plugins: [needsSecret],
        env
      })
    ).toThrow(/missing bindings or secrets/);
  });
});

describe("config resolution", () => {
  it("holds the compaction invariant that keeps summaries from firing on nothing", () => {
    // Below a 10k gap the fixed post-compaction floor eats the headroom and
    // compaction fires on nearly every append, each firing spending a summarizer
    // call on a near-empty middle.
    expect(() =>
      resolveConfig({
        // Required now: core ships no model default, so every config names its
        // own pair. Reuses this repo's, since the assertion is about session
        // arithmetic and nothing else.
        model: REACTIVE_CONFIG.model,
        session: { compactAfterTokens: 12_000, compactTailTokens: 5_000 }
      })
    ).toThrow(
      /compactAfterTokens - session.compactTailTokens must be >= 10000/
    );
  });

  it("keeps each agent's declared overrides", () => {
    const resolved = resolveConfig(REACTIVE_CONFIG);
    expect(resolved.model.chatModelId).toBe(REACTIVE_CONFIG.model!.chatModelId);
    expect(resolved.maxSubtasks).toBe(REACTIVE_CONFIG.maxSubtasks);
  });
});

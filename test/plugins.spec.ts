import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  createAgentRuntime,
  definePlugin,
  resolveConfig,
  validateRecipe
} from "@dynamicagents/core";
import { BROWSER_FAMILY } from "@dynamicagents/plugins/browser";
import { WORKSPACE_FAMILY } from "@dynamicagents/plugins/workspace";
import { general } from "@/agents/reactive/general";
import {
  CLAUDE_CODER_CONFIG,
  CF_CODER_CONFIG,
  REACTIVE_CONFIG
} from "@/config";

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
  it("keeps each agent's declared overrides", () => {
    const resolved = resolveConfig(REACTIVE_CONFIG);
    expect(resolved.model.chatModelId).toBe(REACTIVE_CONFIG.model!.chatModelId);
    expect(resolved.maxSubtasks).toBe(REACTIVE_CONFIG.maxSubtasks);
  });

  /**
   * claude-coder's parent is the one agent whose pair is inverted, and the
   * inversion is the whole of what it changes. Stated as a relationship rather
   * than two model ids so that moving the family stays a one-line edit, and
   * asserted by swapping the pair back: anything else that drifts apart —
   * including a field added to `MODEL` later — fails here.
   */
  it("inverts the model pair for claude-coder alone", () => {
    const shared = CF_CODER_CONFIG.model!;
    const inverted = CLAUDE_CODER_CONFIG.model!;

    expect(inverted.chatModelId).toBe(shared.fallbackChatModelId);
    expect(inverted.fallbackChatModelId).toBe(shared.chatModelId);
    expect(REACTIVE_CONFIG.model!.chatModelId).toBe(shared.chatModelId);
    expect({
      ...inverted,
      chatModelId: shared.chatModelId,
      fallbackChatModelId: shared.fallbackChatModelId
    }).toEqual(shared);
  });
});

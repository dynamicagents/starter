import type { CoreConfigOverrides } from "@dynamicagents/core";
// Type-only, so nothing reaches a bundle: these names are what make a mistyped
// or renamed tuning field fail at `tsc` instead of being spread into a plugin
// config and silently ignored. A spread is the reason they are needed — a key
// the plugin does not declare is an error written inline and no error at all
// through `...`, so only the `satisfies` on each constant catches it.
import type { ClaudeCodeConfig } from "@dynamicagents/plugins/claude-code";
import type { RecallTuning } from "@dynamicagents/plugins/recall";
import type { TriageTuning } from "@dynamicagents/plugins/triage";

/**
 * Every value this agent tunes, in one file.
 *
 * Core owns the shapes and a working baseline (`DEFAULT_CORE_CONFIG`); this is
 * only what the deployment wants different, merged and validated once per
 * Durable Object by `resolveConfig`. Exported values rather than module-level
 * constants because a constant read at import time is not overridable and
 * freezes before `env` exists — which on Workers is always.
 *
 * Nothing here is a platform fact: chunk sizing, step timeouts and the rest live
 * in core's `platform.ts` and are deliberately not tunable.
 */

/**
 * What every agent in this Worker shares: the model pair and the AI Gateway they
 * are billed and correlated through.
 *
 * **You must choose these — core ships no default.** The model sets the cost of
 * every turn and the tool-calling reliability the whole control-tool design
 * rests on, and a model id frozen into a published package outlives every
 * deprecation until someone bumps it.
 *
 * The primary is picked for reliable multi-tool-call behaviour over long
 * contexts, which is what a delegating round is: a round ends only when the
 * model calls a control tool, and one that answers in prose instead burns the
 * whole budget reaching no ending.
 *
 * The fallback here is the primary's **full-size sibling**, not another vendor
 * (`PROACTIVE_CONFIG` replaces it with its own), and that is a trade. It buys
 * depth: a round the flash model failed to hold together is retried on a
 * stronger model. It gives up independence: what makes a primary throw — an
 * outage, a rate limit, a deprecation, a bad deploy of one vendor's serving
 * stack — is correlated within a family and takes both down together. Core
 * refuses only an identical pair; if a vendor-wide failure costs more here than
 * a weaker second attempt, point the fallback at another family.
 *
 * Both must support function calling and tolerate a long system prompt. After
 * changing either, re-read `mainAgentLimits.maxTurns`: a model needing more steps
 * to reach an ending spends the same budget faster.
 */
const MODEL = {
  chatModelId: "@cf/zai-org/glm-5.3-flash",
  fallbackChatModelId: "@cf/zai-org/glm-5.3",
  /** AI Gateway slug; `"default"` auto-provisions on first request. */
  aiGatewayId: "default",
  // Generous, and coupled to `reasoningEffort`: reasoning is spent against this
  // before the tool call that ends a round, and a coding round writes a file and
  // a test on top of it. A truncated round or patch reads as a finished one.
  maxOutputTokens: 32_000,
  reasoningEffort: "high"
} as const;

/**
 * The reactive agent: delegates, so it pays for rounds of subagent work and is
 * bounded across all of them.
 *
 * `compactAfterTokens` is tight on purpose — a delegating agent accumulates
 * branch results fast. Core asserts `compactAfterTokens - compactTailTokens >=
 * 10_000`, which keeps compaction from firing on a near-empty middle, so never
 * lower the threshold without lowering the tail with it.
 */
export const REACTIVE_CONFIG: CoreConfigOverrides = {
  model: MODEL,
  mainAgentLimits: { maxTurns: 20, maxWallMs: 60 * 60_000 },
  subagentLimits: { maxTurns: 20, maxWallMs: 30 * 60_000 },
  toolOutputWindow: 4,
  // Core's own default, stated rather than inherited because every other knob
  // here is. Two rounds of work-tool exchanges is what stops a round re-making
  // the mistake the round before it just made, and it is the smallest window
  // that can.
  roundObservationWindow: 2,
  maxSubtasks: 8,
  session: {
    memoryMaxTokens: 1200,
    compactAfterTokens: 16_000,
    compactTailTokens: 5_000
  }
};

/**
 * The arc-player: reactive's loop, but every task is one long game.
 *
 * Higher wall clock and turn ceilings because a play legitimately runs for tens
 * of minutes, and `maxSubtasks` is low because the useful fan-out is one subtask
 * per game named, not eight.
 */
export const ARC_PLAYER_CONFIG: CoreConfigOverrides = {
  ...REACTIVE_CONFIG,
  mainAgentLimits: { maxTurns: 40, maxWallMs: 2 * 60 * 60_000 },
  subagentLimits: { maxTurns: 60, maxWallMs: 60 * 60_000 },
  maxSubtasks: 4
};

/**
 * The coder: long rounds, few subtasks, and a real container underneath.
 *
 * Every budget here is larger than reactive's except `maxSubtasks`, and that
 * asymmetry is the point. A coding round is slow — a container boot, an install,
 * a test suite — so turns and wall clock have to be generous or the agent is
 * killed mid-build. But coding subtasks are *heavy*, not numerous: eight parallel
 * subagents editing one checkout is a merge conflict, not fan-out.
 *
 * `toolOutputWindow` is wider than reactive's because a build log the model can
 * no longer see is a build log it will run again. `roundObservationWindow` is
 * wider for the same reason one round further out: a coding task is a long
 * sequence of rounds against one checkout, so what the round before last found —
 * a failing test, a refused clone, a missing manifest — is still true, and
 * rediscovering it costs a container round trip rather than a token.
 *
 * The model is the shared `MODEL`. Do not point it at a Claude model: reaching
 * one on a subscription credential is what `claude-coder` exists for and needs
 * a whole container to do safely; see `src/agents/claude-coder/agent.ts`.
 */
export const CODER_CONFIG: CoreConfigOverrides = {
  model: MODEL,
  // The deferral allowance, and the coding agents are the only ones that have
  // one. It exists for a specific wait: a pull request is opened, a review is
  // requested automatically, and it lands somewhere between two and five minutes
  // later — so the work is not finished, nothing has failed, and there is nobody
  // to ask. Every other agent here either answers or hands off, and waiting would
  // only be a way to take longer.
  //
  // Sized against that wait rather than round: 30 seconds is the floor a review
  // is worth polling at, fifteen minutes is when one that never started is not
  // going to, and 30 of those checks is the fifteen minutes. The allowance is
  // twice that because one task legitimately opens more than one pull request,
  // and running out mid-wait costs the agent the answer it was two checks from.
  //
  // The *time* is free: it is not charged to `maxWallMs`, since a parked round
  // holds nothing. The *checks* are not. Every round is charged its turns, the
  // one that waits and each one that wakes to look, and a poll is about two —
  // the status check and the `check_back` call. So a review polled every 30
  // seconds for its full fifteen minutes spends about 60 turns, and `maxTurns` is
  // twice the coder's working budget to carry one such wait beside the work
  // rather than instead of it. That also makes turns, not `maxDeferrals`, the
  // bound a long run of short polls meets first; a model that picks its wait
  // from how fast the thing changes spends fewer of them.
  //
  // Both deferral bounds must be positive or the tool is not offered at all, and
  // `roundObservationWindow` must be too, since that is what carries the record
  // of having waited into the round that wakes.
  mainAgentLimits: {
    maxTurns: 120,
    maxWallMs: 3 * 60 * 60_000,
    maxDeferrals: 60,
    maxDeferredMs: 30 * 60_000
  },
  subagentLimits: { maxTurns: 80, maxWallMs: 90 * 60_000 },
  toolOutputWindow: 6,
  roundObservationWindow: 3,
  maxSubtasks: 4,
  session: {
    memoryMaxTokens: 2_000,
    compactAfterTokens: 60_000,
    compactTailTokens: 12_000
  }
};

/**
 * The claude-coder agent: the coder's shape, with the *work* done elsewhere.
 *
 * The parent round loop is Workers AI like every other agent here — it
 * orchestrates, reviews and talks to the user, and none of that needs a frontier
 * model. What is different is that its subtasks do not run core's tool loop at
 * all: each one is a Claude Code session inside the workspace container, driven
 * by `@dynamicagents/plugins/claude-code`. See {@link CLAUDE_CODE_SESSION} for the
 * numbers that bound *that*, which are not these.
 *
 * `maxSubtasks: 1`, and it is the one value here worth arguing about.
 *
 * Every other delegating agent in this repo fans out. This one must not, and the
 * reason is the shared checkout: two Claude Code sessions in one container are
 * two autonomous agents editing one working tree, each running the project's
 * test suite over the other's half-finished edits. The coder only *advises* its
 * model against this because its subagents are short and closely briefed; here
 * they are long and unsupervised, so the advice becomes a limit.
 *
 * Raise it only alongside a story for how two sessions avoid each other.
 */
export const CLAUDE_CODER_CONFIG: CoreConfigOverrides = {
  ...CODER_CONFIG,
  maxSubtasks: 1
};

/**
 * What bounds one Claude Code session — and **this is the whole list**.
 *
 * Worth being explicit, because the obvious place to look is wrong. Core's
 * `subagentLimits.maxWallMs` and the recipe's own `limits` do **not** apply:
 * they are metered by the resumable runner, and this agent's `executeChunk`
 * bypasses it entirely to drive the CLI instead. A limit written there is inert.
 *
 * Nor is there a spend cap, deliberately — an estimate in dollars is a guess
 * about a subscription bucket nobody can read, and the egress gateway reads the bucket
 * directly, rotating credentials when Anthropic says one is spent. That bounds
 * the deployment, not a session.
 *
 * So `timeoutMs` is the ceiling, and the container runtime enforces it.
 */
export const CLAUDE_CODE_SESSION = {
  /**
   * Opus 5, deliberately: reaching it on a subscription credential is the whole
   * reason this agent exists, so spending the bucket on something cheaper would
   * be paying the setup cost and declining the return.
   *
   * The cost is worth stating. A 5-hour bucket is roughly $10 of
   * Opus-equivalent and a substantial coding subtask is plausibly $1-5, so
   * expect two to four per bucket per credential. `claude-sonnet-5` stretches
   * that several times further if a deployment would rather have volume.
   */
  model: "claude-opus-5",

  /**
   * `xhigh`, the level above Opus 5's own default of `high`.
   *
   * Same argument as the model. The bucket is spent either way once a session
   * starts, and the failure that costs a deployment real time is not an
   * expensive subtask — it is a cheap one that half-finishes and leaves a
   * checkout somebody has to read before the next round can use it. Depth is
   * what stops that.
   *
   * It is bought, not free: per turn, so it compounds over a session, at a
   * multiple `@dynamicagents/plugins/claude-code` documents. Against the
   * estimate above, expect nearer two substantial subtasks per bucket than
   * four. Drop to `high` for volume, the way `claude-sonnet-5` is for the
   * model.
   *
   * Spelled as a level the CLI knows, because one it does not know is **warned
   * about on stderr and ignored** — the session then runs at the default and
   * nothing downstream says so. `EffortLevel` in
   * `@dynamicagents/plugins/claude-code` is the type that catches that.
   */
  effort: "xhigh",

  /**
   * Forty minutes, and **this is the ceiling on a session** — see above.
   *
   * Longer than the workspace base's twenty-minute default container-idle
   * window, so `ClaudeCoderWorkspaceDO` raises its own above this value —
   * derived from this constant, so the two cannot drift.
   *
   * That derivation is the point: a session stays detached for its whole
   * timeout, so anything narrower makes the container's survival depend on
   * chunk boundaries arriving on time, and one retried or delayed chunk stops
   * it under live work.
   */
  timeoutMs: 40 * 60_000,

  /**
   * Caps on Claude Code's own subagent tree, and advisory rather than enforced:
   * that tree is invisible to Dynamic Agents' scheduler and multiplies whatever
   * they say. `timeoutMs` is what actually stops a run.
   *
   * No turn ceiling sits beside them because there is none to set —
   * `@dynamicagents/plugins/claude-code` does not pass `--max-turns` at all, and
   * its README carries the reason.
   */
  maxSubagentDepth: 1,
  maxConcurrentSubagents: 4,

  /**
   * How the session answers its own permission prompts.
   *
   * The plugin already defaults to this value, so the line is redundant in the
   * sense that deleting it changes nothing today. It is here because the block
   * above claims to be **the whole list** of what bounds a session, and a
   * setting this consequential resolving somewhere a reader of this file cannot
   * see would make that claim false.
   *
   * `bypassPermissions` because `claude -p` is headless: there is nobody to
   * answer a prompt, so any mode that would ask **auto-denies** instead. On the
   * CLI's default a session reads the repository perfectly, cannot change one
   * byte of it, and reports prose that reads like considered reluctance rather
   * than a blocked tool — it exits 0 and the subtask is recorded as completed.
   * This deployment lost a day to exactly that, with the container working fine
   * underneath it.
   *
   * The container is the reason bypassing is acceptable rather than merely
   * convenient: it holds no credential — the egress gateway swaps the real one
   * in on the Worker side — and `npm ci` already runs whatever `postinstall` a
   * cloned repository ships. Containment is the credential swap.
   */
  permissionMode: "bypassPermissions"
} as const satisfies Omit<ClaudeCodeConfig, "credentials" | "workspaceName">;

/**
 * The proactive agent: single-turn, no delegation, so most of the delegation
 * config above is inert for it and left at core's baseline.
 *
 * Its fallback is chosen for **latency rather than depth** — this agent answers
 * in one turn in a live channel, where a fast adequate reply beats a strong one
 * arriving after the conversation moved on. The opposite trade from reactive,
 * whose fallback still has to hold a delegating round together.
 *
 * `compactAfterTokens` is far higher because a channel conversation is long and
 * cheap per message, unlike a delegating agent's branch results.
 */
export const PROACTIVE_CONFIG: CoreConfigOverrides = {
  model: { ...MODEL, fallbackChatModelId: "@cf/google/gemma-4-26b-a4b-it" },
  session: {
    memoryMaxTokens: 1200,
    compactAfterTokens: 60_000,
    compactTailTokens: 5_000
  }
};

/**
 * The proactive loop's step ceiling — starter-owned, not a `CoreConfig` field.
 * Core ships `AgentLimits` in turns and wall-clock because those are the only
 * currencies both loops agreed on; reactive meters a mutable `TurnBudget` across
 * rounds instead, and neither shape belongs to core.
 */
export const MAX_STEPS = 8;

/**
 * `@dynamicagents/plugins/recall` tuning.
 *
 * The embedding model's output dimension and metric must match the Vectorize
 * index (`--dimensions=1024 --metric=cosine`). Changing the model means
 * recreating the index.
 */
export const RECALL = {
  embeddingModelId: "@cf/baai/bge-m3",
  topK: 5,
  /**
   * Max chars of a message stored in its vector metadata, under Vectorize's
   * ~10 KiB/vector limit. Recall returns this snippet plus provenance, not the
   * full original message.
   */
  metadataTextMax: 2000
} as const satisfies RecallTuning;

/**
 * `@dynamicagents/plugins/triage` tuning — the proactive agent's pre-turn gate.
 *
 * A small, fast model on purpose: it runs in front of *every* message the agent
 * sees, most of which are not for it, and its verdict is a single boolean.
 */
export const TRIAGE = {
  modelId: "@cf/qwen/qwen3-30b-a3b-fp8",
  historyMessages: 12,
  messageMaxChars: 500
} as const satisfies TriageTuning;

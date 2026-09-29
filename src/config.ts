// Type-only, so nothing reaches a bundle. It is what makes a mistyped or renamed
// session field fail at `tsc`: a key a plugin type does not declare is an error
// written inline and no error at all through a spread, so the constant below is
// checked with `as const satisfies`, which checks the shape while keeping the
// literal types.
import type { ClaudeCodeConfig } from "@dynamicagents/plugins/claude-code";

/**
 * Every value this Worker tunes, in one file.
 *
 * Plain exported values rather than anything resolved at import time: on
 * Workers there is no `env` at module scope, and the classes read these when an
 * object runs. Core ships no numbers, so each one here is chosen.
 */

/** What one agent tunes: its model, and when its conversation compacts. */
export interface AgentTuning {
  /**
   * The Workers AI model. It must call tools reliably over a long context,
   * because a turn ends when the model stops calling them.
   */
  modelId: string;
  /** Compact once the conversation's estimate crosses this. */
  compactAfterTokens: number;
  /** The recent tail compaction keeps verbatim. */
  keepRecentTokens: number;
}

/**
 * The generic agent. Tight on purpose: a delegating agent accumulates
 * sub-agent results fast.
 */
export const GENERIC: AgentTuning = {
  modelId: "@cf/zai-org/glm-5.3-flash",
  compactAfterTokens: 16_000,
  keepRecentTokens: 5_000
};

/**
 * `coding`. Wider than generic's, for one reason: what the model can no
 * longer see it pays a container round trip to rediscover.
 *
 * Do not point the model at a Claude model: reaching one on a subscription
 * credential is what `anthropic-coding` exists for, and it needs a whole container
 * to do safely; see `src/agents/anthropic-coding/agent.ts`.
 */
export const CODING: AgentTuning = {
  modelId: "@cf/zai-org/glm-5.3-flash",
  compactAfterTokens: 60_000,
  keepRecentTokens: 12_000
};

/**
 * `anthropic-coding`: `coding`'s shape, with the work done elsewhere.
 *
 * **The full-size model, not the flash one.** The parent does no work of its
 * own: it reads diffs and decides what to delegate, so every turn it spends is a
 * decision about a container boot and a Claude Code session, paid for at that
 * price rather than a retry's.
 *
 * **The fan-out is bounded by containers, not by this file.** A writing session
 * works in a worktree of its own, so N writers cost N+1 container instances,
 * counting the parent's workspace. The wrangler ceiling is per container entry
 * across the deployment; past it a workspace fails to start, and
 * `npm run cf -- containers` is what shows it.
 */
export const ANTHROPIC_CODING: AgentTuning = {
  ...CODING,
  modelId: "@cf/zai-org/glm-5.3"
};

/**
 * What bounds one Claude Code session, and **this is the whole list**.
 *
 * There is no spend cap, deliberately: an estimate in dollars is a guess about
 * a subscription bucket nobody can read, and the egress gateway reads the
 * bucket directly, rotating credentials when Anthropic says one is spent. That
 * bounds the deployment, not a session. So `timeoutMs` is the ceiling, and the
 * container runtime enforces it.
 */
export const CLAUDE_CODE_SESSION = {
  /**
   * Opus 5, deliberately: reaching it on a subscription credential is the whole
   * reason this agent exists, so spending the bucket on something cheaper would
   * be paying the setup cost and declining the return.
   *
   * A 5-hour bucket is roughly $10 of Opus-equivalent and a substantial coding
   * session is plausibly $1-5, so expect two to four per bucket per credential.
   * `claude-sonnet-5` stretches that several times further if a deployment would
   * rather have volume.
   */
  model: "claude-opus-5",

  /**
   * `xhigh`, the level above Opus 5's own default of `high`. Same argument as
   * the model: the bucket is spent either way once a session starts, and what
   * costs a deployment real time is not an expensive session but a cheap one
   * that half-finishes and leaves a checkout somebody has to read before the
   * next can use it.
   *
   * It is bought per turn, so it compounds over a session, at a multiple
   * `@dynamicagents/plugins/claude-code` documents. Drop to `high` for volume,
   * the way `claude-sonnet-5` is for the model.
   *
   * Spelled as a level the CLI knows, because one it does not know is **warned
   * about on stderr and ignored**. `EffortLevel` is the type that catches that.
   */
  effort: "xhigh",

  /**
   * Forty minutes, and **this is the ceiling on a session**.
   *
   * Longer than the workspace base's twenty-minute container-idle window, so
   * `AnthropicCodingWorkspace` derives its own from this constant rather than
   * restating it: a session stays detached for its whole timeout, and nothing
   * touches the workspace object while it runs.
   */
  timeoutMs: 40 * 60_000,

  /**
   * Caps on Claude Code's own subagent tree, and advisory rather than enforced:
   * that tree is invisible to this Worker and multiplies whatever they say.
   * `timeoutMs` is what actually stops a run.
   *
   * No turn ceiling sits beside them because there is none to set —
   * `@dynamicagents/plugins/claude-code` does not pass `--max-turns` at all, and
   * its README carries the reason.
   */
  maxSubagentDepth: 1,
  maxConcurrentSubagents: 4,

  /**
   * How the session answers its own permission prompts. The plugin already
   * defaults to this value; the line is here because the block above claims to
   * be **the whole list**, and a setting this consequential resolving out of
   * sight would make that claim false.
   *
   * `bypassPermissions` because `claude -p` is headless: there is nobody to
   * answer a prompt, so any mode that would ask **auto-denies** instead. On the
   * CLI's default a session reads the repository perfectly, cannot change one
   * byte of it, and reports prose that reads like considered reluctance rather
   * than a blocked tool — it exits 0 and the run is recorded as completed.
   *
   * The container is what makes bypassing acceptable rather than merely
   * convenient: it holds no credential — the egress gateway swaps the real one
   * in on the Worker side — and `npm ci` already runs whatever `postinstall` a
   * cloned repository ships. Containment is the credential swap.
   */
  permissionMode: "bypassPermissions"
  // The credentials are the host's to answer, not a setting: see
  // `src/agents/anthropic-coding/claude-code.ts`.
} as const satisfies Omit<ClaudeCodeConfig, "credentials">;

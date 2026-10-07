// Type-only, so nothing reaches a bundle. It is what makes a mistyped or renamed
// session field fail at `tsc`: a key a plugin type does not declare is an error
// written inline and no error at all through a spread, so the constant below is
// checked with `as const satisfies`, which checks the shape while keeping the
// literal types.
import type { ClaudeCodeConfig } from "@dynamicagents/plugins/claude-code";
import type { WorkspaceObjectConfig } from "@dynamicagents/plugins/workspace";

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
  /**
   * The model compaction summarizes with, and the turn waits for it. Flash
   * where the prompt it summarizes stays small; the full-size model where it
   * does not, because flash has timed out (`408` / `3046`, after ~235 s) on
   * every summary of a ~275 KB conversation, while glm-5.3 reads a
   * 111k-token uncached prompt in ~34 s.
   */
  compactionModelId: string;
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
  compactionModelId: "@cf/zai-org/glm-5.3-flash",
  compactAfterTokens: 16_000,
  keepRecentTokens: 5_000
};

/**
 * `coding`. Wider than generic's, for one reason: what the model can no
 * longer see it pays a container round trip to rediscover.
 *
 * Do not point the model at a Claude model: reaching one on a subscription
 * credential is what `claude-coordinator` exists for, and it needs a whole container
 * to do safely; see `src/agents/claude-coordinator/agent.ts`.
 */
export const CODING: AgentTuning = {
  modelId: "@cf/zai-org/glm-5.3-flash",
  compactionModelId: "@cf/zai-org/glm-5.3",
  compactAfterTokens: 240_000,
  keepRecentTokens: 12_000
};

/**
 * `claude-coordinator`: `coding`'s shape, with the work done elsewhere.
 *
 * **The flash model, like `coding`.** The full-size `glm-5.3` answers a share of
 * calls with `429` / `3040` "Capacity temporarily exceeded", and nothing falls
 * back to another model on it: Think takes one model per turn, and
 * `@dynamicagents/core/model` ships no fallback.
 *
 * **The fan-out is bounded by containers, not by this file.** A writing session
 * works in a worktree of its own, so N writers cost N+1 container instances,
 * counting the parent's workspace. Nothing in the deployment caps them short of
 * the account's limits — the containers block in `wrangler.jsonc` carries the
 * arithmetic — and `npm run cf -- containers` is what shows it.
 */
export const CLAUDE_COORDINATOR: AgentTuning = { ...CODING };

/**
 * The size a `coding` workspace's container starts at — 2 vCPU, 6 GiB, 8 GB
 * disk — and the base of {@link CLAUDE_COORDINATOR_WORKSPACE_INSTANCE}. Asked for
 * on every start, so changing it replaces each running container when its
 * workspace next connects.
 *
 * Deliberately not `lite`, the runtime's default: that is a size for trying
 * containers and cannot build a real project.
 *
 * The CPU is the exposure, and it was measured: on standard-1 (1/2 vCPU,
 * 4 GiB) a one-line README change took 59 minutes, of which 52 were spent at
 * **0.0% of Worker CPU** — the Worker was asleep awaiting this container the
 * whole time. `npm run check` on the target repo is five sequential tools
 * including two full `tsc` runs; it is recorded at 28 s in
 * `src/workspace/install-plan.ts` and was observed taking 3-5 minutes here.
 *
 * What wants the second core is the build itself: it is what the measurement
 * above is about, and the work is inside the container where the Worker cannot
 * help.
 *
 * It is not the more expensive choice it looks like. Cloudflare bills memory and
 * disk on *provisioned* resources for as long as an instance runs, but CPU on
 * *active usage* — so on CPU-bound work a second core costs the same vCPU-
 * seconds over less wall-clock, and the memory-seconds fall with the duration.
 * Verify that against `npm run cf -- containers` rather than trusting it.
 *
 * Memory is what to trim, because it bills for the whole run. Observed peaks
 * are ~5 GiB and ~4 GB of disk, so 6 GiB is thin headroom: a workspace killed
 * for memory means raise `memoryMib` first. More cores are not free either —
 * a custom size needs at least 3 GiB per vCPU.
 */
export const WORKSPACE_INSTANCE: WorkspaceObjectConfig["instance"] = {
  vcpu: 2,
  memoryMib: 6144,
  diskMb: 8000
};

/**
 * `claude-coordinator`'s size: {@link WORKSPACE_INSTANCE} with four cores.
 *
 * About half of a writing session's wall-clock is the target's checks and
 * tests, one process each, which no number of containers speeds up. The same
 * suite took ~200 s here at 2 vCPU and 80 s on a 4-vCPU CI runner. Four is the
 * custom-size ceiling, and its 3 GiB-per-vCPU floor sets the memory, which
 * bills for the whole run.
 */
export const CLAUDE_COORDINATOR_WORKSPACE_INSTANCE: WorkspaceObjectConfig["instance"] =
  { ...WORKSPACE_INSTANCE, vcpu: 4, memoryMib: 12288 };

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
   * `ClaudeCoordinatorWorkspace` derives its own from this constant rather than
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
  // `src/agents/claude-coordinator/claude-code.ts`.
} as const satisfies Omit<ClaudeCodeConfig, "credentials">;

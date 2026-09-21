import type { AgentPlugin, CoreConfigOverrides } from "@dynamicagents/core";
import type { PluginHost } from "@dynamicagents/core/host";
import {
  RoundAgentBase,
  type RoundPolicy,
  type SubagentClass
} from "@dynamicagents/core/round";
import { CLAUDE_CODER_CONFIG } from "@/config";
import { claudeCoder } from "./definition";
import { roundPolicy } from "@/round-policy";
import { activeRepo } from "@/workspace/active-repo";
import { discardWorkingTree, sweepIdleWorkspaces } from "@/workspace/lifecycle";
import { workspaceName } from "@dynamicagents/plugins/computer";
import {
  forgetWorktree,
  idleWorktrees,
  parseWorktreeRepo,
  sqlPoolStore
} from "@/workspace/worktree-pool";
import { parentPlugins } from "./plugins";
import { soulPrompt } from "./soul";
import { ClaudeCoderSubagent } from "./subagent";

/** This agent's log prefix and workspace label. */
const LABEL = "claude-coder";

/**
 * The claude-coder agent — the coder's sibling, with a different engine.
 *
 * The parent is an ordinary Dynamic Agents round agent on Workers AI: it clones,
 * reviews diffs, commits, pushes and opens pull requests, and it has no shell,
 * no editor and no way to write a file. What is different is one level down.
 * Its subtasks do not run core's tool loop; each is a Claude Code session inside
 * this agent's own container, against the same durable checkout. See
 * `./subagent.ts`.
 *
 * That exists because a Claude **subscription** credential 429s at zero tokens
 * against the raw Messages API on every frontier model, and the same credential
 * answers through the sanctioned client. The harness is the unlock — so the way
 * to reach Opus on a subscription is to run the client, and the way to do that
 * safely is to keep the credential on this side of the container boundary. The
 * overrides below are all lifecycle, exactly as in `../coder/agent.ts`.
 */
export class ClaudeCoderAgent extends RoundAgentBase<Env> {
  protected agentConfig(): CoreConfigOverrides {
    return { ...CLAUDE_CODER_CONFIG, agentName: claudeCoder.tenant };
  }

  /**
   * The **parent's** list, which is not the subagent's — see `plugins.ts`. The
   * asymmetry is starker here than in the coder: the subagent's list is one
   * entry, because a Claude Code session brings its own tools.
   */
  protected agentPlugins(host: PluginHost<Env>): AgentPlugin[] {
    return parentPlugins(host);
  }

  protected agentSoul(capabilities: string): string {
    return soulPrompt(capabilities);
  }

  /** The words the loop says — shared with the other round agents. */
  protected roundPolicy(): RoundPolicy {
    return roundPolicy;
  }

  protected subagentClass(): SubagentClass {
    return ClaudeCoderSubagent;
  }

  /**
   * Register the workspace reclaim sweep alongside core's own cleanup cron.
   *
   * A backstop for the one wake intent a workspace cannot heal itself — see
   * `sweepIdleWorkspaces`. `super.onStart()` first: core registers its own
   * weekly task cleanup there, and both schedules coexist.
   */
  override async onStart(): Promise<void> {
    await super.onStart();
    const existing = await this.listSchedules({ type: "cron" });
    if (!existing.some((s) => s.callback === "reclaimIdleWorkspaces")) {
      // Sunday 03:00 UTC — an hour after the coder's, which is an hour after
      // core's, so no two sweeps contend for the same instance.
      await this.schedule("0 3 * * 0", "reclaimIdleWorkspaces", {});
    }
  }

  /** Cron handler, delegating to the shared sweep. */
  async reclaimIdleWorkspaces(): Promise<void> {
    const host = this.pluginHost();
    const pool = sqlPoolStore(host.storage);
    await sweepIdleWorkspaces({
      host,
      binding: this.env.CLAUDE_CODER_WORKSPACE,
      label: LABEL,
      // A worktree the sweep retired has no checkout left, so its row goes back
      // to empty: the slot is cloned into again rather than trusted.
      onReclaimed: (repo) => forgetWorktree(pool, repo)
    });
  }

  /**
   * Discard a cancelled task's half-finished edits — without discarding the
   * workspace.
   *
   * The reasoning is on `discardWorkingTree`. It matters more here than for the
   * coder: a cancelled Claude Code session is stopped mid-turn with `SIGTERM`
   * (see `subagent.ts`), so the tree it leaves is whatever it had reached, and
   * the checkout outlives the task.
   *
   * **The `super` call is load-bearing ordering, not politeness.** SIGTERM is
   * chosen because Claude Code does more work after it — its `SessionEnd` hooks,
   * its process tree, its exit — and the container-to-workspace sync is driven
   * by the facet's drain reaching `done`, not by the signal. So a reset issued
   * as soon as the signal was delivered can be followed by a sync carrying files
   * the session wrote afterwards, leaving the tree this exists to clean in an
   * arbitrary half-reset state. `ClaudeCoderSubagent.abortRun` therefore does
   * not return until that drain has unwound, which is what makes the reset below
   * safe to run. Anything that reorders these two lines, or that stops awaiting
   * `abortRun`, reopens it.
   */
  protected override async onTaskCanceled(taskId: string): Promise<void> {
    await super.onTaskCanceled(taskId);
    const repo = activeRepo(this.pluginHost()).get();
    await discardWorkingTree({
      binding: this.env.CLAUDE_CODER_WORKSPACE,
      name: workspaceName(this.#identityKeyOrTask(taskId), repo),
      repo,
      label: LABEL
    });
  }

  /**
   * The task is over — stop paying for the container it was working in.
   *
   * The idle deadline would eventually do this, but it cannot be tuned down to
   * meet the cost: it has to exceed the longest command the agent allows, which
   * here is a session that runs for its whole forty minutes. So a container
   * outlives its task by that much unless something says the work is finished,
   * and this is that. The deadline stays as the backstop for a task that dies
   * without unwinding.
   *
   * **Released, not reclaimed**, and the difference is the point: the checkout and
   * the dependency tree stay, so the next task on this repository skips a clone
   * and a full install. `reclaimIfIdle` here would look identical and cost that
   * silently. The workspace host carries the distinction.
   *
   * **Tools left in a worktree come back to the checkout**, and every worktree
   * no session is in has its container released too: each stays up after its
   * subtask so the parent can review in it, and at the end of the task nothing
   * is left to review. The worktrees themselves — branches, commits — stay; see
   * `@/workspace/worktrees`.
   *
   * Core contains a throw here, but this is best-effort on its own account too: a
   * container that will not stop is the idle deadline's problem, not the answer's.
   */
  protected override async onTaskSettled(taskId: string): Promise<void> {
    const active = activeRepo(this.pluginHost());
    const repo = active.get();
    const worktree = repo === undefined ? undefined : parseWorktreeRepo(repo);
    if (worktree) active.set(worktree.repo);
    const binding = this.env.CLAUDE_CODER_WORKSPACE;
    const key = this.#identityKeyOrTask(taskId);
    const names = new Set([
      workspaceName(key, repo),
      ...(worktree ? [workspaceName(key, worktree.repo)] : []),
      ...idleWorktrees(sqlPoolStore(this.pluginHost().storage)).map(
        (sentinel) => workspaceName(key, sentinel)
      )
    ]);
    for (const name of names) {
      try {
        await binding.get(binding.idFromName(name)).releaseContainer();
      } catch (err) {
        console.warn(`[${LABEL}] could not release the workspace container`, {
          name,
          err: String(err)
        });
      }
    }
  }

  /**
   * The caller key, resilient to being called before a caller is known.
   *
   * Cancellation can arrive on an instance that has not served a turn, where
   * `callerKey` throws. Falling back to the task id is wrong-but-harmless: it
   * addresses a workspace nobody has ever used rather than someone else's.
   */
  #identityKeyOrTask(taskId: string): string {
    try {
      return this.pluginHost().callerKey();
    } catch {
      return taskId;
    }
  }
}

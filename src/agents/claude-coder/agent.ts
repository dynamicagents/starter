import type {
  ThinkModel,
  ThinkScheduledTasks,
  TurnConfig,
  TurnContext
} from "@cloudflare/think";
import type { AgentPlugin } from "@dynamicagents/core";
import { A2AAgent } from "@dynamicagents/core/agent";
import type { SubAgentClass } from "@dynamicagents/core/subagent";
import { computerWorkspace } from "@dynamicagents/plugins/computer";
import { workspaceName } from "@dynamicagents/plugins/workspace";
import type { AgentToolLifecycleResult, AgentToolRunInfo } from "agents";
import type { ContextConfig } from "agents/context";
import type { LanguageModel, ToolSet } from "ai";
import { CLAUDE_CODER } from "@/config";
import { copy } from "@/copy";
import { agentModel } from "@/model";
import { activeRepo } from "@/workspace/active-repo";
import { WORKSPACE_WRITERS } from "@/workspace/container";
import { discardWorkingTree, sweepIdleWorkspaces } from "@/workspace/lifecycle";
import {
  forgetWorktree,
  idleWorktrees,
  parseWorktreeRepo,
  reconcileWorktrees,
  sqlPoolStore
} from "@/workspace/worktree-pool";
import {
  ClaudeCoderReader,
  ClaudeCoderSession,
  forgetKept,
  keptNote
} from "./children";
import { claudeCoder } from "./definition";
import { container, parentPlugins, sessionWorkspaces } from "./plugins";
import { MEMORY, SOUL } from "./soul";

/** This agent's log prefix and workspace label. */
const LABEL = "claude-coder";

/**
 * The claude-coder agent — cf-coder's sibling, with a different engine.
 *
 * The parent is an ordinary agent on Workers AI: it clones, reviews diffs,
 * commits, pushes and opens pull requests, and it has no shell, no editor and
 * no way to write a file. What is different is one level down: each sub-agent
 * is a Claude Code session inside a workspace container. See `./children.ts`.
 *
 * That exists because a Claude **subscription** credential 429s at zero tokens
 * against the raw Messages API on every frontier model, and the same credential
 * answers through the sanctioned client. The harness is the unlock — so the way
 * to reach Opus on a subscription is to run the client, and the way to do that
 * safely is to keep the credential on this side of the container boundary.
 */
export class ClaudeCoder extends A2AAgent<Env> {
  protected readonly copy = copy;
  protected readonly compactAfterTokens = CLAUDE_CODER.compactAfterTokens;
  protected readonly keepRecentTokens = CLAUDE_CODER.keepRecentTokens;

  /**
   * Which repository the caller is working on — or which worktree the parent
   * switched into. One instance for the object: it caches what it last read,
   * and the plugins and the workspace below must agree on it.
   */
  readonly #active = activeRepo(this.ctx.storage);
  readonly #container = container(this.env, () =>
    workspaceName(this.callerKey(), this.#active.get())
  );

  /** Think's file tools, over the checkout rather than this object's SQLite. */
  override workspace = computerWorkspace(this.#container);
  /**
   * Off, because the parent has no shell: Think's own `bash` would run over the
   * same workspace and could write anything the file tools are kept from.
   */
  override workspaceBash = false as const;

  override getModel(): ThinkModel {
    return agentModel(
      this.env,
      { modelId: CLAUDE_CODER.modelId, name: this.name },
      { agent: claudeCoder.tenant, taskId: this.turnTaskId(), phase: "turn" }
    );
  }

  /** Compaction runs over a history every task shares, so it has no task. */
  protected override compactionModel(): LanguageModel {
    return agentModel(
      this.env,
      { modelId: CLAUDE_CODER.modelId, name: this.name },
      { agent: claudeCoder.tenant, phase: "compaction" }
    );
  }

  override configureContext(): ContextConfig[] {
    return [
      { label: "soul", provider: { get: async () => SOUL } },
      { label: "memory", description: MEMORY },
      ...super.configureContext()
    ];
  }

  override getPlugins(): AgentPlugin<Env>[] {
    return parentPlugins(
      this.env,
      { storage: this.ctx.storage, callerKey: () => this.callerKey() },
      this.#active,
      this.#container
    );
  }

  /** Writing first: the order the delegating model is shown them. */
  override getSubAgents(): SubAgentClass[] {
    return [ClaudeCoderSession, ClaudeCoderReader];
  }

  /** `check_back`, for the wait between opening a pull request and its review. */
  override getTools(): ToolSet {
    return { ...super.getTools(), check_back: this.checkBackTool() };
  }

  /** The turn core configures, minus Think's own file writers. */
  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    const base = await super.beforeTurn(ctx);
    return {
      ...base,
      activeTools: Object.keys(ctx.tools).filter(
        (name) => !WORKSPACE_WRITERS.has(name)
      )
    };
  }

  /** A failed run's report, with where its work was kept — see `./children.ts`. */
  protected override formatDetachedCompletion(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): string {
    const text = super.formatDetachedCompletion(run, result);
    const kept = keptNote(this.ctx.storage, run.runId);
    return kept ? `${text}\n\n${kept}` : text;
  }

  /**
   * The workspace reclaim sweep — an hour after cf-coder's, which is an hour
   * after core's, so no two sweeps contend for the same instance — and then the
   * pool reconciled against what is actually still there.
   *
   * The second half is not a tidy-up of the first. `onReclaimed` fires only for
   * a workspace *this sweep* retired, and a worktree's own idle alarm beats the
   * weekly sweep to almost all of them; `reconcileWorktrees` carries what that
   * leaves behind and why it matters.
   */
  override getScheduledTasks(): ThinkScheduledTasks {
    return {
      ...super.getScheduledTasks(),
      reclaimIdleWorkspaces: {
        schedule: "every week on sunday at 03:00 in UTC",
        handler: () => this.#reclaim()
      }
    };
  }

  async #reclaim(): Promise<void> {
    const pool = sqlPoolStore(this.ctx.storage);
    const binding = this.env.CLAUDE_CODER_WORKSPACE;
    const key = this.callerKey();
    await sweepIdleWorkspaces({
      storage: this.ctx.storage,
      callerKey: key,
      binding,
      label: LABEL,
      // A worktree the sweep retired has no checkout left, so its row goes back
      // to empty: the slot is cloned into again rather than trusted.
      onReclaimed: (repo) => forgetWorktree(pool, repo)
    });
    await reconcileWorktrees(pool, async (sentinel) => {
      const name = workspaceName(key, sentinel);
      try {
        return Boolean(
          await binding.get(binding.idFromName(name)).checkoutDir()
        );
      } catch (err) {
        // Unreadable is not gone: a row is emptied on an answer, never on a
        // failure to get one, so an unreachable object keeps its slot.
        console.warn(`[${LABEL}] could not read a worktree's checkout`, {
          name,
          err: String(err)
        });
        return true;
      }
    });
  }

  /**
   * Discard a canceled task's half-finished edits in the checkout the parent's
   * tools point at — without discarding the workspace. The reasoning is on
   * `discardWorkingTree`. A writing session's own worktree is its `settle`'s to
   * reset, and a reading session works in a copy its stop deletes.
   */
  protected override async onTaskCanceled(taskId: string): Promise<void> {
    await super.onTaskCanceled(taskId);
    const repo = this.#active.get();
    await discardWorkingTree({
      binding: this.env.CLAUDE_CODER_WORKSPACE,
      name: workspaceName(this.callerKey(), repo),
      repo,
      label: LABEL
    });
  }

  /**
   * The task is over — free what it held, and stop paying for the containers it
   * was working in.
   *
   * **Claims first.** A worktree claimed for a run that never started — the
   * turn was cut between the claim and the dispatch — has no `settle` to free
   * it, and a claim left live is passed over for good.
   *
   * **Released, not reclaimed**, and the difference is the point: the checkout
   * and the dependency tree stay, so the next task on this repository skips a
   * clone and a full install. The idle deadline cannot be tuned down to meet the
   * cost instead: it has to exceed a session's whole forty minutes.
   *
   * **Tools left in a worktree come back to the checkout**, and every worktree
   * no session is in has its container released too: each stays up after its
   * session so the parent can review in it, and at the end of the task nothing
   * is left to review. The worktrees themselves — branches, commits — stay; see
   * `@/workspace/worktrees`.
   *
   * Core contains a throw here, but this is best-effort on its own account too: a
   * container that will not stop is the idle deadline's problem, not the answer's.
   */
  protected override async onTaskSettled(taskId: string): Promise<void> {
    try {
      await sessionWorkspaces(this.pluginContext()).releaseTask(taskId);
    } catch (err) {
      console.warn(`[${LABEL}] could not release a task's worktrees`, {
        taskId,
        err: String(err)
      });
    }
    forgetKept(this.ctx.storage, taskId);

    const repo = this.#active.get();
    const worktree = repo === undefined ? undefined : parseWorktreeRepo(repo);
    if (worktree) this.#active.set(worktree.repo);
    const binding = this.env.CLAUDE_CODER_WORKSPACE;
    const key = this.callerKey();
    const names = new Set([
      workspaceName(key, repo),
      ...(worktree ? [workspaceName(key, worktree.repo)] : []),
      ...idleWorktrees(sqlPoolStore(this.ctx.storage)).map((sentinel) =>
        workspaceName(key, sentinel)
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
}

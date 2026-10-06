import type {
  ThinkModel,
  ThinkScheduledTasks,
  TurnConfig,
  TurnContext
} from "@cloudflare/think";
import type { AgentPlugin } from "@dynamicagents/core";
import { StepAgent } from "@dynamicagents/core/agent";
import type { SubAgentClass } from "@dynamicagents/core/subagent";
import type { StepJob } from "@dynamicagents/core/workflow";
import { computerWorkspace } from "@dynamicagents/plugins/computer";
import { workspaceName } from "@dynamicagents/plugins/workspace";
import type { AgentToolLifecycleResult, AgentToolRunInfo } from "agents";
import type { ContextConfig } from "agents/context";
import type { LanguageModel, ToolSet } from "ai";
import { CLAUDE_COORDINATOR } from "@/config";
import { RETRY_BRIEF } from "@/copy";
import { agentModel } from "@/model";
import { activeRepo } from "@/workspace/active-repo";
import { WORKSPACE_WRITERS } from "@/workspace/container";
import { sweepIdleWorkspaces } from "@/workspace/lifecycle";
import {
  forgetWorktree,
  idleWorktrees,
  parseWorktreeRepo,
  reconcileWorktrees,
  slotOf,
  sqlPoolStore
} from "@/workspace/worktree-pool";
import {
  ClaudeCoordinatorPlannerChild,
  ClaudeCoordinatorReviserChild,
  ClaudeCoordinatorWriterChild,
  forgetKept,
  keptNote
} from "./children";
import { claudeCoordinator } from "./definition";
import { container, parentPlugins, sessionWorkspaces } from "./plugins";
import { ownsPlan } from "./plans";
import { MEMORY, RETRY_WORK, SOUL } from "./soul";

/** This agent's log prefix and workspace label. */
const LABEL = "claude-coordinator";

/**
 * The claude-coordinator agent — `coding`'s sibling, with a different engine.
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
export class ClaudeCoordinatorAgent extends StepAgent<Env> {
  protected readonly compactAfterTokens = CLAUDE_COORDINATOR.compactAfterTokens;
  protected readonly keepRecentTokens = CLAUDE_COORDINATOR.keepRecentTokens;

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
      { modelId: CLAUDE_COORDINATOR.modelId, name: this.name },
      {
        agent: claudeCoordinator.tenant,
        taskId: this.turnTaskId(),
        phase: "turn"
      }
    );
  }

  /** Compaction runs over a history every task shares, so it has no task. */
  protected override compactionModel(): LanguageModel {
    return agentModel(
      this.env,
      { modelId: CLAUDE_COORDINATOR.compactionModelId, name: this.name },
      { agent: claudeCoordinator.tenant, phase: "compaction" }
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

  /** Building, revising, then planning: the order the delegating model is shown them. */
  override getSubAgents(): SubAgentClass[] {
    return [
      ClaudeCoordinatorWriterChild,
      ClaudeCoordinatorReviserChild,
      ClaudeCoordinatorPlannerChild
    ];
  }

  /**
   * Only a plan this caller's agent opened is put to the caller — a link is
   * shared by design, and approving one locks it. See `./plans.ts`.
   */
  protected override async mayAskApproval(id: string): Promise<boolean> {
    return ownsPlan(this.ctx.storage, id) && (await super.mayAskApproval(id));
  }

  /** `check_back`, for the wait between a pull request opening and its review and CI landing. */
  override getTools(): ToolSet {
    return { ...super.getTools(), check_back: this.checkBackTool() };
  }

  /**
   * The turn core configures, minus Think's own file writers: the parent has
   * no editor, and those would write the checkout the sessions' work lands in.
   * Core's own list wins where it sets one: a turn for a job that has ended gets
   * no tools.
   */
  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    const base = await super.beforeTurn(ctx);
    return {
      ...base,
      activeTools:
        base?.activeTools ??
        Object.keys(ctx.tools).filter((name) => !WORKSPACE_WRITERS.has(name))
    };
  }

  /** A retry starts with where its first attempt's work was kept. */
  protected override formatStepJobInput(job: StepJob): string {
    return job.attempt > 1
      ? `${RETRY_BRIEF} ${RETRY_WORK}\n\n${job.input}`
      : job.input;
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
   * The workspace reclaim sweep — an hour after `coding`'s, which is an hour
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
    const binding = this.env.CLAUDE_COORDINATOR_WORKSPACE;
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
    // Reads left in a worktree emptied above would read a checkout that is
    // gone, so they go back to the parent's own — which its context says.
    const reading = parseWorktreeRepo(this.#active.get() ?? "");
    if (reading && !slotOf(pool, reading.repo, reading.slot)?.branch) {
      this.#active.set(reading.repo);
    }
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
   * **Reads left in a worktree stay there**: a person's follow-up is usually
   * about the same work, and moving them here would leave the model's last
   * `repo_worktree` answer describing a place they no longer are — see
   * `@/workspace/worktrees`. Every worktree no session is in has its container
   * released — a backstop, since the pool releases one when its session
   * settles. A read starts it again.
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
    const binding = this.env.CLAUDE_COORDINATOR_WORKSPACE;
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

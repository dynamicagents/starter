import {
  IDLE_RECLAIM_MS,
  workspaceName,
  type WorkspaceObjectBase
} from "@dynamicagents/plugins/workspace";
import type { RepoWorktrees } from "@dynamicagents/plugins/repo";
import type { ActiveRepo } from "./active-repo";
import { selectedRepo } from "./subtask-workspace";
import {
  holderOf,
  parseWorktreeRepo,
  slotOf,
  worktreeRepo,
  type PoolRepo,
  type PoolStore,
  type Worktree
} from "./worktree-pool";

/**
 * The parent's way into the worktrees its writing sessions committed in.
 *
 * A switch is `ActiveRepo.set` with the worktree's sentinel, and that is the
 * whole mechanism: every tool the parent has — `/repo`, the read-only file
 * tools — resolves its workspace from that one selection on
 * each call, the way `scratch_open` already moves them all at once. So no tool
 * learns what a worktree is, and a worktree's checkout sits at the same path the
 * parent's own does.
 *
 * **The selection stays where it was put**, across turns and tasks: a person's
 * follow-up usually asks about the same work. It moves on a switch, a clone, a
 * scratchpad, a release, and when a writing session settles — see `follow` in
 * `./subtask-workspace.ts`. The parent hears of every move through {@link
 * WorktreeSwitch.where}, which its context re-reads each turn, rather than from
 * a `repo_worktree` answer it may be remembering from tasks ago.
 */
export interface WorktreeSwitch extends RepoWorktrees {
  /** Where the parent's file reads and repo tools run now, in its terms. */
  where(): string;
}

/** Days a workspace survives untouched, as the parent is told it. */
const KEPT_DAYS = Math.round(IDLE_RECLAIM_MS / 86_400_000);

/** Where one of a worktree's repositories sits. */
function dirOf(worktree: Worktree, repo: PoolRepo): string {
  return repo.path === "."
    ? (worktree.dir ?? ".")
    : `${worktree.dir}/${repo.path}`;
}

/** What one repository holds of the branch, in a reviewer's terms. */
function repoState(repo: PoolRepo): string {
  if (repo.tip === "") return "has commits nobody has pushed";
  if (repo.tip === repo.base) return "no commits";
  if (repo.tip === repo.pushed) return "pushed";
  return "has commits, not pushed";
}

function summary(worktree: Worktree): string {
  if (worktree.live) {
    return "a session is working in it";
  }
  const changed = worktree.repos.filter((repo) => repo.tip !== repo.base);
  if (changed.length === 0) return "no commits";
  return changed
    .map((repo) => `\`${repo.path}\` ${repoState(repo)}`)
    .join(", ");
}

export function worktreeSwitch(config: {
  active: ActiveRepo;
  pool: PoolStore;
  binding: DurableObjectNamespace<WorkspaceObjectBase>;
  callerKey: () => string;
}): WorktreeSwitch {
  /** The worktree the parent's tools point at now, if they point at one. */
  const current = () => {
    const selected = config.active.get();
    const parsed =
      selected === undefined ? undefined : parseWorktreeRepo(selected);
    if (!parsed) return undefined;
    return {
      repo: parsed.repo,
      row: slotOf(config.pool, parsed.repo, parsed.slot)
    };
  };
  const noRepo =
    "Worktrees belong to a repository checkout, and your tools are not on one — clone it with repo_clone first.";

  return {
    async list(): Promise<string> {
      const repo = selectedRepo(config.active.get());
      if (!repo) return noRepo;
      const rows = config.pool.all(repo).filter((row) => row.branch);
      if (rows.length === 0) {
        return `No worktree holds a branch for ${repo}. Each writing session gets one when it is delegated.`;
      }
      const here = current()?.row?.slot;
      return [
        `Worktrees for ${repo}:`,
        ...rows.map(
          (row) =>
            `- \`${row.branch}\`${row.slot === here ? " (your reads are here)" : ""} — ${summary(row)}`
        ),
        "",
        `A worktree nothing touches for ${KEPT_DAYS} days is deleted, with any commits in it that were never pushed. \`repo_worktree\` with a branch points your reads at it, and \`claude_code\` with \`continue\` set to it carries its work on.`
      ].join("\n");
    },

    async use(branch?: string): Promise<string> {
      if (branch === undefined) {
        const here = current();
        if (!here)
          return "Your file reads and repo tools already run in your own checkout.";
        config.active.set(here.repo);
        const dir = config.active.checkout()?.dir;
        return `Your file reads and repo tools are back on your own checkout${dir ? `, at ${dir}` : ""}.`;
      }
      const repo = selectedRepo(config.active.get());
      if (!repo) return noRepo;
      const row = holderOf(config.pool, repo, branch);
      if (!row) {
        return (
          `No worktree holds \`${branch}\`. If it was pushed, its pull request shows what changed ` +
          "(`repo_pr_view`), and `claude_code` with `continue` set to it puts a session back on it."
        );
      }

      // Claimed, and not yet cloned onto: there is nothing to switch into.
      if (row.dir === undefined) {
        return `The worktree for \`${branch}\` is still being prepared; try again once its session has started.`;
      }

      const sentinel = worktreeRepo(repo, row.slot);
      const stub = config.binding.get(
        config.binding.idFromName(workspaceName(config.callerKey(), sentinel))
      );
      if (!(await stub.checkoutDir())) {
        // Its storage is gone, so the row describes nothing; the slot is free
        // for the next session to clone into again.
        config.pool.put({
          repo,
          slot: row.slot,
          repos: [],
          usedAt: row.usedAt
        });
        return (
          `The worktree that held \`${branch}\` was deleted after ${KEPT_DAYS} days untouched, ` +
          "and its commits went with it unless they were pushed. If they were, delegate with " +
          "`continue` set to the branch to work on it again."
        );
      }

      config.active.set(sentinel);
      return [
        `Your file reads and repo tools now run in the worktree holding \`${branch}\`, at the same paths as your checkout, and stay there until you move them.`,
        ...(row.live
          ? [
              "",
              "**A session is working here now**, so what you read may still change."
            ]
          : []),
        "",
        ...row.repos.map(
          (entry) =>
            `- \`${dirOf(row, entry)}\` — ${repoState(entry)}, since \`${entry.baseRef}\``
        ),
        "",
        "repo_worktree with no branch brings them back to your own checkout."
      ].join("\n");
    },

    async release(branch: string): Promise<string> {
      const repo = selectedRepo(config.active.get());
      if (!repo) return noRepo;
      const row = holderOf(config.pool, repo, branch);
      if (!row) return `No worktree holds \`${branch}\`.`;
      if (row.live) {
        return "A session is working in that worktree. Release it once its report arrives.";
      }
      const unpushed = row.repos.some(
        (entry) => entry.tip !== entry.base && entry.tip !== entry.pushed
      );
      const { branch: _branch, ...rest } = row;
      config.pool.put({ ...rest, previous: branch });
      const wasHere = current()?.row?.slot === row.slot;
      if (wasHere) config.active.set(repo);
      return [
        `Released the worktree that held \`${branch}\`; the next writing session may reset it.`,
        ...(unpushed
          ? ["Commits in it that were never pushed are gone when that happens."]
          : []),
        ...(wasHere
          ? ["Your file reads and repo tools are back on your own checkout."]
          : [])
      ].join(" ");
    },

    where(): string {
      const selected = config.active.get();
      if (selected === undefined) {
        return "Your file reads have nowhere to run yet: open a repository with repo_clone, or a scratchpad with scratch_open.";
      }
      const here = parseWorktreeRepo(selected);
      if (!here) {
        const repo = selectedRepo(selected);
        if (!repo) return "Your file reads run in your scratchpad.";
        const dir = config.active.checkout()?.dir;
        return `Your file reads and repo tools run in your own checkout of ${repo}${dir ? `, at ${dir}` : ""}.`;
      }
      const row = slotOf(config.pool, here.repo, here.slot);
      if (!row?.branch) {
        return `Your file reads and repo tools point at a worktree of ${here.repo} that no longer holds a branch. repo_worktree with no branch brings them back to your own checkout.`;
      }
      return `Your file reads and repo tools run in the worktree holding \`${row.branch}\`, at the same paths as your own checkout of ${here.repo}. repo_worktree moves them.`;
    }
  };
}

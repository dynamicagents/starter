import {
  IDLE_RECLAIM_MS,
  workspaceName,
  type WorkspaceObjectBase
} from "@dynamicagents/plugins/computer";
import type { RepoConfig, RepoWorktrees } from "@dynamicagents/plugins/repo";
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
 * The parent's way into the worktrees its writing subtasks committed in.
 *
 * A switch is `ActiveRepo.set` with the worktree's sentinel, and that is the
 * whole mechanism: every tool the parent has — `/repo`, the read-only sandbox
 * tools, a reading subtask — resolves its workspace from that one selection on
 * each call, the way `scratch_open` already moves them all at once. So no tool
 * learns what a worktree is, and a worktree's checkout sits at the same path the
 * parent's own does.
 *
 * The two write hooks are what a worktree adds to `/repo`'s guards: a session
 * may still be working in it, and a session had a root shell over its
 * `.git/config`.
 */
export interface WorktreeSwitch extends RepoWorktrees {
  beforeWrite: NonNullable<RepoConfig["beforeWrite"]>;
  afterPush: NonNullable<RepoConfig["afterPush"]>;
}

/** Days a workspace survives untouched, as the parent is told it. */
const KEPT_DAYS = Math.round(IDLE_RECLAIM_MS / 86_400_000);

/** Where one of a worktree's repositories sits. */
function dirOf(worktree: Worktree, repo: PoolRepo): string {
  return repo.path === "."
    ? (worktree.dir ?? ".")
    : `${worktree.dir}/${repo.path}`;
}

/** The repository a tool's `dir` names, if it is one of the worktree's. */
function repoAt(worktree: Worktree, dir: string): PoolRepo | undefined {
  const root = worktree.dir?.replace(/\/+$/, "");
  const target = dir.replace(/\/+$/, "");
  if (!root) return undefined;
  if (target === root) return worktree.repos.find((repo) => repo.path === ".");
  if (!target.startsWith(`${root}/`)) return undefined;
  const path = target.slice(root.length + 1);
  return worktree.repos.find((repo) => repo.path === path);
}

/** Two spellings of one remote: case, a trailing slash and `.git` aside. */
function sameRemote(a: string, b: string): boolean {
  const norm = (url: string) =>
    url
      .trim()
      .toLowerCase()
      .replace(/\/+$/, "")
      .replace(/\.git$/, "");
  return norm(a) === norm(b);
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
    return `subtask ${worktree.live.subtaskId} is working in it`;
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
        return `No worktree holds a branch for ${repo}. Each writing subtask gets one when it is delegated.`;
      }
      const here = current()?.row?.slot;
      return [
        `Worktrees for ${repo}:`,
        ...rows.map(
          (row) =>
            `- \`${row.branch}\`${row.slot === here ? " (your tools are here)" : ""} — ${summary(row)}`
        ),
        "",
        `A worktree nothing touches for ${KEPT_DAYS} days is deleted, with any commits in it that were never pushed. \`repo_worktree\` with a branch puts your tools in it.`
      ].join("\n");
    },

    async use(branch?: string): Promise<string> {
      if (branch === undefined) {
        const here = current();
        if (!here) return "Your tools already point at your own checkout.";
        config.active.set(here.repo);
        const dir = config.active.checkout()?.dir;
        return `Your tools are back on your own checkout${dir ? `, at ${dir}` : ""}.`;
      }
      const repo = selectedRepo(config.active.get());
      if (!repo) return noRepo;
      const row = holderOf(config.pool, repo, branch);
      if (!row) {
        return (
          `No worktree holds \`${branch}\`. If it was pushed, review it from your own checkout — ` +
          `\`repo_fetch\`, then \`repo_diff\` with ref \`origin/${branch}\` — or delegate with ` +
          "`continue` set to it to work on it again."
        );
      }

      // Claimed, and not yet cloned onto: there is nothing to switch into.
      if (row.dir === undefined) {
        return `The worktree for \`${branch}\` is still being prepared${row.live ? ` for subtask ${row.live.subtaskId}` : ""}; try again once its session has started.`;
      }

      const sentinel = worktreeRepo(repo, row.slot);
      const stub = config.binding.get(
        config.binding.idFromName(workspaceName(config.callerKey(), sentinel))
      );
      if (!(await stub.checkoutDir())) {
        // Its storage is gone, so the row describes nothing; the slot is free
        // for the next subtask to clone into again.
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
        `Your repo tools and file reads now run in the worktree holding \`${branch}\`, at the same paths as your checkout.`,
        ...(row.live
          ? [
              "",
              `**Subtask ${row.live.subtaskId} is still working here.** Read what you like, but nothing can be committed or pushed until it finishes.`
            ]
          : []),
        "",
        ...row.repos.map(
          (entry) =>
            `- \`${dirOf(row, entry)}\` — ${repoState(entry)}, since \`${entry.baseRef}\``
        ),
        "",
        "Review each with repo_diff, `dir` set to it and `base` set to what it started from. " +
          `Publish one with repo_push and branch \`${branch}\`, then repo_open_pr from the same directory. ` +
          "repo_worktree with no branch brings your tools back to your own checkout."
      ].join("\n");
    },

    async release(branch: string): Promise<string> {
      const repo = selectedRepo(config.active.get());
      if (!repo) return noRepo;
      const row = holderOf(config.pool, repo, branch);
      if (!row) return `No worktree holds \`${branch}\`.`;
      if (row.live) {
        return `Subtask ${row.live.subtaskId} is working in that worktree. Release it once the subtask finishes.`;
      }
      const unpushed = row.repos.some(
        (entry) => entry.tip !== entry.base && entry.tip !== entry.pushed
      );
      const { branch: _branch, ...rest } = row;
      config.pool.put({ ...rest, previous: branch });
      const wasHere = current()?.row?.slot === row.slot;
      if (wasHere) config.active.set(repo);
      return [
        `Released the worktree that held \`${branch}\`; the next writing subtask may reset it.`,
        ...(unpushed
          ? ["Commits in it that were never pushed are gone when that happens."]
          : []),
        ...(wasHere ? ["Your tools are back on your own checkout."] : [])
      ].join(" ");
    },

    async beforeWrite({ tool, dir, branch, url }) {
      const here = current();
      if (!here?.row) return undefined;
      const { row } = here;
      if (row.live) {
        return `Subtask ${row.live.subtaskId} is still working in this worktree, so nothing in it can be committed or pushed until it finishes.`;
      }
      const entry = repoAt(row, dir);
      if (tool === "repo_commit") {
        // A commit the map cannot see moves the tip; until a push says where it
        // went, the worktree is held rather than handed to the next subtask.
        if (entry) {
          config.pool.put({
            ...row,
            repos: row.repos.map((repo) =>
              repo === entry ? { ...repo, tip: "" } : repo
            )
          });
        }
        return undefined;
      }
      if (branch !== row.branch) {
        return `This worktree holds \`${row.branch}\`. Push that branch from it, or switch back to your own checkout with repo_worktree first.`;
      }
      if (!entry) {
        return `${dir} is not one of this worktree's repositories: ${row.repos.map((repo) => dirOf(row, repo)).join(", ")}.`;
      }
      if (url !== undefined && !sameRemote(url, entry.url)) {
        return (
          `The origin of ${dir} reads ${url}, but this worktree cloned it from ${entry.url} — ` +
          "something in the worktree changed it after the clone. Nothing was pushed."
        );
      }
      return undefined;
    },

    async afterPush({ dir, commit }) {
      const here = current();
      if (!here?.row) return;
      const { row } = here;
      const entry = repoAt(row, dir);
      if (!entry) return;
      config.pool.put({
        ...row,
        repos: row.repos.map((repo) =>
          repo === entry ? { ...repo, tip: commit, pushed: commit } : repo
        )
      });
    }
  };
}

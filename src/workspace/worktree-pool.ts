/**
 * The worktrees a caller's writing subtasks run in, and which one holds what.
 *
 * A worktree is a workspace of its own — one Durable Object, one container — with
 * a full checkout of the parent's repository: the superproject and every
 * submodule, each cloned with its own objects, sharing nothing with another
 * worktree. A writing subtask's session runs in one, and the parent's own tools
 * switch into the same one to review, push and open the pull request — see
 * `./worktrees.ts`. Nothing is copied between containers.
 *
 * **Kept and handed out again**, because a clone and its submodules cost minutes
 * and a fetch and a reset cost seconds. What decides whether one can go to the
 * next subtask is this map and never git: asking git means starting a container.
 *
 * Per caller and repository, in the parent's storage, for the reason
 * `./active-repo.ts` gives for its own table: the parent's tools resolve their
 * workspace synchronously, and `storage.sql` is the storage that allows it.
 */

/** One repository in a worktree's checkout. The superproject's path is `"."`. */
export interface PoolRepo {
  path: string;
  /** The origin it was cloned from, which is the only one the parent pushes to. */
  url: string;
  /** What the branch started from, as a reviewer names it — `origin/next`, a sha. */
  baseRef: string;
  /** The same, as a commit. Anything past it is the branch's work. */
  base: string;
  /** Where the subtask holding it now started — what a cancellation resets to. */
  start: string;
  /** Where the last subtask left it. Empty when something moved it unseen. */
  tip: string;
  /** The last commit the parent pushed from it. */
  pushed?: string;
}

export interface Worktree {
  /** The parent's `owner/repo`, whose pool this is. */
  repo: string;
  slot: number;
  /** The branch it holds, or none when it has never held one or was released. */
  branch?: string;
  /** The subtask working in it now. */
  live?: { taskId: string; subtaskId: number };
  /**
   * How {@link live} came to hold it, which decides what preparing it does: a
   * branch of its own, a branch this worktree already holds, or a pushed branch
   * brought into a worktree that does not.
   */
  mode?: "new" | "continue" | "adopt";
  /** Set once the checkout is on the branch; a retried chunk finishes one that is not. */
  ready?: boolean;
  /** The branch it held before, for preparing it to delete. */
  previous?: string;
  /** Where its checkout is, as the parent's was when it was prepared. */
  dir?: string;
  repos: PoolRepo[];
  usedAt: number;
}

/** The map's storage — {@link sqlPoolStore}, or a `Map` in a spec. */
export interface PoolStore {
  /** One repository's pool, by slot. */
  all(repo: string): Worktree[];
  /** Every pool — a subtask's row is found by its ids, whichever repository it is in. */
  every(): Worktree[];
  put(worktree: Worktree): void;
  delete(repo: string, slot: number): void;
}

/**
 * The repository slot a worktree's workspace is keyed on.
 *
 * A sentinel in the same namespace as `owner/repo`, for the reason
 * `SCRATCH_REPO` in `./scratch.ts` gives: angle brackets no forge name can
 * contain, and never `|`, the separator `workspaceName` joins on.
 */
export function worktreeRepo(repo: string, slot: number): string {
  return `<worktree:${repo}:${slot}>`;
}

/** The pool and slot a {@link worktreeRepo} sentinel names, or undefined. */
export function parseWorktreeRepo(
  selected: string
): { repo: string; slot: number } | undefined {
  const match = /^<worktree:(.+):(\d+)>$/.exec(selected);
  return match ? { repo: match[1]!, slot: Number(match[2]) } : undefined;
}

/** The branch a new writing subtask's work goes on. */
export function subtaskBranch(ctx: {
  taskId: string;
  subtaskId: number;
}): string {
  return `claude-coder/${ctx.taskId}/${ctx.subtaskId}`;
}

/**
 * Whether a branch is one this agent's subtasks make, and so one `continue` may
 * name. Anything else is a branch nobody here committed on — the default branch
 * above all.
 */
export function isSubtaskBranch(branch: string): boolean {
  // The task component is the only free one, so it carries git's own rules for
  // a ref component: no leading or trailing dot, no `..`, no `.lock` ending, and
  // none of the characters git or `/repo` refuse.
  const task = /^claude-coder\/([A-Za-z0-9._-]+)\/\d+$/.exec(branch)?.[1];
  return (
    task !== undefined &&
    !task.startsWith(".") &&
    !task.endsWith(".") &&
    !task.endsWith(".lock") &&
    !task.includes("..")
  );
}

/**
 * Whether nothing in it is worth keeping: no session, and every repository's
 * last known commit is its base or on the remote.
 *
 * An unknown tip — empty, because something committed there unseen — is never
 * either, so the worktree stays held until a push says otherwise.
 */
export function isFree(worktree: Worktree): boolean {
  if (worktree.live) return false;
  if (!worktree.branch) return true;
  return worktree.repos.every(
    (repo) =>
      repo.tip !== "" && (repo.tip === repo.base || repo.tip === repo.pushed)
  );
}

/**
 * The worktree a subtask works in, claimed for it.
 *
 * - The one already live for this subtask, on every chunk after the first: core
 *   resolves the runtime per chunk, and a second answer would strand the work.
 * - For `continue`, the worktree holding that branch, unless a session is in it.
 *   When none holds it — it was pushed and released, or its worktree went to
 *   another subtask — a free one adopts it from the remote.
 * - Otherwise the free worktree used longest ago, or a new slot. The pool grows
 *   with concurrency and has no ceiling of its own.
 */
export function claim(
  store: PoolStore,
  repo: string,
  ctx: { taskId: string; subtaskId: number; continue?: string },
  now: number
): Worktree {
  const rows = store.all(repo);
  const live = rows.find(
    (row) =>
      row.live?.taskId === ctx.taskId && row.live.subtaskId === ctx.subtaskId
  );
  if (live) return live;

  const holder =
    ctx.continue === undefined
      ? undefined
      : rows.find((row) => row.branch === ctx.continue);
  if (holder?.live) {
    throw new Error(
      `claude-coder: ${ctx.continue} is being worked on by subtask ${holder.live.subtaskId} ` +
        "right now. Wait for it to finish, then continue the branch."
    );
  }

  const free = rows.filter(isFree).sort((a, b) => a.usedAt - b.usedAt)[0];
  const slot =
    holder?.slot ??
    free?.slot ??
    rows.reduce((max, row) => Math.max(max, row.slot + 1), 0);
  const base = holder ?? free ?? { repo, slot, repos: [], usedAt: now };

  const branch = ctx.continue ?? subtaskBranch(ctx);
  const previous = base.branch ?? base.previous;
  const claimed: Worktree = {
    ...base,
    slot,
    branch,
    previous: previous === branch ? undefined : previous,
    live: { taskId: ctx.taskId, subtaskId: ctx.subtaskId },
    mode: holder ? "continue" : ctx.continue ? "adopt" : "new",
    ready: false,
    usedAt: now
  };
  store.put(claimed);
  return claimed;
}

/**
 * Empty the row of a worktree whose workspace was reclaimed.
 *
 * Its checkout and storage are gone, so nothing the row says is true any more —
 * a `live` marker included: a session cannot outlast a week without touching
 * its workspace. The slot stays, to be cloned into again.
 */
export function forgetWorktree(store: PoolStore, sentinel: string): void {
  const worktree = parseWorktreeRepo(sentinel);
  if (!worktree) return;
  const row = slotOf(store, worktree.repo, worktree.slot);
  if (!row) return;
  store.put({ repo: row.repo, slot: row.slot, repos: [], usedAt: row.usedAt });
}

/**
 * Empty the rows of worktrees whose checkout is gone, whoever reclaimed it.
 *
 * **The sweep's `onReclaimed` does not cover this, and mostly never fires.** A
 * workspace reclaims itself on its own alarm, armed for a week past its last
 * use; the sweep that would have reclaimed it runs weekly and asks the same
 * question with the same threshold, so the alarm gets there first almost every
 * time. `reclaimIfIdle` then answers nothing-to-do — see `./active-repo.ts`,
 * `forget` — and the row outlives the checkout it describes.
 *
 * What that costs is not a stale entry. A row holding unpushed commits is never
 * free ({@link isFree}), and nothing here would ever make it free again, so
 * {@link claim} would pass over that slot for good and open a new one for every
 * later subtask — each a full clone of a checkout the pool exists to reuse.
 *
 * So the checkout is asked about directly. `hasCheckout` answers for one
 * worktree, and a workspace that was reclaimed has no record of one — reading
 * that is a local storage read that neither starts a container nor marks the
 * workspace used, so this does not keep alive what it is checking on.
 */
export async function reconcileWorktrees(
  store: PoolStore,
  hasCheckout: (sentinel: string) => Promise<boolean>
): Promise<void> {
  for (const sentinel of idleWorktrees(store)) {
    const named = parseWorktreeRepo(sentinel);
    if (!named) continue;
    // An empty row describes no checkout, so there is nothing about it to be
    // wrong — and asking would cost an RPC per slot per week to learn that.
    if (!slotOf(store, named.repo, named.slot)?.repos.length) continue;
    if (await hasCheckout(sentinel)) continue;
    forgetWorktree(store, sentinel);
  }
}

/** The sentinel of every worktree no session is working in. */
export function idleWorktrees(store: PoolStore): string[] {
  return store
    .every()
    .filter((row) => !row.live)
    .map((row) => worktreeRepo(row.repo, row.slot));
}

/** The row for a slot. */
export function slotOf(
  store: PoolStore,
  repo: string,
  slot: number
): Worktree | undefined {
  return store.all(repo).find((row) => row.slot === slot);
}

/** The worktree holding a branch. */
export function holderOf(
  store: PoolStore,
  repo: string,
  branch: string
): Worktree | undefined {
  return store.all(repo).find((row) => row.branch === branch);
}

const TABLE = "coder_worktrees";

/**
 * The map in the parent's SQLite: one row per worktree, its state as JSON.
 *
 * JSON rather than columns because nothing queries inside a row — a pool is read
 * whole — and `IF NOT EXISTS` cannot add a column to a table that exists, which
 * would make every change to {@link Worktree} a migration.
 */
export function sqlPoolStore(storage: DurableObjectStorage): PoolStore {
  let ready = false;
  const ensure = () => {
    if (ready) return;
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (repo TEXT NOT NULL, slot INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (repo, slot))`
    );
    ready = true;
  };
  return {
    all(repo) {
      ensure();
      return storage.sql
        .exec<{ state: string }>(
          `SELECT state FROM ${TABLE} WHERE repo = ? ORDER BY slot`,
          repo
        )
        .toArray()
        .map((row) => JSON.parse(row.state) as Worktree);
    },
    every() {
      ensure();
      return storage.sql
        .exec<{ state: string }>(`SELECT state FROM ${TABLE}`)
        .toArray()
        .map((row) => JSON.parse(row.state) as Worktree);
    },
    put(worktree) {
      ensure();
      storage.sql.exec(
        `INSERT INTO ${TABLE} (repo, slot, state) VALUES (?, ?, ?)
           ON CONFLICT(repo, slot) DO UPDATE SET state = excluded.state`,
        worktree.repo,
        worktree.slot,
        JSON.stringify(worktree)
      );
    },
    delete(repo, slot) {
      ensure();
      storage.sql.exec(
        `DELETE FROM ${TABLE} WHERE repo = ? AND slot = ?`,
        repo,
        slot
      );
    }
  };
}

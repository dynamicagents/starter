import type { PluginHost } from "@dynamicagents/core/host";

/**
 * Which repository this caller is working on, and therefore which workspace
 * their commands reach.
 *
 * ## The ordering problem this solves
 *
 * A workspace is one Durable Object, one container and **one repository**, which
 * is structural rather than conventional — `@cloudflare/computer` pairs an object
 * with exactly one container. But the repository is not known when the plugin
 * list is built, or even at the start of the task: the model chooses it by
 * calling `repo_clone` with a URL, and `repo_clone` needs a workspace to run
 * `git clone` in. The repo plugin's `beforeCheckout` hook breaks the cycle — it
 * fires with the parsed `owner/repo` after the host allowlist passes and before
 * any git runs.
 *
 * ## Why this is SQL and not `storage.get`
 *
 * The selection must survive an isolate eviction mid-task, or a new isolate
 * falls back to a caller-level workspace and `repo_diff` reports an empty tree
 * for a checkout sitting right there. So it is persisted — but `workspaceName()`
 * is a **synchronous** thunk called on the path of every tool, inside
 * `computerExec`, where there is nowhere to await. `storage.get` is async;
 * `storage.sql` is not. Hence a one-row table, with an in-memory cache in front
 * so the common case touches no storage at all.
 *
 * ## Known limitation: one task at a time, per caller
 *
 * The row is keyed `id = 1` — one selection per agent object, and an agent object
 * is per caller, not per task. Two tasks from one caller cloning different
 * repositories overwrite each other: the later `set()` wins, and from then on the
 * earlier task's own tools (`repo_diff`, the reads, the commit and push that end
 * it) resolve to the *other* task's workspace, cancellation cleanup included.
 *
 * Delegated work is not exposed — a facet gets its workspace name on
 * `ctx.runtime`, resolved on the parent and pinned for the life of the subtask.
 * The exposure is the parent's own tool calls.
 *
 * **Not fixable in this file**, which is why it is documented rather than
 * patched: the fix is to key the selection by task, and core's `PluginHost`
 * exposes no task or context identity to key on. Closing it means adding that
 * upstream and threading it through `workspaceName()`, which must stay
 * synchronous. Until then, one task at a time per caller is a load-bearing
 * assumption.
 *
 * The workspace itself should stay keyed on `(caller, repo)` even then: per-task
 * workspaces would mean a fresh checkout and a fresh install every time, which is
 * the cost this whole design exists to avoid. It is the *routing* that needs task
 * scope, not the storage.
 */

const TABLE = "coder_active_repo";
const SEEN_TABLE = "coder_seen_repos";

/** Reads and writes for one caller's current repository. */
export interface ActiveRepo {
  /** `owner/repo`, or undefined before the first clone of this session. */
  get(): string | undefined;
  /** Record the repository a clone is about to target. */
  set(repo: string): void;
  /**
   * Every repository this caller has ever worked on.
   *
   * Not for routing — `get()` is what routes. This is the **candidate list** the
   * weekly reclaim sweep walks, and it exists because a Durable Object namespace
   * cannot be enumerated from a Worker: without a record of the names we handed
   * out, there is no way to ask a workspace whether it has gone stale.
   *
   * It is deliberately only a list of candidates. Whether a workspace is
   * actually idle is decided by the workspace, from its own `lastUsedAt` — and
   * an entry that goes missing only means that workspace falls back to its own
   * alarm.
   *
   * This used to claim a stale entry was free, on the grounds that it "pokes an
   * already-empty object and is told there is nothing to do". That was wrong in
   * both halves: a reclaimed workspace has had its storage deleted, so
   * `lastUsedAt` reads as `0`, which is maximally idle — it was told it had
   * reclaimed something, every week, forever, logging a false line and
   * recreating storage to empty it again. `reclaimIfIdle` now reports nothing to
   * do when there is nothing there, and {@link forget} keeps this list
   * proportional to the workspaces that actually exist. Both, because they fix
   * different halves: one stops the lie, the other stops the growth.
   */
  seen(): string[];
  /**
   * Drop a repository from the candidate list.
   *
   * Called when its workspace has been reclaimed, so the weekly sweep stops
   * paying for a workspace that no longer exists. `set()` puts it back on the
   * next clone, which is the whole reason this is safe to do: forgetting a
   * candidate loses nothing that the next checkout does not restore.
   */
  forget(repo: string): void;
}

export function activeRepo(host: PluginHost<Env>): ActiveRepo {
  const storage = host.storage;
  let cached: string | undefined;
  let ready = false;

  const ensure = () => {
    if (ready) return;
    // `IF NOT EXISTS` rather than a migration: this is one row of scratch state
    // belonging to one agent, not part of core's journal, and core's schema
    // machinery has no reason to know about it.
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), repo TEXT NOT NULL)`
    );
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${SEEN_TABLE} (repo TEXT PRIMARY KEY, at INTEGER NOT NULL)`
    );
    ready = true;
  };

  return {
    get(): string | undefined {
      if (cached !== undefined) return cached;
      try {
        ensure();
        const row = storage.sql
          .exec<{ repo: string }>(`SELECT repo FROM ${TABLE} WHERE id = 1`)
          .toArray()[0];
        cached = row?.repo;
        return cached;
      } catch {
        // A subagent facet reaches this through the same plugin list but has no
        // table of its own — and needs none, because its workspace name arrives
        // on `ctx.runtime` from the parent and this is only ever the fallback.
        // Returning undefined lets that fallback be a caller-level name rather
        // than an exception thrown from inside a tool.
        return undefined;
      }
    },

    set(repo: string): void {
      if (cached === repo) return;
      ensure();
      storage.sql.exec(
        `INSERT INTO ${TABLE} (id, repo) VALUES (1, ?)
           ON CONFLICT(id) DO UPDATE SET repo = excluded.repo`,
        repo
      );
      storage.sql.exec(
        `INSERT INTO ${SEEN_TABLE} (repo, at) VALUES (?, ?)
           ON CONFLICT(repo) DO UPDATE SET at = excluded.at`,
        repo,
        Date.now()
      );
      cached = repo;
    },

    seen(): string[] {
      ensure();
      return storage.sql
        .exec<{ repo: string }>(`SELECT repo FROM ${SEEN_TABLE}`)
        .toArray()
        .map((row) => row.repo);
    },

    forget(repo: string): void {
      ensure();
      storage.sql.exec(`DELETE FROM ${SEEN_TABLE} WHERE repo = ?`, repo);
    }
  };
}

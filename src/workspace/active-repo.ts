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
const CHECKOUT_TABLE = "coder_active_checkout";

/** Reads and writes for one caller's current repository. */
export interface ActiveRepo {
  /** `owner/repo`, or undefined before the first clone of this session. */
  get(): string | undefined;
  /** Record the repository a clone is about to target. */
  set(repo: string): void;
  /**
   * What the parent cloned, in the terms a second clone of the same thing needs.
   *
   * A subtask that works in a container of its own starts with an empty
   * filesystem, so something has to clone into it — and the honest url to use is
   * **the one the parent actually cloned from**, already allowlist-checked by
   * `/repo`. Reconstructing one from `owner/repo` would mean this file deciding a
   * forge host, which is a decision `/repo` owns and permits more than one answer
   * to.
   *
   * `undefined` before the first clone, and a caller must treat that as "there is
   * nothing to clone" rather than guessing.
   */
  checkout(): ActiveCheckout | undefined;
  /** Record it, from `/repo`'s `afterCheckout`, which is told all three. */
  setCheckout(checkout: ActiveCheckout): void;
  /**
   * Add a name to the sweep's candidate list **without** routing anything to it.
   *
   * {@link set} does both, which is right for a clone: the parent is about to work
   * in what it selected. A per-subtask workspace is the other case — it must be
   * swept, and it must not become what the parent's own tools address, because
   * this table holds one row and the later write would win.
   */
  note(repo: string): void;
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
   * A stale entry is not free, though it looks it. A reclaimed workspace has had
   * its storage deleted, so `lastUsedAt` reads as `0` — maximally idle — and a
   * sweep that trusted that would report a reclaim it never made, every week,
   * forever, recreating storage to empty it again. `reclaimIfIdle` reports
   * nothing to do when there is nothing there, which stops the false report, and
   * {@link forget} trims the list — but only for the workspaces a sweep reclaimed
   * itself, so growth is slowed rather than stopped.
   */
  seen(): string[];
  /**
   * Drop a repository from the candidate list.
   *
   * Called only when the sweep's own `reclaimIfIdle` answered `reclaimed: true`,
   * so it trims the workspaces that sweep retired and no others. A workspace its
   * own alarm already removed answers nothing-to-do, so its candidate is never
   * forgotten and costs an RPC on every future weekly check.
   *
   * `set()` puts an entry back on the next clone, which is the whole reason
   * dropping one is safe: forgetting a candidate loses nothing that the next
   * checkout does not restore.
   */
  forget(repo: string): void;
}

/** Enough to clone the parent's repository again somewhere else. */
export interface ActiveCheckout {
  /** The clone url `/repo` used, already allowlist-checked. */
  url: string;
  /**
   * Where it put the tree.
   *
   * Reused verbatim for a subtask's own clone rather than derived again: each
   * container has its own filesystem, so the same path collides with nothing, and
   * one spelling of a checkout directory is what keeps `discardWorkingTree`'s
   * fallback and the facet's `checkoutDir()` answering about the same place.
   */
  dir: string;
  /** The branch the parent is on, so a subtask starts from the same commit. */
  branch: string;
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
    // Its own table rather than columns on `${TABLE}`: `IF NOT EXISTS` does not
    // add a column to a table that already exists, so widening that one would
    // read as a migration this file has deliberately not got.
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${CHECKOUT_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), url TEXT NOT NULL, dir TEXT NOT NULL, branch TEXT NOT NULL)`
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

    checkout(): ActiveCheckout | undefined {
      try {
        ensure();
        return storage.sql
          .exec<{ url: string; dir: string; branch: string }>(
            `SELECT url, dir, branch FROM ${CHECKOUT_TABLE} WHERE id = 1`
          )
          .toArray()[0];
      } catch {
        // A facet has no table of its own — the same reason `get()` swallows.
        return undefined;
      }
    },

    setCheckout(checkout: ActiveCheckout): void {
      ensure();
      storage.sql.exec(
        `INSERT INTO ${CHECKOUT_TABLE} (id, url, dir, branch) VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET url = excluded.url, dir = excluded.dir, branch = excluded.branch`,
        checkout.url,
        checkout.dir,
        checkout.branch
      );
    },

    note(repo: string): void {
      ensure();
      storage.sql.exec(
        `INSERT INTO ${SEEN_TABLE} (repo, at) VALUES (?, ?)
           ON CONFLICT(repo) DO UPDATE SET at = excluded.at`,
        repo,
        Date.now()
      );
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

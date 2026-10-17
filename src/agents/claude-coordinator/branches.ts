import { ARTIFACT_RETENTION_MS } from "@dynamicagents/core/artifacts";
import type { PlannedSession } from "./plans";
import type { SessionNote } from "./sandbox";

/**
 * Which conversation a branch carries, so a session sent back to it with
 * `continue` carries it on rather than learning the code again.
 *
 * One row per writing run on a branch, recorded when the run is placed. The
 * conversation itself is the workspace's record, which a reclaimed workspace
 * takes with the transcript: a run whose session is gone is passed over.
 */
const TABLE = "claude_coordinator_branch_runs";

function ensure(storage: DurableObjectStorage): void {
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (run_id TEXT PRIMARY KEY, branch TEXT NOT NULL, workspace TEXT NOT NULL, repo TEXT, slot INTEGER, created_at INTEGER NOT NULL)`
  );
}

/** Where a writing run on `branch` was placed. Once per run, however often prepared. */
export function recordBranchRun(
  storage: DurableObjectStorage,
  run: {
    runId: string;
    branch: string;
    workspaceName: string;
    slot?: { repo: string; slot: number };
  }
): void {
  ensure(storage);
  const now = Date.now();
  storage.sql.exec(
    `DELETE FROM ${TABLE} WHERE created_at < ?`,
    now - ARTIFACT_RETENTION_MS
  );
  storage.sql.exec(
    `INSERT OR IGNORE INTO ${TABLE} (run_id, branch, workspace, repo, slot, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    run.runId,
    run.branch,
    run.workspaceName,
    run.slot?.repo ?? null,
    run.slot?.slot ?? null,
    now
  );
}

/**
 * Where a branch's runs are looked up, which is **not** the branch name alone:
 * a name is unique within a repository and nothing scopes it across them, so a
 * run on another repository's `feature/x` is not this branch's work. One
 * caller's ledger holds every repository they have worked on.
 *
 * A repository for a session in a worktree of its own; the workspace a session
 * runs in when the parent has selected no repository. `branchScope` in
 * `src/agents/claude-coordinator/children.ts` reads it from the selection that
 * places the run.
 */
export type BranchScope = { repo: string } | { workspaceName: string };

/**
 * The latest run on `branch` **within `scope`** whose workspace still holds its
 * conversation. `except` is the run asking, whose own row a repeated `prepare`
 * has written.
 *
 * Scoped before the latest is chosen, never after: a newer run on the same
 * branch name elsewhere would otherwise be selected and then rejected by
 * `carryOn`, and this branch's own conversation — still there — never read.
 */
export async function branchSession(
  storage: DurableObjectStorage,
  branch: string,
  scope: BranchScope,
  sessionOf: (
    workspaceName: string,
    runId: string
  ) => Promise<SessionNote | undefined>,
  except?: string
): Promise<PlannedSession | undefined> {
  ensure(storage);
  const within =
    "repo" in scope
      ? { sql: "repo = ?", value: scope.repo }
      : { sql: "repo IS NULL AND workspace = ?", value: scope.workspaceName };
  const runs = storage.sql
    .exec<{
      run_id: string;
      workspace: string;
      repo: string | null;
      slot: number | null;
    }>(
      `SELECT run_id, workspace, repo, slot FROM ${TABLE} WHERE branch = ? AND ${within.sql} ORDER BY created_at DESC, rowid DESC`,
      branch,
      within.value
    )
    .toArray();
  for (const run of runs) {
    if (run.run_id === except) continue;
    // Unreadable reads as not there: the run starts fresh, which it can.
    const note = await sessionOf(run.workspace, run.run_id).catch(
      () => undefined
    );
    if (!note?.sessionId) continue;
    return {
      runId: run.run_id,
      sessionId: note.sessionId,
      transcript: note.transcript ?? run.run_id,
      workspaceName: run.workspace,
      ...(run.repo !== null && run.slot !== null
        ? { near: { repo: run.repo, slot: run.slot } }
        : {})
    };
  }
  return undefined;
}

import { ARTIFACT_RETENTION_MS } from "@dynamicagents/core/artifacts";
import { parseRepo } from "@dynamicagents/plugins/repo";
import type { PlannedSession } from "./plans";
import type { SessionNote } from "./workspace";

/**
 * Which conversation a branch carries, so a session sent back to it — a
 * `continue`, a revision of its pull request — carries it on rather than
 * learning the code again.
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
 * The latest run on `branch` whose workspace still holds its conversation.
 * `except` is the run asking, whose own row a repeated `prepare` has written.
 */
export async function branchSession(
  storage: DurableObjectStorage,
  branch: string,
  sessionOf: (
    workspaceName: string,
    runId: string
  ) => Promise<SessionNote | undefined>,
  except?: string
): Promise<PlannedSession | undefined> {
  ensure(storage);
  const runs = storage.sql
    .exec<{
      run_id: string;
      workspace: string;
      repo: string | null;
      slot: number | null;
    }>(
      `SELECT run_id, workspace, repo, slot FROM ${TABLE} WHERE branch = ? ORDER BY created_at DESC, rowid DESC`,
      branch
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
      workspaceName: run.workspace,
      ...(run.repo !== null && run.slot !== null
        ? { near: { repo: run.repo, slot: run.slot } }
        : {})
    };
  }
  return undefined;
}

/** An open pull request a session can push to: its head branch, and its page. */
export interface OpenPullRequest {
  number: number;
  branch: string;
  url: string;
}

/**
 * The pull request `number` in the repository the parent cloned, if a session
 * can work on it: open, and from a branch of that repository rather than a fork
 * — a session pushes its branch, and a fork's is not there to push to.
 *
 * Asked of GitHub on the parent's side, with the deployment's token, so the
 * branch a session is put on is the pull request's and not one a model named.
 */
export async function openPullRequest(
  token: string,
  checkoutUrl: string,
  number: number,
  apiBase = "https://api.github.com"
): Promise<OpenPullRequest> {
  const repo = parseRepo(checkoutUrl);
  if (!repo) {
    throw new Error(
      `claude_code_revise: could not tell which repository ${checkoutUrl} is.`
    );
  }
  const answer = await fetch(
    `${apiBase}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${number}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "dynamicagents-starter"
      }
    }
  );
  if (answer.status === 404) {
    throw new Error(
      `claude_code_revise: #${number} is not a pull request in ${repo.owner}/${repo.repo}.`
    );
  }
  if (!answer.ok) {
    throw new Error(
      `claude_code_revise: GitHub answered ${answer.status} for #${number}; try again shortly.`
    );
  }
  const pr = (await answer.json()) as {
    state?: string;
    merged?: boolean;
    html_url?: string;
    head?: { ref?: string; repo?: { full_name?: string } | null };
    base?: { repo?: { full_name?: string } };
  };
  if (pr.state !== "open") {
    throw new Error(
      `claude_code_revise: #${number} is ${pr.merged ? "merged" : "closed"}, so there is nothing to revise. Start a new change with claude_code.`
    );
  }
  const head = pr.head?.ref;
  if (!head || pr.head?.repo?.full_name !== pr.base?.repo?.full_name) {
    throw new Error(
      `claude_code_revise: #${number} is from a fork, which a session cannot push to.`
    );
  }
  return { number, branch: head, url: pr.html_url ?? "" };
}

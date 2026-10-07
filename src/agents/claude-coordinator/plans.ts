import {
  ARTIFACT_RETENTION_MS,
  requireArtifactsStub,
  type ArtifactEntry
} from "@dynamicagents/core/artifacts";
import { CLAUDE_CODE_WRITE_INPUT } from "@dynamicagents/plugins/claude-code";
import { z } from "zod";
import type { SessionNote } from "./workspace";

/**
 * A plan, as `claude-coordinator` keeps one: an artifact of its own, which a
 * Claude Code session writes, anyone holding its link reads, the caller
 * approves through `ask_user`, and a writing session is given whole.
 *
 * What travels is the plan's **id** — the artifact's token — and never its
 * body: the parent model gets the id, a title and the session's account of the
 * plan, and hands the id on. So the plan a person approved and the plan a
 * session builds are the same text, which no model in between retold.
 */

/** The artifact kind a plan is filed under. */
export const PLAN_KIND = "plan";

/**
 * The label a version of the plan is filed under. Anything else on the page —
 * an answer to an approval, which core files as `approval` — is about a plan,
 * not one; the latest note under this label is the plan.
 */
export const PLAN_LABEL = "plan";

/** `claude_code_plan`'s input: what to plan, and the plan it edits, if any. */
export const PLAN_INPUT = z.object({
  task: z
    .string()
    .describe(
      "What to plan: the change and why, what the plan must respect, and what you already know. On an edit, what to change about the plan — the caller's comment, whole."
    ),
  plan: z
    .string()
    .optional()
    .describe(
      "The id of a plan to edit — one claude_code_plan returned. Omit to write a new one."
    )
});

export type PlanInput = z.infer<typeof PLAN_INPUT>;

/** The writer's input, the plan it carries out, and the name of a new branch. */
export const WRITE_INPUT = CLAUDE_CODE_WRITE_INPUT.extend({
  plan: z
    .string()
    .optional()
    .describe(
      "The id of an approved plan to carry out — one claude_code_plan returned. The session carries on from the planning session's conversation where it can, and is given the plan whole either way, so brief it on the work rather than restating the plan or what the planner found."
    ),
  branch: z
    .string()
    .optional()
    .describe(
      "A name for the new branch, when the caller asked for the work on one. It must not exist yet; to add to a branch that does, use `continue`. Omit it and the session's branch is named for you."
    )
});

export type WriteInput = z.infer<typeof WRITE_INPUT>;

/** What the parent model is told `claude_code` does. */
export const WRITER_DESCRIPTION = [
  "Hand a change to a Claude Code session in a worktree of its own: it reads,",
  "edits, runs the project's checks, commits, pushes its branch and opens a pull",
  "request ready for review — which is what asks for Copilot's review. Its report",
  "says how it ended — done, stopped for the person's decision, or blocked — and",
  "names the pull request.",
  "",
  "Give it **one coherent change**, described as you would to an engineer: what",
  "should be true when it is done, and how to tell. It is expensive to start and",
  "cheap to let run, so 'add the endpoint, its tests and wire it up' is one",
  "session, not three.",
  "",
  "It cannot ask you anything mid-run. It stops instead, with a question for you to",
  "put to the person.",
  "",
  "To build an approved plan, pass its id as `plan`. To add to a branch that has",
  "no pull request yet — a session that stopped for a decision, or work a cancel",
  "kept — set `continue` to it: the session carries on the conversation that wrote",
  "it. To change an open pull request, use claude_code_revise instead.",
  "",
  "To find something out rather than change it, say so and that it is to change",
  "nothing: it pushes nothing and opens nothing."
].join("\n");

/** `claude_code_revise`'s input: which pull request, and what brought it back. */
export const REVISE_INPUT = z.object({
  pr: z
    .number()
    .int()
    .positive()
    .describe(
      "The pull request's number, in the repository you have checked out."
    ),
  task: z
    .string()
    .describe(
      "What brought it back, in a sentence: a self-review, Copilot's review having landed, a check that failed (by name), or what the person asked for, in their words. Say what happened, not how to answer it."
    )
});

export type ReviseInput = z.infer<typeof REVISE_INPUT>;

/** What the parent model is told `claude_code_revise` does. */
export const REVISER_DESCRIPTION = [
  "Send a Claude Code session back to an open pull request to work on it: a",
  "self-review, Copilot's review once it has landed, a failing check, or something",
  "the person asked for. It carries on the conversation that wrote the pull",
  "request where it can, so it starts knowing the code.",
  "",
  "It already knows how to answer each of those — a review in one pass, every",
  "thread replied to and resolved, CI's logs read and fixed — so tell it what",
  "landed, not what to do about it. Before it finishes it looks once at the",
  "review and the checks, and answers whatever landed while it worked.",
  "",
  "One session at a time on a pull request: while one is running, wait for its",
  "report rather than start another."
].join("\n");

/** What the parent model is told `claude_code_plan` does. */
export const PLANNER_DESCRIPTION = [
  "Have a Claude Code session work out a plan for a change, in a worktree of its",
  "own and in Claude Code's plan mode: it reads the code and changes nothing, and",
  "it cannot run the tests. The plan is filed on a page of its own. What comes",
  "back is the plan's id, its title and the session's account of it — not the",
  "plan itself: the person you ask to approve it reads it whole, from the link",
  "that goes with your question.",
  "",
  "To change a plan, call this again with `plan` set to its id, and say what",
  "to change: the session that wrote it revises it where it can, and the new",
  "version goes on the same page. A plan that was approved is locked and cannot",
  "change — write a new one instead.",
  "",
  "To build an approved plan, pass its id to claude_code as `plan`: that session",
  "carries on from this one's conversation, so it starts knowing what it found.",
  "",
  "It runs in the background, and cannot ask you anything mid-run."
].join("\n");

/**
 * What a planning session must answer, as `--json-schema`. The descriptions are
 * the session's instructions for each field — the CLI puts them in front of the
 * model as the `StructuredOutput` tool's schema.
 */
export const PLAN_OUTPUT = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description:
        "A short name for the plan, a few words. Its page is headed by it."
    },
    plan: {
      type: "string",
      description:
        "The plan, in Markdown, for the person who approves it: what will change and where, what stays as it is, and how the result will be checked. Complete on its own — the session that carries it out usually continues this conversation, but may start without it and have only this. What you established about the base goes in it as fact, so that session compares against it instead of finding it out again. Name no branch: that session is given one, and it is the pull request's head."
    },
    lastReply: {
      type: "string",
      description:
        "What you tell the agent that asked for the plan, which does not read the plan itself: what it does in two or three sentences, and anything the agent should know — assumptions you made, questions only the person can answer, what you could not check."
    }
  },
  required: ["title", "plan", "lastReply"],
  additionalProperties: false
} as const;

/** A planning session's answer, as {@link PLAN_OUTPUT} describes it. */
export const PlanAnswer = z.object({
  title: z.string().trim().min(1),
  plan: z.string().trim().min(1),
  lastReply: z.string()
});

export type PlanAnswer = z.infer<typeof PlanAnswer>;

// --- which plans are this caller's ---------------------------------------------

/**
 * The plans this caller's agent opened, in the agent's own storage.
 *
 * An artifact's token is the authority to read it, and a link is shared by
 * design — so holding one cannot also be the authority to edit, approve or
 * build it, or a link forwarded to another caller would hand them this one's
 * plan. A plan is this caller's because this agent opened it.
 */
const TABLE = "claude_coordinator_plans";

function ensure(storage: DurableObjectStorage): void {
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`
  );
}

/**
 * Open a plan for this caller, and forget the ones retention has taken: an
 * artifact lives for {@link ARTIFACT_RETENTION_MS} from when it was opened, and
 * so does its row here.
 *
 * `sourceKey` names what opens it — a planning run — so opening it again for
 * the same one, as a replayed `prepare` does, finds the plan it opened rather
 * than a second one.
 */
export async function createPlan(
  env: Env,
  storage: DurableObjectStorage,
  sourceKey?: string
): Promise<string> {
  const id = await requireArtifactsStub(env).createArtifact(
    PLAN_KIND,
    sourceKey
  );
  ensure(storage);
  const now = Date.now();
  storage.sql.exec(
    `DELETE FROM ${TABLE} WHERE created_at < ?`,
    now - ARTIFACT_RETENTION_MS
  );
  storage.sql.exec(
    `INSERT OR IGNORE INTO ${TABLE} (id, created_at) VALUES (?, ?)`,
    id,
    now
  );
  return id;
}

/** Whether this caller's agent opened the plan `id` names. */
export function ownsPlan(storage: DurableObjectStorage, id: string): boolean {
  ensure(storage);
  return (
    storage.sql.exec(`SELECT 1 FROM ${TABLE} WHERE id = ?`, id).toArray()
      .length > 0
  );
}

// --- which session wrote a plan ---------------------------------------------

/**
 * Every planning run on a plan, and where it ran: what a later run needs to
 * continue the conversation that wrote it — see {@link plannedSession}.
 *
 * Recorded when the run is placed, so it says where the session ran and nothing
 * about how it went: whether it filed a version is the workspace's record,
 * which a reclaimed workspace takes with the transcript.
 */
const RUNS_TABLE = "claude_coordinator_plan_runs";

function ensureRuns(storage: DurableObjectStorage): void {
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS ${RUNS_TABLE} (run_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, workspace TEXT NOT NULL, repo TEXT, slot INTEGER, created_at INTEGER NOT NULL)`
  );
}

/** Where a planning run on `planId` was placed. Once per run, however often prepared. */
export function recordPlanRun(
  storage: DurableObjectStorage,
  run: {
    runId: string;
    planId: string;
    workspaceName: string;
    slot?: { repo: string; slot: number };
  }
): void {
  ensureRuns(storage);
  const now = Date.now();
  storage.sql.exec(
    `DELETE FROM ${RUNS_TABLE} WHERE created_at < ?`,
    now - ARTIFACT_RETENTION_MS
  );
  storage.sql.exec(
    `INSERT OR IGNORE INTO ${RUNS_TABLE} (run_id, plan_id, workspace, repo, slot, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    run.runId,
    run.planId,
    run.workspaceName,
    run.slot?.repo ?? null,
    run.slot?.slot ?? null,
    now
  );
}

/** The conversation that wrote a plan's latest version, and where it is. */
export interface PlannedSession {
  runId: string;
  sessionId: string;
  workspaceName: string;
  /** Its worktree, to be placed in again; none for a scratchpad. */
  near?: { repo: string; slot: number };
}

/**
 * The planning run that filed the plan's latest version, when its workspace
 * still holds its session — the conversation an edit revises and a build
 * carries on from. None otherwise, and the run then starts fresh from the
 * plan's text.
 *
 * **That run and no other.** The conversation behind an older version would
 * revise, or build, a plan the person has since seen changed — and an edit
 * carrying on is not shown the plan again. So a run whose record is gone is not
 * stood in for by the one before it. Matched by the version it filed rather than
 * by when it started, since two edits need not finish in the order they began.
 * `except` is the run asking, whose own row a repeated `prepare` has already
 * written.
 */
export async function plannedSession(
  storage: DurableObjectStorage,
  plan: { id: string; version: number | undefined },
  sessionOf: (
    workspaceName: string,
    runId: string
  ) => Promise<SessionNote | undefined>,
  except?: string
): Promise<PlannedSession | undefined> {
  if (plan.version === undefined) return undefined;
  ensureRuns(storage);
  const runs = storage.sql
    .exec<{
      run_id: string;
      workspace: string;
      repo: string | null;
      slot: number | null;
    }>(
      `SELECT run_id, workspace, repo, slot FROM ${RUNS_TABLE} WHERE plan_id = ? ORDER BY created_at DESC, rowid DESC`,
      plan.id
    )
    .toArray();
  for (const run of runs) {
    if (run.run_id === except) continue;
    // Unreadable reads as not there: the run starts fresh, which it can.
    const note = await sessionOf(run.workspace, run.run_id).catch(
      () => undefined
    );
    if (note?.plan !== plan.id || note.version !== plan.version) continue;
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

/** A plan as a session is given it, or why it cannot be. */
export type PlanLookup =
  | {
      ok: true;
      plan: string | undefined;
      locked: boolean;
      /** What it was settled as — `approved`, or `failed` for one never written. */
      status: string | null;
      page: ArtifactEntry[];
    }
  | { ok: false; reason: string };

/**
 * The plan `id` names, if it is this caller's and still there: its latest
 * version, whether it is locked, and its whole page.
 */
export async function lookUpPlan(
  env: Env,
  storage: DurableObjectStorage,
  id: string
): Promise<PlanLookup> {
  if (!ownsPlan(storage, id)) {
    return {
      ok: false,
      reason: `\`${id}\` is not a plan of yours: pass the id claude_code_plan returned.`
    };
  }
  const artifact = await requireArtifactsStub(env).readArtifact(id);
  if (artifact === null) {
    return {
      ok: false,
      reason: `The plan \`${id}\` is gone: plans are kept for a limited time. Write it again.`
    };
  }
  return {
    ok: true,
    plan: latestPlan(artifact.entries),
    locked: artifact.locked,
    status: artifact.status,
    page: artifact.entries
  };
}

/** The latest version of the plan on a page, or none yet. */
export function latestPlan(page: readonly ArtifactEntry[]): string | undefined {
  const at = lastPlanIndex(page);
  return at < 0 ? undefined : page[at]!.text;
}

/** The latest version's place in the page's sequence, or none yet. */
export function latestVersion(
  page: readonly ArtifactEntry[]
): number | undefined {
  const at = lastPlanIndex(page);
  return at < 0 ? undefined : page[at]!.sequence;
}

/** Where on a page its latest version is, or -1 for none yet. */
export function lastPlanIndex(page: readonly ArtifactEntry[]): number {
  for (let i = page.length - 1; i >= 0; i--) {
    if (page[i]!.label === PLAN_LABEL) return i;
  }
  return -1;
}

/** A version of the plan as it is filed: its title over it. */
export function planText(answer: PlanAnswer): string {
  return `# ${answer.title.trim()}\n\n${answer.plan.trim()}`;
}

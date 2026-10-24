import {
  ARTIFACT_RETENTION_MS,
  artifactViewerUrl,
  requireArtifactsStub
} from "@dynamicagents/core/artifacts";
import type { SessionOutcome } from "@dynamicagents/plugins/claude-code";
import { tool, type Tool } from "ai";
import { z } from "zod";
import {
  questionsText,
  sessionFooter,
  sessionReport,
  SessionQuestions,
  type FilingRun
} from "./session";

/**
 * A discovery run's report, as `claude-coordinator` keeps one.
 *
 * A **discovery run** is a Claude Code session following a skill the task names
 * on its first line: it reads, files what it finds wherever that skill says, and
 * changes nothing. What is the same for every such skill, and so lives here, is
 * the report: one per run, filed on a page of its own, read by anyone holding
 * its link, and handed to the next run of the same skill as its history.
 *
 * Nothing here knows which skills exist. The **line** a report is filed under is
 * the skill the task named, read back from that first line, so a second
 * discovery skill needs no code and no list to keep its history apart from the
 * first's.
 *
 * What travels is the **link**, never the report: the parent is handed an id and
 * a page, puts links into the next run's task, and never reads one. The rolling
 * history each kind of report carries therefore has one home, which is the
 * reports themselves.
 */

/** The artifact kind a report is filed under. */
export const DISCOVERY_REPORT_KIND = "discovery-report";

/**
 * The label the report is filed under on its page, and the status its page is
 * locked in once it is there: what was handed over does not change, and a locked
 * page's event stream is finite, so a reader gets the whole report and an end.
 */
export const REPORT_LABEL = "report";
const FILED = "filed";

/** How many records the tool below lists. Older ones are in older reports. */
const MAX_LISTED = 12;

/**
 * The skill a task names, which is the line its report is filed under.
 *
 * Read from the task's **first line**, as `/<name>`, because that is the only
 * thing that loads a skill: Claude Code dispatches a prompt beginning with a
 * slash command and nothing else does, so a task without such a line ran no
 * skill and has no line to be filed under. Deriving the key from the same
 * string the CLI reads is what keeps the two from disagreeing; a field beside
 * it would be a second answer to one question.
 *
 * `[\w:-]+` is the CLI's own command-name shape. Nothing is trimmed from the
 * front: a prompt that does not *start* with the slash is not dispatched either.
 *
 * What the line cannot tell is whether the name **resolves**. A first line
 * naming no installed skill is not dispatched, and the session runs as an
 * ordinary prompt under a line it was never following, so the session is the
 * only party that can close that gap: `discoveryBrief` in `./session.ts` asks
 * it to say so rather than improvise the run.
 */
const COMMAND_LINE = /^\/([\w:-]+)(?:\s|$)/;

export function discoveryLine(task: string): string | undefined {
  return COMMAND_LINE.exec(task.split("\n", 1)[0] ?? "")?.[1];
}

// --- which reports are this caller's -----------------------------------------

/**
 * The reports this caller's agent filed, in the agent's own storage.
 *
 * The same arrangement plans have, for the same reason: an artifact's token is
 * the authority to read it and a link is shared by design, so holding one cannot
 * also be the authority to list it beside this caller's others. A report is this
 * caller's because this agent opened it.
 *
 * Pointers and dates, and no report text. A copy of what a report says would be
 * a second home for it, and the copy is the one that outlives the page's expiry.
 */
const TABLE = "claude_coordinator_discovery_reports";

/**
 * A row is the run's page from the moment `prepare` opens it, and **history
 * only once `filed_at` is on it**: a run is given an id to file onto before it
 * starts, so between those two moments its page holds nothing, and a page
 * holding nothing handed to a later run reads as an attempt that found nothing.
 * A run that is over and filed nothing has no row at all.
 */
function ensure(storage: DurableObjectStorage): void {
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, line TEXT, run_id TEXT, created_at INTEGER NOT NULL, filed_at INTEGER)`
  );
}

/** One record, as {@link recentReports} answers it. */
export interface ReportRecord {
  id: string;
  /** The skill it was filed under, or none when the task named none. */
  line?: string;
  at: number;
}

/**
 * Open a report for this caller, and forget the ones retention has taken: a page
 * lives for {@link ARTIFACT_RETENTION_MS} from when it was opened, and so does
 * its row here.
 *
 * `owner` is stamped on the artifact itself, and `createPlan` in `./plans.ts`
 * says what that buys and why no call site may leave it out.
 *
 * `sourceKey` names what opens it, so opening it again for the same run, as a
 * replayed `prepare` does, finds that run's page rather than a second one.
 */
export async function openReport(
  env: Env,
  storage: DurableObjectStorage,
  run: { line?: string; runId: string; sourceKey: string; owner: string }
): Promise<string> {
  const id = await requireArtifactsStub(env).createArtifact(
    DISCOVERY_REPORT_KIND,
    run.sourceKey,
    run.owner
  );
  ensure(storage);
  const now = Date.now();
  storage.sql.exec(
    `DELETE FROM ${TABLE} WHERE created_at < ?`,
    now - ARTIFACT_RETENTION_MS
  );
  storage.sql.exec(
    `INSERT OR IGNORE INTO ${TABLE} (id, line, run_id, created_at) VALUES (?, ?, ?, ?)`,
    id,
    run.line ?? null,
    run.runId,
    now
  );
  return id;
}

/** Drop a record, for a run that filed nothing on the page it opened. */
export function forgetReport(storage: DurableObjectStorage, id: string): void {
  ensure(storage);
  storage.sql.exec(`DELETE FROM ${TABLE} WHERE id = ?`, id);
}

/** Make a record history, for a run whose page holds its report. */
export function fileReport(storage: DurableObjectStorage, id: string): void {
  ensure(storage);
  storage.sql.exec(
    `UPDATE ${TABLE} SET filed_at = ? WHERE id = ?`,
    Date.now(),
    id
  );
}

/**
 * The page a run opened, for the link its completion carries.
 *
 * Read once the run's settle has decided what becomes of the row, which is the
 * ordering `formatDetachedCompletion` in `./agent.ts` already depends on: a run
 * that filed nothing has no row left by then.
 */
export function reportOfRun(
  storage: DurableObjectStorage,
  runId: string
): string | undefined {
  ensure(storage);
  return storage.sql
    .exec<{
      id: string;
    }>(`SELECT id FROM ${TABLE} WHERE run_id = ?`, runId)
    .toArray()[0]?.id;
}

/**
 * This caller's history, newest first: the reports that are filed, and none
 * retention has taken.
 *
 * Filtered before the limit, so a run still in flight cannot displace a report
 * from what a later run is briefed with. Age is read here as well as swept in
 * {@link openReport}, because the sweep runs on an open: a caller who has not
 * started a run since would otherwise be answered links to pages that are gone.
 */
export function recentReports(storage: DurableObjectStorage): ReportRecord[] {
  ensure(storage);
  return storage.sql
    .exec<{
      id: string;
      line: string | null;
      created_at: number;
    }>(
      `SELECT id, line, created_at FROM ${TABLE}
       WHERE filed_at IS NOT NULL AND created_at >= ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      Date.now() - ARTIFACT_RETENTION_MS,
      MAX_LISTED
    )
    .toArray()
    .map((row) => ({
      id: row.id,
      ...(row.line === null ? {} : { line: row.line }),
      at: row.created_at
    }));
}

/** Whether a page holds a report, which is what {@link FILED} locks it in. */
export async function reportWasFiled(env: Env, id: string): Promise<boolean> {
  const state = await requireArtifactsStub(env).artifactState(id);
  return state?.status === FILED;
}

// --- what the parent's model is offered --------------------------------------

/** `claude_code_discover`'s input: what to do, with the skill named first. */
export const DISCOVER_INPUT = z.object({
  task: z
    .string()
    .describe(
      "The run, with the skill it follows named on the **first line** as `/<skill-name>` and nothing else on that line: that line is what loads the skill, and without it the session is an ordinary one. Under it, what the person asked for in their words, anything the skill takes in its brief, and the links to earlier reports of the same skill from `discovery_reports`."
    )
});

export type DiscoverInput = z.infer<typeof DISCOVER_INPUT>;

/** What the parent model is told `claude_code_discover` does. */
export const DISCOVERER_DESCRIPTION = [
  "Hand a discovery run to a Claude Code session in a checkout of its own: it",
  "follows a skill your task names, reads, files what it finds wherever that",
  "skill says to, and changes nothing. No branch, no commits, no pull request.",
  "",
  "**Name the skill on the first line of the task, as `/<skill-name>`.** That",
  "line is what loads it, it is the only form that works for a skill of this",
  "kind, and it is what the run's report is filed under, so a later run of the",
  "same skill is given it. A task without one runs an ordinary session and its",
  "report is filed under no skill.",
  "",
  "It is told nothing about earlier runs except what you put in the task, so",
  "call `discovery_reports` first and pass the links for that skill, newest",
  "first and at most four. A run told nothing reports its window as unknown.",
  "",
  "What comes back is the session's account and a link to the report it filed.",
  "The report is for the person and for the next run: relay the link, and do",
  "not open it.",
  "",
  "It holds no state between runs, so a run that stopped to ask is answered by",
  "briefing a new one with the answers in its task.",
  "",
  "It runs in the background."
].join("\n");

/** What the parent model is told `discovery_reports` does. */
const REPORTS_DESCRIPTION = [
  "The reports earlier discovery runs filed: when each ran, the skill it ran",
  "under, and the link to its page. Call it before briefing",
  "`claude_code_discover` and put the links for the same skill into that",
  "session's task, newest first and at most four.",
  "",
  "A run appears here once it has filed, and a page expires, so a run missing",
  "from this list is one still working, one that filed nothing, or one whose",
  "page is past its keeping.",
  "",
  "Do not open one yourself: a report is for the person and for the run you are",
  "briefing."
].join("\n");

/** How long a page lives, as the tool says it. */
const RETENTION_DAYS = Math.round(ARTIFACT_RETENTION_MS / (24 * 60 * 60_000));

/**
 * `discovery_reports`: this caller's report pages, newest first.
 *
 * An agent tool rather than a plugin's, because it answers **links**, and a link
 * needs this deployment's own origin, which arrives with a turn and is on the
 * agent. A plugin's context carries no origin.
 */
export function reportsTool(ctx: {
  storage: DurableObjectStorage;
  /** This deployment's origin, read per call: a turn is what carries it. */
  origin: () => string | undefined;
}): Tool {
  return tool({
    description: REPORTS_DESCRIPTION,
    inputSchema: z.object({}),
    execute: async () => {
      const records = recentReports(ctx.storage);
      if (records.length === 0) {
        return (
          "No report of yours is on record. A discovery run briefed with none " +
          "knows nothing about earlier ones, and reports its window as unknown " +
          "rather than as clean."
        );
      }
      const origin = ctx.origin();
      if (origin === undefined) {
        return (
          `${records.length} ${records.length === 1 ? "report of yours is" : "reports of yours are"} on record, but this ` +
          "deployment's own name is not known on this instance yet, so there is " +
          "no link to give. Ask again on your next turn."
        );
      }
      return [
        `Reports of yours, newest first. Each is a page anyone holding its link can read, kept for ${RETENTION_DAYS} days.`,
        "",
        ...records.map((record) => {
          const when = new Date(record.at).toISOString();
          const line = record.line ? `/${record.line}` : "(no skill named)";
          return `- ${when} · ${line} · ${artifactViewerUrl(origin, record.id)}`;
        })
      ].join("\n");
    }
  });
}

// --- what a discovery session answers ----------------------------------------

/**
 * A discovery session's answer, as `DISCOVERY_OUTPUT` in `./schemas.ts`
 * describes it.
 *
 * Read as one object rather than a union on `status`, so each way of answering
 * badly gets a sentence of its own below: `done` with no report is a different
 * thing to tell the parent than an answer that did not parse at all.
 */
const DiscoveryAnswer = z.object({
  status: z.enum(["done", "needs_input", "blocked"]),
  report: z
    .string()
    .trim()
    .transform((text) => text || undefined)
    .optional(),
  lastReply: z.string(),
  questions: SessionQuestions.optional()
});

/** How much of the CLI's `API Error: …` sentence the parent is told. */
const API_ERROR_KEPT = 300;

/**
 * File what a discovery session answered, and tell the parent what became of it.
 *
 * The report goes onto the page `prepare` opened and locks it in the same call,
 * so no later note can change what was handed over. The parent is told that it
 * was filed and under which skill, never what it says: the link is appended by
 * the agent, which is the only place a URL can be built.
 *
 * **That holds on the paths where the answer is unreadable too**, which is why
 * only a session with no result at all falls through to {@link sessionReport}.
 * Its fallback is the session's own last message, and for a run answering
 * through `--json-schema` that message is the answer it failed to make, report
 * and all.
 *
 * The filing write asserts `run.owner` against the page's own, so it lands
 * only on a page this caller opened. `reportPlan` in `./children.ts` asserts a
 * plan's version the same way, and {@link FilingRun} says what the pair is.
 */
export async function reportDiscovery(
  env: Env,
  report: { id: string; line?: string },
  run: FilingRun,
  outcome: SessionOutcome
): Promise<string> {
  const result = outcome.session.result;
  // Nothing of the session's own words: it reports stderr and an exit code.
  if (!result) return sessionReport(outcome);
  const footer = `_${sessionFooter(result)}_`;
  const answer = DiscoveryAnswer.safeParse(result.structured);
  if (result.isError || !answer.success) {
    // Named from the CLI's own fields, or its own `API Error: …` sentence, and
    // never from anything else in `result.text`: a parent that is not given a
    // report is not given a broken one either.
    const how = result.isError
      ? result.text.startsWith("API Error")
        ? result.text.slice(0, API_ERROR_KEPT)
        : `it ended as \`${result.subtype}\`` +
          (result.apiErrorStatus === null
            ? ""
            : ` after an API ${result.apiErrorStatus}`)
      : "its answer was not in the shape this agent reads";
    // A run can file in the repository before it fails — an advisory, say — and
    // none of that is in an answer it never made.
    return [
      `**The discovery run filed no report**: ${how}. What it did in the repository before it ended stands but is not listed here, so look there before briefing a new run.`,
      footer
    ].join("\n\n");
  }
  const { lastReply, questions, status } = answer.data;

  if (status === "needs_input") {
    return [
      "**The discovery run stopped for the person's decision.** Nothing was filed.",
      lastReply,
      questions
        ? questionsText(questions)
        : "**It named no question.** Its account above is what it stopped on: ask the person what it leaves open, or brief a new run saying what it needs.",
      footer
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  if (status === "blocked" || answer.data.report === undefined) {
    return [
      status === "blocked"
        ? "**Blocked, and nothing was filed.**"
        : "**It answered with no report, so nothing was filed.** Read its account before briefing the run again.",
      lastReply,
      footer
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const filed = await requireArtifactsStub(env).addEntry(
    report.id,
    { label: REPORT_LABEL, text: answer.data.report, key: run.runId },
    { lock: FILED, owner: run.owner }
  );
  if (filed === null) {
    return [
      "**The report could not be filed**: its page is gone, was already closed, or is not a page this agent may write on. Nothing but the account below is left of what the session found, and the account is not the report: brief a new run if it is still wanted.",
      lastReply,
      footer
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return [
    report.line
      ? `**Report filed, under \`/${report.line}\`.**`
      : "**Report filed, under no skill**: the task named none on its first line, so no later run is given this one as history.",
    lastReply,
    footer
  ]
    .filter(Boolean)
    .join("\n\n");
}

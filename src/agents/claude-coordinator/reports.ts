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
  SessionQuestions
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

function ensure(storage: DurableObjectStorage): void {
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, line TEXT, run_id TEXT, created_at INTEGER NOT NULL)`
  );
}

/** One record, as {@link recentReports} answers it. */
export interface ReportRecord {
  id: string;
  /** The skill it was filed under, or none when the task named one. */
  line?: string;
  at: number;
}

/**
 * Open a report for this caller, and forget the ones retention has taken: a page
 * lives for {@link ARTIFACT_RETENTION_MS} from when it was opened, and so does
 * its row here.
 *
 * `sourceKey` names what opens it, so opening it again for the same run, as a
 * replayed `prepare` does, finds that run's page rather than a second one.
 */
export async function openReport(
  env: Env,
  storage: DurableObjectStorage,
  run: { line?: string; runId: string; sourceKey: string }
): Promise<string> {
  const id = await requireArtifactsStub(env).createArtifact(
    DISCOVERY_REPORT_KIND,
    run.sourceKey
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

/** The page a run opened, for the link its completion carries. */
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

/** This caller's records, newest first. */
export function recentReports(storage: DurableObjectStorage): ReportRecord[] {
  ensure(storage);
  return storage.sql
    .exec<{
      id: string;
      line: string | null;
      created_at: number;
    }>(
      `SELECT id, line, created_at FROM ${TABLE} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
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
  "A page expires, so a run that is not listed is gone rather than never made.",
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
          `${records.length} report${records.length === 1 ? "" : "s"} of yours are on record, but this ` +
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

/**
 * File what a discovery session answered, and tell the parent what became of it.
 *
 * The report goes onto the page `prepare` opened and locks it in the same call,
 * so no later note can change what was handed over. The parent is told that it
 * was filed and under which skill, never what it says: the link is appended by
 * the agent, which is the only place a URL can be built.
 */
export async function reportDiscovery(
  env: Env,
  report: { id: string; line?: string },
  runId: string,
  outcome: SessionOutcome
): Promise<string> {
  const result = outcome.session.result;
  const answer = DiscoveryAnswer.safeParse(result?.structured);
  if (!result || result.isError || !answer.success)
    return sessionReport(outcome);
  const footer = `_${sessionFooter(result)}_`;
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
    { label: REPORT_LABEL, text: answer.data.report, key: runId },
    { lock: FILED }
  );
  if (filed === null) {
    return [
      "**The report could not be filed**: its page is gone or was already closed. What the session found is in its account below and nowhere else.",
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

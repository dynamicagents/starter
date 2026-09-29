import {
  ARTIFACT_RETENTION_MS,
  requireArtifactsStub,
  type ArtifactEntry
} from "@dynamicagents/core/artifacts";
import { CLAUDE_CODE_WRITE_INPUT } from "@dynamicagents/plugins/claude-code";
import { z } from "zod";

/**
 * A plan, as `anthropic-coding` keeps one: an artifact of its own, which a
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

/** The writer's input, and the plan it carries out. */
export const WRITE_INPUT = CLAUDE_CODE_WRITE_INPUT.extend({
  plan: z
    .string()
    .optional()
    .describe(
      "The id of a plan to carry out — one claude_code_plan returned. The session is given the plan whole, so brief it on the work rather than restating the plan."
    )
});

/** What the parent model is told `claude_code_plan` does. */
export const PLANNER_DESCRIPTION = [
  "Have a Claude Code session work out a plan for a change, in a throwaway copy",
  "of your checkout: it reads the code and can run the tests, and changes",
  "nothing. The plan is filed on a page of its own. What comes back is the plan's",
  "id, its title and the session's account of it — not the plan itself: a",
  "writing session given the id reads it whole, and so does the person you ask to",
  "approve it, who gets its link with your question.",
  "",
  "To change a plan, call this again with `plan` set to its id, and say what",
  "to change; the new version goes on the same page. A plan that was approved is",
  "locked and cannot change — write a new one instead.",
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
        "The plan, in Markdown, for the person who approves it: what will change and where, what stays as it is, and how the result will be checked. Complete on its own — the session that carries it out is given this, and nothing of your investigation."
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
const TABLE = "anthropic_coding_plans";

function ensure(storage: DurableObjectStorage): void {
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`
  );
}

/**
 * Open a plan for this caller, and forget the ones retention has taken: an
 * artifact lives for {@link ARTIFACT_RETENTION_MS} from when it was opened, and
 * so does its row here.
 */
export async function createPlan(
  env: Env,
  storage: DurableObjectStorage
): Promise<string> {
  const id = await requireArtifactsStub(env).createArtifact(PLAN_KIND);
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

/** A plan as a session is given it, or why it cannot be. */
export type PlanLookup =
  | {
      ok: true;
      plan: string | undefined;
      locked: boolean;
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
    page: artifact.entries
  };
}

/** The latest version of the plan on a page, or none yet. */
export function latestPlan(page: readonly ArtifactEntry[]): string | undefined {
  for (let i = page.length - 1; i >= 0; i--) {
    if (page[i]!.label === PLAN_LABEL) return page[i]!.text;
  }
  return undefined;
}

/** A version of the plan as it is filed: its title over it. */
export function planText(answer: PlanAnswer): string {
  return `# ${answer.title.trim()}\n\n${answer.plan.trim()}`;
}

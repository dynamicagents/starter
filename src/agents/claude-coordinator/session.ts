import type {
  ClaudeCodeResult,
  SessionEnd,
  SessionOutcome
} from "@dynamicagents/plugins/claude-code";
import { z } from "zod";
import { CLAUDE_CODE_SESSION } from "@/config";

/**
 * What a Claude Code session is told, and what its parent is told back.
 *
 * The model in `@dynamicagents/plugins/claude-code` runs the session and keeps
 * its place; everything worded here is this deployment's: the brief around the
 * task, the one warning a session gets for leaving work uncommitted, and the
 * report the parent reads. Pure functions and shell scripts, so each rule is
 * tested without a container.
 */

/**
 * How a session the host stopped exits: Claude Code's answer to the `SIGTERM`
 * `stop` in `@dynamicagents/plugins/claude-code` sends.
 */
export const STOPPED_EXIT = 143;

/**
 * What a session cost, as one line under its report.
 *
 * Added here because nothing else reports it: the session's own model is not
 * one core meters. What a session spent is worth knowing when the bucket is
 * shared with a human at their desk.
 *
 * Exported so the one part with a rule in it is tested without driving a whole
 * session against a container the suite deliberately never starts.
 *
 * **`denials` is the field worth arguing for.** A denied tool call is invisible
 * in a session's own account of itself — the model narrates an alternative
 * approach and carries on — so a run that was fenced in reads as a run that was
 * being thoughtful. This deployment shipped a release where every session was
 * refused every write, reported `completed`, and left `permission_denials`
 * parsed by the stream reader and read by nobody. The count was in the result
 * line the whole time.
 *
 * Shown only when non-zero, and a non-zero count is not a failure: a deny rule
 * firing on one command is a rule doing its job. It means the report should not
 * be read at face value, which is what a footer is for.
 */
export function sessionFooter(result: {
  numTurns?: number;
  durationMs?: number;
  costUsd: number;
  usage: { cacheRead: number };
  permissionDenials: number;
}): string {
  return [
    `turns: ${result.numTurns ?? "?"}`,
    `duration: ${Math.round((result.durationMs ?? 0) / 1000)}s`,
    `cost: $${result.costUsd.toFixed(4)}`,
    `cache reads: ${result.usage.cacheRead}`,
    ...(result.permissionDenials > 0
      ? [`denials: ${result.permissionDenials}`]
      : [])
  ].join(" · ");
}

/**
 * What a session is told about GitHub. `gh` and git present a placeholder and
 * the egress gateway swaps in the deployment's token — see `githubToken` in
 * `./claude-code.ts` — so both work and neither can leak it.
 *
 * Every session gets the first half. Only a writer on a branch gets the rules,
 * because only it pushes, and they are prompt-only: the token can do more than
 * they allow, which is why the deployment's rulesets back them.
 */
const GITHUB_NOTE = `## GitHub

\`gh\` and \`git\` are signed in to GitHub. The credential is held outside this
container and added on the way out, so there is no token here to read or print. Use
them to read issues, pull requests, reviews and CI.`;

/**
 * The rules a writer works under. The last one is why the coordinator exists:
 * a session that waits on a review keeps a container running for minutes, and
 * the agent that briefed it watches the pull request for nothing.
 */
const OWNERSHIP_NOTE = `This branch and its pull request are yours, within limits that are not negotiable:

- Push this branch and no other. Never push to the default branch, never force-push,
  never delete a branch.
- Never merge, approve, or enable auto-merge. Merging is the person's.
- Never request a reviewer, Copilot included. Opening the pull request asks for its
  one review, and another costs money.
- **Never wait for a review or for CI** — no sleeping, no polling. Finish and report.
  The agent that briefed you watches the pull request and brings you back when
  something lands. This holds whatever the repository's own instructions say.`;

/**
 * How often a **writing** session runs the project's checks: on the tree it
 * commits, against the base its brief or plan already gives. Each full run is
 * minutes of container time the caller waits through, and unsaid a session
 * repeats them.
 */
const CHECK_NOTE = `## Checking your work

Run the project's checks and tests on the tree you commit, and again only after changing
something they cover. What the task or the plan says about the base — a test count, a
passing suite — was measured already: compare against it instead of running the base
again. A full run takes minutes in this container, and every repeat is time the person
asking waits.`;

/**
 * How a **building** session finishes: the pull request is its own, opened
 * ready for review because opening it is what requests the one review a pull
 * request gets.
 */
const DELIVERY_NOTE = `## Delivering it

When the work is done and the project's checks pass, push this branch and open a pull
request from it into the default branch — **ready for review, not a draft**: opening it
is what asks for its review. If one is already open from this branch, push to it rather
than open another. Write the description for the person who will merge it: what changed
and why, how you checked it, and what deserves a close look. Anything broken you noticed
outside the task goes there, not into the diff.

If the work changed nothing — the task was to find something out, or there was nothing to
do — push nothing and open nothing.

If you reach a decision only the person who asked can make, do not guess. Commit and push
what you have, and answer with \`needs_input\` and the question: you will be resumed with
their answer.`;

/**
 * How a **revising** session works on the pull request it opened. What brought
 * it back is its task, in the coordinator's words; how to answer each kind of
 * thing is said here once, so the coordinator never has to.
 */
function reviseNote(pr: { number: number; url?: string }): string {
  return `## Pull request #${pr.number}

${pr.url ? `${pr.url} is` : "It is"} open from this branch, and it is yours. What brought you back
is at the top.

- **A self-review**: have a subagent with none of this conversation review the pull
  request's diff against what it was for, then improve what holds up — correctness and
  tests first, then simplicity. Nothing outside the task.
- **A review**: answer it in one pass. Read the review's body as well as its threads,
  since a review can raise points that are not threads, and read each point against the
  code — a reviewer is sometimes confidently wrong. Fix what holds up and push, then reply
  on every thread, naming the commit or saying why not, and resolve it either way
  (\`resolveReviewThread\`, through \`gh api graphql\`).
- **A failing check**: read its log (\`gh run view --log-failed\`), fix the cause, push.
- **Something the person asked for**: do it, on this branch.

Before you finish, look once at the pull request's review and checks, and answer whatever
landed while you worked. Then stop: do not wait for anything still running.`;
}

/**
 * What a writing session must answer, as \`--json-schema\`, so the coordinator
 * reads fields rather than prose. The descriptions are the session's
 * instructions for each one.
 */
export const WRITE_OUTPUT = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["done", "needs_input", "blocked"],
      description:
        "`done`: the work is finished, or there was nothing to change. `needs_input`: you stopped at a decision only the person who asked can make. `blocked`: you could not finish, and `summary` says where you stopped and why."
    },
    summary: {
      type: "string",
      description:
        "For the agent that briefed you, which relays it to the person: what you changed and why, or what you found. On a pull request, say whether you answered its review and how its checks stand. Plain and short."
    },
    pullRequest: {
      type: "object",
      properties: {
        number: { type: "integer" },
        url: { type: "string" }
      },
      required: ["number", "url"],
      additionalProperties: false,
      description:
        "The pull request you opened or pushed to. Leave it out when you pushed nothing."
    },
    checks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          passed: { type: "boolean" }
        },
        required: ["command", "passed"],
        additionalProperties: false
      },
      description:
        "What you ran to check the work, each with whether it passed. Only what you ran."
    },
    question: {
      type: "string",
      description:
        "Required with `needs_input`: the one question only the person can answer, with the options you see."
    }
  },
  required: ["status", "summary"],
  additionalProperties: false
} as const;

/** A writing session's answer, as {@link WRITE_OUTPUT} describes it. */
export const WriteAnswer = z.object({
  status: z.enum(["done", "needs_input", "blocked"]),
  summary: z.string(),
  pullRequest: z
    .object({ number: z.number().int(), url: z.string() })
    .optional(),
  checks: z
    .array(z.object({ command: z.string(), passed: z.boolean() }))
    .optional(),
  question: z.string().optional()
});

export type WriteAnswer = z.infer<typeof WriteAnswer>;

/** How the coordinator reads a writing session's answer. */
export function answerText(answer: WriteAnswer): string {
  const status = {
    done: "**Done.**",
    needs_input: "**Stopped for the person's decision.**",
    blocked: "**Blocked.**"
  }[answer.status];
  const pr = answer.pullRequest
    ? ` Pull request #${answer.pullRequest.number}: ${answer.pullRequest.url}`
    : "";
  const checks = answer.checks?.length
    ? `Checks run: ${answer.checks
        .map((c) => `\`${c.command}\` ${c.passed ? "passed" : "FAILED"}`)
        .join("; ")}.`
    : "";
  // A stop for a decision that names none still has to say so, or the
  // coordinator has nothing to ask and nothing to tell it is missing.
  const question =
    answer.status !== "needs_input"
      ? ""
      : answer.question?.trim()
        ? `**Question for the person:** ${answer.question.trim()}`
        : "**It named no question.** Its summary above is what it stopped on: ask the person what it leaves open, or send it back to say what it needs.";
  return [`${status}${pr}`, answer.summary.trim(), checks, question]
    .filter(Boolean)
    .join("\n\n");
}

/** One repository a writing session could commit in, and where it started. */
export interface RepoStart {
  path: string;
  start: string;
}

/** What one repository holds uncommitted, as `git status --porcelain` names it. */
export interface Uncommitted {
  path: string;
  files: string[];
}

/** What a writing session left on its branch. */
export interface WritingOutcome {
  branch: string;
  /** Commits past where each repository started; `count` absent where uncounted. */
  commits: { path: string; count?: number }[];
  /** What was still uncommitted when the session ended. */
  discarded: Uncommitted[];
  /**
   * Whether deleting it failed, which changes what the note above can claim: the
   * files are listed either way, and only this says which of the two happened.
   */
  discardFailed?: boolean;
}

/**
 * What a **writing** session is told about the branch it is already on.
 *
 * The host checked it out before this session started, so the two things worth
 * saying are the two a session would otherwise get wrong: commit, because only
 * commits outlive the session; and do not push or switch branches, because the
 * agent that briefed you pushes, and finds the work by this name.
 */
function branchNote(
  branch: string,
  submodules: readonly string[],
  continues: boolean
): string {
  const note = `## Your branch

You are on \`${branch}\`, checked out for you in a worktree nobody else is working in
while you are.${continues ? " It already holds earlier work: read its log before you start, and build on it." : ""}

**Commit what you want to keep.** Only commits leave this session, and anything left
uncommitted is deleted when you finish. Commit as you go if that suits you.

Do not switch or rename the branch. The name above is how your work is found.

${OWNERSHIP_NOTE}`;
  if (submodules.length === 0) return note;
  return `${note}

### Submodules

${submodules.map((path) => `- \`${path}\``).join("\n")}

Each is a repository of its own, on \`${branch}\` too. **Commit inside each one you
change** — only a submodule's own commits are kept — and push it there under the same
branch name. Recording the new commit in the superproject is a separate commit, and
only if the task asks for it. Only one level of submodules is checked out.

Dependencies are installed at the top of the checkout, and in a submodule only when the
repository's own install covers it. Run \`npm ci\` in a submodule whose \`node_modules\` is
empty before building or testing it — not in one that has a tree, which is installed.`;
}

/** Every file, since a deleted one's name is kept nowhere else. */
function listFiles(files: readonly string[]): string {
  return files.map((file) => `\`${file}\``).join(", ");
}

/** A repository by the name a reader knows it by. */
function repoLabel(path: string, many: boolean): string {
  if (path !== ".") return `\`${path}\``;
  return many ? "the superproject" : "the repository";
}

/**
 * The one turn a session gets when it left work uncommitted.
 *
 * Once, and only after a session that finished: whatever is still uncommitted
 * after it is deleted, so a second reminder would be a second chance to say the
 * same thing, paid for again.
 */
export function warningPrompt(dirty: readonly Uncommitted[]): string {
  const many = dirty.length > 1 || dirty.some((repo) => repo.path !== ".");
  return [
    "You left changes uncommitted, and they will be deleted when this session ends:",
    "",
    ...dirty.map(
      (repo) => `- ${repoLabel(repo.path, many)}: ${listFiles(repo.files)}`
    ),
    "",
    "Commit what should be kept, in the repository it belongs to, push it, and leave the rest. " +
      "Then reply with one line saying what you committed."
  ].join("\n");
}

/**
 * What the parent is told about the branch, in the terms it has to act on.
 *
 * Its own sentence rather than left to the session's account of itself, because
 * the session cannot know what survived it: the discard runs after it exits. A
 * writing session that says nothing about its branch is one the parent cannot
 * review, so every outcome says something — including no commits, which
 * otherwise reads as a lost branch rather than a considered no-op.
 */
export function writingNote(writing: WritingOutcome): string {
  const many = writing.commits.length > 1;
  const committed = writing.commits.filter((repo) => repo.count !== 0);
  const lines: string[] = [];
  if (committed.length === 0) {
    lines.push(
      `**No commits were made on \`${writing.branch}\`.** ` +
        "Read the report above before delegating it again."
    );
  } else {
    const where = committed
      .map((repo) => {
        const count =
          repo.count === undefined
            ? " (uncounted)"
            : ` (${repo.count} commit${repo.count === 1 ? "" : "s"})`;
        return `${repoLabel(repo.path, many)}${count}`;
      })
      .join(", ");
    lines.push(
      `**Committed on \`${writing.branch}\`** in ${where}. To add to it before ` +
        "there is a pull request, delegate with `continue` set to that branch; " +
        "once there is one, `claude_code_revise` with its number."
    );
  }
  if (writing.discarded.length > 0) {
    lines.push(
      `${
        writing.discardFailed
          ? "**Still uncommitted — deleting it failed**, so these are in the worktree:"
          : "**Deleted, uncommitted:**"
      } ${writing.discarded
        .map(
          (repo) => `${repoLabel(repo.path, many)}: ${listFiles(repo.files)}`
        )
        .join("; ")}.`
    );
  }
  return lines.join("\n\n");
}

/**
 * What the session is asked to do.
 *
 * The task the parent wrote, plus whatever the workspace has to say for itself.
 * A Claude Code session has no view of the parent's conversation and cannot
 * ask, so anything that matters has to be inline — the same contract every
 * sub-agent here works under, said to a different process. The workspace note
 * is inline for the same reason: the session cannot query the host, and a broken
 * install or a workspace that has stopped accepting writes is the difference
 * between a failure worth retrying and one that never will be.
 *
 * A writer on a branch finishes by delivering a pull request, or — given one —
 * by revising it.
 */
export function sessionBrief(
  task: string,
  note?: string,
  writing?: {
    branch: string;
    submodules: readonly string[];
    continues: boolean;
  },
  plan?: {
    /** The plan it carries out, as the caller was shown it. */
    text: string;
    /** Whether it carries on from the conversation that wrote the plan. */
    resumed: boolean;
  },
  pullRequest?: { number: number; url?: string }
): string {
  const parts = [task, "", GITHUB_NOTE];
  // On a branch only. A scratchpad session has none, and keeps what it leaves
  // in the tree, so a brief that asked it to commit would be wrong about both.
  if (writing) {
    parts.push(
      "",
      branchNote(writing.branch, writing.submodules, writing.continues),
      "",
      CHECK_NOTE,
      "",
      pullRequest ? reviseNote(pullRequest) : DELIVERY_NOTE
    );
  }
  if (plan) parts.push("", planNote(plan.text, plan.resumed));
  if (note) {
    parts.push("", "## The state of this workspace", "", note);
  }
  return parts.join("\n");
}

/**
 * The plan a writing session carries out, whole: the text the caller read, not
 * the parent's account of it — see `./plans.ts`.
 *
 * **Whole even when the session wrote it.** One carrying on from the planning
 * conversation has every version it wrote in context, and the one approved is
 * the one to build: stating it costs a page, and building another costs the
 * review. That session is also still under the last thing it was told — that it
 * plans and changes nothing — so its note says first that planning is over.
 */
function planNote(plan: string, resumed: boolean): string {
  if (resumed) {
    return `## Carrying out your plan

The plan you wrote in this conversation was approved, as it stands below. Planning is
over: you are no longer in plan mode, so edit and run what the work needs. Carry the
plan out. Where the work shows it is wrong, say so in your reply rather than quietly
doing something else.

${plan}`;
  }
  return `## The plan

This is the plan for the work above, as the person who asked for it read it. Carry it
out. Where the work shows it is wrong, say so in your reply rather than quietly doing
something else.

${plan}`;
}

/**
 * What a **planning** session is told about its answer and, for an edit, about
 * the plan it changes. What each field of the answer is for is in the schema
 * the CLI hands it, so it is not said twice here.
 *
 * An edit that carries on from the conversation that wrote the plan is told
 * only what is new — what the person said — since the plan, the code it read
 * and these instructions are already in its context.
 */
export function planBrief(
  task: string,
  note?: string,
  editing?: { plan?: string; said: readonly string[]; resumed?: boolean }
): string {
  const parts = editing?.resumed
    ? [
        task,
        "",
        `## Revising your plan

The person read the plan you wrote and asked for the changes above. Revise it, and answer
again through the StructuredOutput tool with the whole plan as it should now stand.`
      ]
    : [
        task,
        "",
        GITHUB_NOTE,
        "",
        `## Your answer

You are writing a plan, not making the change: you are in Claude Code's plan mode, and
anything that would change the tree is refused. Read what the change will touch, and
answer through the StructuredOutput tool.`
      ];
  if (editing?.plan && !editing.resumed) {
    parts.push("", "## The plan you are changing", "", editing.plan);
  }
  if (editing && editing.said.length > 0) {
    parts.push(
      "",
      "## What the person said about it, oldest first",
      "",
      ...editing.said.map((line) => `- ${line}`)
    );
  }
  if (note) {
    parts.push("", "## The state of this workspace", "", note);
  }
  return parts.join("\n");
}

/**
 * What the parent is told of a planning session: the plan's id and title, and
 * what the session had to say about it — never the plan, which the parent hands
 * on by its id.
 */
export function planReport(
  outcome: SessionOutcome,
  filed:
    | {
        kind: "filed";
        id: string;
        title: string;
        lastReply: string;
      }
    | { kind: "unanswered" }
    | { kind: "locked"; id: string; lastReply: string }
): string {
  const result = outcome.session.result;
  const footer = result ? `_${sessionFooter(result)}_` : "";
  if (filed.kind === "filed") {
    return [`**Plan \`${filed.id}\`: ${filed.title}**`, filed.lastReply, footer]
      .filter(Boolean)
      .join("\n\n");
  }
  if (filed.kind === "locked") {
    return [
      `**The plan \`${filed.id}\` was not changed**: it was locked while the session ran, or it is gone. Write a new plan if it still needs one.`,
      filed.lastReply,
      footer
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return `**The planning session returned no plan, so nothing was filed.**\n\n${sessionReport(outcome)}`;
}

/**
 * How the CLI refuses a `--resume` whose conversation is not where it looks: a
 * `result` line, an error, this sentence in `errors`, no model call. Measured
 * by the probe in `@dynamicagents/plugins`, which fails a version that answers
 * any other way.
 */
const NO_CONVERSATION = "No conversation found";

/** Whether a run that carried on from a conversation found it gone. */
export function notResumable(outcome: SessionOutcome): boolean {
  const result = outcome.session.result;
  return (
    result?.isError === true &&
    (result.errors ?? []).some((error) => error.startsWith(NO_CONVERSATION))
  );
}

/**
 * What the parent is told when the conversation a run was to carry on from is
 * gone. Nothing ran and nothing was spent, and its record is forgotten, so the
 * same call again starts fresh from the plan's text.
 */
export function unresumableReport(kind: "plan" | "write"): string {
  return kind === "plan"
    ? "**The conversation that wrote this plan is gone from its workspace, so nothing was revised.** Nothing was spent. Call claude_code_plan again with the same plan and comment: the next session starts from the plan's text."
    : "**The planning session's conversation is gone from its workspace, so nothing was built.** Nothing was spent and no branch has work on it. Delegate again with the same plan: the next session starts from the plan's text.";
}

/** Each listed repository and the commit it is on. */
export const READ_HEADS = `while IFS= read -r p; do
  [ -n "$p" ] || continue
  printf '%s\\t%s\\n' "$p" "$(git -C "$p" rev-parse HEAD 2>/dev/null)"
done <<EOF
$REPO_PATHS
EOF`;

/**
 * What each listed repository holds uncommitted: its path, a tab, a file.
 * Ignored files are not listed — they are not work anybody forgot to commit.
 */
export const LIST_UNCOMMITTED = `while IFS= read -r p; do
  [ -n "$p" ] || continue
  git -C "$p" status --porcelain --ignore-submodules=all | while IFS= read -r line; do
    printf '%s\\t%s\\n' "$p" "\${line#???}"
  done
done <<EOF
$REPO_PATHS
EOF`;

/**
 * Delete what each listed repository holds uncommitted, ignored files included —
 * the parent reviews this tree, and a half-built `dist/` in it is not the
 * branch. `node_modules` is spared: a mount point `clean` cannot remove.
 *
 * **The status is accumulated, not inherited.** A loop exits with its last
 * command's status, so a failed `reset` would be reported as a success by the
 * `clean` after it, and any repository's failure by the next repository's. The
 * caller labels these files deleted, so a masked failure is a report naming
 * files that are still on disk.
 */
export const DISCARD = `rc=0
while IFS= read -r p; do
  [ -n "$p" ] || continue
  git -C "$p" reset -q --hard || rc=1
  git -C "$p" clean -ffdxq -e node_modules || rc=1
done <<EOF
$REPO_PATHS
EOF
exit $rc`;

/** Commits each listed repository has past where it started. */
export const COUNT_COMMITS = `tab="$(printf '\\t')"
while IFS="$tab" read -r p start; do
  [ -n "$p" ] || continue
  printf '%s\\t%s\\n' "$p" "$(git -C "$p" rev-list --count "$start..HEAD" 2>/dev/null)"
done <<EOF
$REPO_STARTS
EOF`;

/** Tab-separated lines as fields. */
export function tabbed(out: string): string[][] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

/**
 * What the parent receives for a finished session.
 *
 * **The text can never be empty.** A session that exits 0 having said nothing,
 * and one whose `result` event never arrived because the process died first,
 * both get a sentence saying so rather than a report that reads as silence.
 *
 * **The session's own words are passed whole.** `result.text` is its last
 * message, or an error the CLI wrote: command output never reaches it, and
 * Claude Code's per-response output limit bounds it. The parent cannot fetch a
 * part cut from it, and the middle is where a report's findings are.
 *
 * The footer under both is {@link sessionFooter}, which carries its own
 * reasoning — including why a denial count belongs beside the cost.
 */
export function sessionReport(
  outcome: SessionOutcome,
  writing?: WritingOutcome
): string {
  const { session } = outcome;
  const result = session.result;
  const kept = writing ? writingNote(writing) : "";

  if (!result) {
    /**
     * The one path with no account of itself, so stderr is all there is.
     *
     * A process that dies before its first JSON line leaves the stream empty
     * — a rejected flag, a permission mode the CLI refuses under root, a Node
     * crash. Reported as an exit code alone, every one of those reads the
     * same, and the operator's next move is to guess. The drain keeps a
     * bounded slice for exactly this sentence.
     */
    const said = session.stderr?.trim();
    return (
      `The Claude Code session (${CLAUDE_CODE_SESSION.model}) exited with code ` +
      `${session.exitCode} without reporting a result. Its output was lost with the process.` +
      (said ? `\n\nIt printed:\n\n\`\`\`\n${said}\n\`\`\`` : "") +
      (kept ? `\n\n${kept}` : "")
    );
  }

  const footer = sessionFooter(result);

  if (result.isError) {
    const detail =
      result.text ||
      `the session ended as ${result.subtype}` +
        (result.apiErrorStatus === null
          ? ""
          : ` after an API ${result.apiErrorStatus}`);
    return [`The session failed: ${detail}`, kept, `_${footer}_`]
      .filter(Boolean)
      .join("\n\n");
  }

  const answer = WriteAnswer.safeParse(result.structured);
  const text = answer.success
    ? answerText(answer.data)
    : result.text ||
      "The session completed and reported nothing. Check the working tree " +
        "before assuming the change was made.";
  const warning = outcome.followUp?.result;
  return [
    text,
    kept,
    `_${footer}_`,
    warning ? `_warning turn: ${sessionFooter(warning)}_` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The writer's `followUp`: one turn for a session that left work uncommitted. */
export function needsWarning(session: SessionEnd): boolean {
  const result: ClaudeCodeResult | undefined = session.result;
  return Boolean(result && !result.isError && result.sessionId);
}

import type {
  ClaudeCodeResult,
  SessionEnd,
  SessionOutcome
} from "@dynamicagents/plugins/claude-code";
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
 * What `gh` is, in a container that holds no credential.
 *
 * A session reaches for it unprompted — it is the obvious way to read an issue or
 * a review — and until it was installed that cost a turn per attempt to exit 127.
 * It is there now and signed in to nothing, which is a *third* state neither the
 * model nor its training expects — and a narrower one than it sounds: REST reads
 * of public repositories work, while every GraphQL-backed command (`gh pr view`
 * among them) and every write fails in a way that reads like a misconfiguration
 * rather than a boundary.
 *
 * So both halves are stated, and the second names who does hold the credential.
 * The Dockerfile carries why it is unauthenticated.
 */
const GH_NOTE = `## \`gh\` in this container

\`gh\` is installed and authenticated as nobody, so only its REST calls work: use
\`gh api repos/OWNER/REPO/pulls/N\` (and \`/comments\`, \`/files\`, \`/reviews\`), or the
same under \`issues/N\`, for public repositories. \`gh pr view\`, \`gh issue view\` and
the other high-level commands go through GitHub's GraphQL API, which refuses anonymous
callers outright — they will fail however they are phrased. Nothing writes, and no
private repository can be read. There is no credential here to fix that with.

Pull requests and replies to a review belong to the agent that briefed you, which
holds the credential on the other side of this container. Report what you changed and
let it deliver.`;

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

**Commit what you want to keep.** Only commits leave this session — the agent that
briefed you reviews the commits on this branch and pushes them — and anything left
uncommitted is deleted when you finish. Commit as you go if that suits you.

Do not push, and do not switch or rename the branch. The name above is how your work
is found.`;
  if (submodules.length === 0) return note;
  return `${note}

### Submodules

${submodules.map((path) => `- \`${path}\``).join("\n")}

Each is a repository of its own, on \`${branch}\` too. **Commit inside each one you
change** — only a submodule's own commits are kept. Recording the new commit in the
superproject is a separate commit, and only if the task asks for it. Only one level
of submodules is checked out.

Dependencies are installed at the top of the checkout only. Run \`npm ci\` in a
submodule before building or testing it.`;
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
    "Commit what should be kept, in the repository it belongs to, and leave the rest. " +
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
      `**No commits were made on \`${writing.branch}\`**, so there is nothing to review. ` +
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
      `**Committed on \`${writing.branch}\`** in ${where}. Nothing is pushed. ` +
        `\`repo_worktree\` with that branch puts your tools in the worktree holding it, ` +
        "to review, push and open the pull request from there. Delegate with " +
        "`continue` set to it to add to the work."
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
 * {@link GH_NOTE} is here for the same reason and earns its tokens the same way:
 * what a session cannot find out by looking, and would otherwise spend turns
 * discovering by failing.
 */
export function sessionBrief(
  task: string,
  note?: string,
  writing?: {
    branch: string;
    submodules: readonly string[];
    continues: boolean;
    /** The plan it carries out, as the caller was shown it. */
    plan?: string;
  }
): string {
  const parts = [task, "", GH_NOTE];
  // Writing only. A reading session works in a copy that is deleted when it
  // ends, and the plugin tells it so; a brief that asked it to commit would
  // spend the session on work nobody will see.
  if (writing) {
    parts.push(
      "",
      branchNote(writing.branch, writing.submodules, writing.continues)
    );
    if (writing.plan) parts.push("", planNote(writing.plan));
  }
  if (note) {
    parts.push("", "## The state of this workspace", "", note);
  }
  return parts.join("\n");
}

/**
 * The plan a writing session carries out, whole: the text the caller read, not
 * the parent's account of it — see `./plans.ts`.
 */
function planNote(plan: string): string {
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
 */
export function planBrief(
  task: string,
  note?: string,
  editing?: { plan?: string; said: readonly string[] }
): string {
  const parts = [
    task,
    "",
    GH_NOTE,
    "",
    `## Your answer

You are writing a plan, not making the change: this is a copy of the checkout, and nothing
you change in it is kept. Read what the change will touch, run what tells you how it
behaves, and answer through the StructuredOutput tool.`
  ];
  if (editing?.plan) {
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

  const text =
    result.text ||
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

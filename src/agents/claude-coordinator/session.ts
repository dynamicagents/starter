import type {
  ClaudeCodeResult,
  SessionEnd,
  SessionOutcome
} from "@dynamicagents/plugins/claude-code";
import { MAX_ASK_OPTIONS } from "@dynamicagents/core/agent";
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
 * The rules a writer works under, on its own branch or on the branches it was
 * sent back to. The last one is why the coordinator exists: a session that
 * waits on a review keeps a container running for minutes, and the agent that
 * briefed it watches the pull request for nothing.
 */
function ownershipNote(many: boolean): string {
  return `${many ? "These branches and their pull requests are" : "This branch and its pull request are"} yours, within limits that are not negotiable:

- Push ${many ? "those branches and no others" : "this branch and no other"}. Never push to the default branch, never force-push,
  never delete a branch.
- Never merge, approve, or enable auto-merge. Merging is the person's.
- Never request a reviewer, Copilot included. Opening a pull request asks for its
  one review, and another costs money.
- **Never wait for a review or for CI** — no sleeping, no polling. Finish and report.
  The agent that briefed you watches the pull requests and brings you back when
  something lands. This holds whatever the repository's own instructions say.`;
}

/**
 * The bar a writing session works to, and when a deviation from what it was
 * handed is the person's call rather than its own.
 *
 * Here rather than inside the delivery and revision notes below, because both
 * need it and a session that reaches the question has to have been told the
 * channel before it starts. The failure it addresses is the one a session
 * commits silently: the smaller, safer change, taken because asking costs a
 * round trip and reported as success. The threshold is design, shape and scope
 * — a mechanical difference is the session's own, and goes in its summary.
 */
const DESIGN_NOTE = `## The bar for this work

You are the engineer on this, not a courier for the quickest diff that passes. A design
that is still right in a year is worth more than finishing early.

**A deviation of design, shape or scope is a question, not a call you make quietly.**
Where the work shows a better shape than the one you were handed — a refactor it has made
obviously worth doing, a different place for the change, a scope that has to grow for the
design to be right — say what you were going to do, what you would do instead, and what
each costs, then ask before you build it. Growing the task for a design worth having is
wanted here, and there may be reasons you cannot see for the shape you were given: that is
why it is a question and not a decision.

The failure to avoid is the quiet one: taking the smaller, safer change you can finish now
because asking costs a round trip. That ends with a session reporting success and a person
reading a design they did not want.

Mechanical deviations are yours — a helper under another name, a test in another file, an
order the code forces. Make them, and say so in your summary.

When you have a question, do not guess. Commit and push what you have, and answer with
\`needs_input\` and everything you need from them at once, each question with the options
you see: you are resumed with their answers, and what you committed is kept.`;

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
do — push nothing and open nothing.`;

/**
 * How a **revising** session works on the branches it was sent back to. What
 * brought each back is in its task, in the coordinator's words; how to answer
 * each kind of thing is said here once, so the coordinator never has to.
 */
const REVISE_NOTE = `## What brought you back

Each branch above says what landed on it. Its pull requests are yours: there may be one in
each repository the branch is in.

- **A self-review**: have a subagent with none of this conversation review the pull
  request's diff against what it was for, then improve what holds up — correctness and
  tests first, then the shape of what was written: modularity, the idiom of the code
  around it, duplication and debt it added. **The diff is the subject**: this pass makes
  what is there better, and does not go looking for work elsewhere or for behaviour to add.
- **A review**: answer it in one pass. Read the review's body as well as its threads,
  since a review can raise points that are not threads, and read each point against the
  code — a reviewer is sometimes confidently wrong. A point you would answer by adding
  behaviour the pull request was not for, or by materially changing its design or scope,
  is not a fix: ask rather than build it under cover of a review. Correcting what a point
  shows is wrong is a fix, however visibly the behaviour changes. Fix what holds up and
  push, then reply on every thread, naming the commit or saying why not, and
  resolve it either way (\`resolveReviewThread\`, through \`gh api graphql\`).
- **A failing check**: read its log (\`gh run view --log-failed\`), fix the cause, push.
- **Something the person asked for**: do it, on that branch.

Before you finish, look once at each pull request's review and checks, and answer whatever
landed while you worked. Then stop: do not wait for anything still running.`;

export { WRITE_OUTPUT } from "./schemas";

/** Words a session may leave blank, read as left out. */
const optionalText = z
  .string()
  .trim()
  .transform((text) => text || undefined)
  .optional();

/**
 * What a session that stops asks the person, as `QUESTIONS` in `./schemas.ts`
 * describes it — and as core's `ask_user` takes it, which the parent passes
 * them to whole.
 */
export const SessionQuestions = z
  .array(
    z.object({
      question: z.string().trim().min(1),
      header: optionalText,
      options: z
        .array(
          z.object({
            label: z.string().trim().min(1),
            description: optionalText,
            example: optionalText
          })
        )
        .min(2)
        .max(MAX_ASK_OPTIONS)
        .optional(),
      multiple: z.boolean().optional()
    })
  )
  .min(1);

export type SessionQuestions = z.infer<typeof SessionQuestions>;

/**
 * `value` as a fenced JSON block, its fence longer than any run of backticks
 * inside — an option's example is Markdown, and its own fence would close a
 * shorter one.
 */
function jsonBlock(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  const longest = Math.max(
    0,
    ...(json.match(/`+/g) ?? []).map((run) => run.length)
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}json\n${json}\n${fence}`;
}

/**
 * A session's questions as the parent is handed them: JSON, because it puts
 * them to the person as they stand, and retelling a question is how it gets
 * softened or loses an option.
 */
export function questionsText(questions: SessionQuestions): string {
  return `**Questions for the person**, as \`ask_user\`'s \`questions\`:\n\n${jsonBlock(questions)}`;
}

/** A writing session's answer, as `WRITE_OUTPUT` in `./schemas.ts` describes it. */
export const WriteAnswer = z.object({
  status: z.enum(["done", "needs_input", "blocked"]),
  summary: z.string(),
  pullRequests: z
    .array(z.object({ number: z.number().int(), url: z.string() }))
    .optional(),
  checks: z
    .array(z.object({ command: z.string(), passed: z.boolean() }))
    .optional(),
  questions: SessionQuestions.optional()
});

export type WriteAnswer = z.infer<typeof WriteAnswer>;

/** How the coordinator reads a writing session's answer. */
export function answerText(answer: WriteAnswer): string {
  const status = {
    done: "**Done.**",
    needs_input: "**Stopped for the person's decision.**",
    blocked: "**Blocked.**"
  }[answer.status];
  const pulls = answer.pullRequests ?? [];
  const pr =
    pulls.length === 0
      ? ""
      : ` ${pulls.length === 1 ? "Pull request" : "Pull requests"} ${pulls
          .map((pull) => `#${pull.number}: ${pull.url}`)
          .join(", ")}`;
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
      : answer.questions
        ? questionsText(answer.questions)
        : "**It named no question.** Its summary above is what it stopped on: ask the person what it leaves open, or send it back to say what it needs.";
  return [`${status}${pr}`, answer.summary.trim(), checks, question]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The run behind a filing write: whose page it may write on, and which write
 * this is.
 *
 * One argument rather than two parameters because both are strings and either
 * reads as the other, so a swap typechecks. It would ship a total failure: an
 * `owner` holding a run id matches no page, so every version and every report
 * this agent files is refused, and a `runId` holding a caller key is constant
 * across runs, so the entry key starts catching unrelated writes as replays.
 *
 * `owner` is the verified caller, asserted by the write against the page's own
 * so a page this caller did not open takes nothing from it. `runId` is the
 * entry key, which is what makes a redelivered write a replay rather than a
 * second note.
 */
export interface FilingRun {
  owner: string;
  runId: string;
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

${ownershipNote(false)}`;
  if (submodules.length === 0) return note;
  return `${note}

${submodulesNote(
  submodules,
  `Each is a repository of its own, on \`${branch}\` too. **Commit inside each one you
change** — only a submodule's own commits are kept — and push it there under the same
branch name. Recording the new commit in the superproject is a separate commit, and
only if the task asks for it. Only one level of submodules is checked out.`
)}`;
}

/**
 * What a **revising** session is told about the branches it was sent back to.
 *
 * Nothing put it on them: it checks each out itself, in whichever repository
 * holds it, because a branch of a set kept together may be in several. The
 * worktree's own branch is only where it starts.
 */
function branchesNote(start: string, submodules: readonly string[]): string {
  const note = `## Your branches

You are in a worktree nobody else is working in while you are, on \`${start}\`: a place to
start from, not a branch to push.

The branches to work on are listed at the top, and a branch may be in more than one
repository here. For each, find where it is (\`git ls-remote --heads origin <branch>\` in
each repository), fetch it and check it out there, and find its pull requests
(\`gh pr list --head <branch>\`). If a repository has uncommitted changes when you come to
it, stop and say so rather than switch over them.

**Push each branch when you are done with it.** Only what you push leaves this session.

${ownershipNote(true)}`;
  if (submodules.length === 0) return note;
  return `${note}

${submodulesNote(
  submodules,
  "Each is a repository of its own. Only one level of submodules is checked out."
)}`;
}

/** The submodules a worktree carries, what of them is the session's, and their dependencies. */
function submodulesNote(submodules: readonly string[], own: string): string {
  return `### Submodules

${submodules.map((path) => `- \`${path}\``).join("\n")}

${own}

Dependencies are installed at the top of the checkout, and in a submodule only when the
repository's own install covers it. Run \`npm ci\` in a submodule before building or testing
it when its \`node_modules\` is empty, when this workspace's install failed, or after you
change its lockfile. Otherwise leave its tree alone: \`npm ci\` deletes it to rebuild it.`;
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
        "once there is one, `claude_code_revise` with the branch."
    );
  }
  if (writing.discarded.length > 0) {
    lines.push(
      discardedLine(writing.discarded, writing.discardFailed ?? false, many)
    );
  }
  return lines.join("\n\n");
}

/**
 * What was still uncommitted when a session ended, and whether deleting it
 * worked: the files are listed either way, and only `failed` says which.
 */
function discardedLine(
  discarded: readonly Uncommitted[],
  failed: boolean,
  many: boolean
): string {
  return `${
    failed
      ? "**Still uncommitted — deleting it failed**, so these are in the worktree:"
      : "**Deleted, uncommitted:**"
  } ${discarded
    .map((repo) => `${repoLabel(repo.path, many)}: ${listFiles(repo.files)}`)
    .join("; ")}.`;
}

/**
 * What a revising session was sent to, under its own account of what it did.
 *
 * The branches alone, and no count of what reached each pull request: a
 * revising session switches between branches, so no local count describes one
 * of them, and the remote's answer costs a GitHub call per pull request on the
 * path of every revision. What it pushed is the session's own to report — its
 * `pullRequests` field names every pull request it pushed to — so this says
 * where it was sent and leaves what happened there to the answer above it.
 */
export function revisionNote(
  branches: readonly string[],
  discarded: readonly Uncommitted[] = [],
  discardFailed = false
): string {
  const parts = [
    `**Sent back to:** ${branches.map((branch) => `\`${branch}\``).join(", ")}.`
  ];
  if (discarded.length > 0) {
    const many =
      discarded.length > 1 || discarded.some((repo) => repo.path !== ".");
    parts.push(discardedLine(discarded, discardFailed, many));
  }
  return parts.join("\n\n");
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
 * A writer on a branch finishes by delivering a pull request, or — sent back to
 * branches — by revising theirs.
 */
export function sessionBrief(
  task: string,
  note?: string,
  writing?: {
    branch: string;
    submodules: readonly string[];
    continues: boolean;
    /** Sent back to the branches its task names, rather than on its own. */
    revising?: boolean;
  },
  plan?: {
    /** The plan it carries out, as the caller was shown it. */
    text: string;
    /** Whether it carries on from the conversation that wrote the plan. */
    resumed: boolean;
  }
): string {
  const parts = [task, "", GITHUB_NOTE];
  // On a branch only. A scratchpad session has none, and keeps what it leaves
  // in the tree, so a brief that asked it to commit would be wrong about both.
  if (writing) {
    parts.push(
      "",
      writing.revising
        ? branchesNote(writing.branch, writing.submodules)
        : branchNote(writing.branch, writing.submodules, writing.continues),
      "",
      DESIGN_NOTE,
      "",
      CHECK_NOTE,
      "",
      writing.revising ? REVISE_NOTE : DELIVERY_NOTE
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
plan out. Where the work shows the plan is wrong, or a better shape becomes evident with
the code in front of you, say what you would do instead and ask before you build it: the
approval was for this plan.

${plan}`;
  }
  return `## The plan

This is the plan for the work above, as the person who asked for it read it. Carry it
out. Where the work shows the plan is wrong, or a better shape becomes evident with the
code in front of you, say what you would do instead and ask before you build it: the
approval was for this plan.

${plan}`;
}

/**
 * What a **planning** session is told about its answer and, for an edit, about
 * the plan it changes. What each field of the answer is for is in the schema
 * the CLI hands it, so it is not said twice here: how to plan is this brief's,
 * what the plan has to contain is `PLAN_OUTPUT`'s in `./schemas.ts`.
 *
 * An edit that carries on from the conversation that wrote the plan is told
 * only what is new — what the person said — since the plan, the code it read
 * and these instructions are already in its context. Which is why the stance
 * below is on the other path only, and the revising note carries just the part
 * a comment puts in question: whether to comply with it. One carrying on after
 * it stopped to ask is told only that the answer is above.
 */
export function planBrief(
  task: string,
  note?: string,
  editing?: {
    plan?: string;
    said: readonly string[];
    resumed?: boolean;
    asked?: boolean;
  }
): string {
  const parts = editing?.resumed
    ? [
        task,
        "",
        editing.asked
          ? `## Their answer

Above are the person's answers to what you asked. Carry on from where you stopped: ask
again if something is still open, and answer with the plan once nothing is.`
          : `## Revising your plan

The person read the plan you wrote and asked for the changes above. Revise it, and answer
again through the StructuredOutput tool with the whole plan as it should now stand.

Where what they asked for would make the plan worse, or there is a better way to get what
they are after, ask them before you revise — unless they already chose theirs over it.`
      ]
    : [
        task,
        "",
        GITHUB_NOTE,
        "",
        `## Your answer

You are writing a plan, not making the change: you are in Claude Code's plan mode, and
anything that would change the tree is refused. Read what the change will touch, and
answer through the StructuredOutput tool.`,
        "",
        `## Planning it

Work out more than one way in before you write one down, and bring the person with you:
where a real choice exists, weigh it in the plan rather than presenting the one path you
settled on. Where the request names an approach and a different one would serve it better,
say so and why — "you asked for X; Z gets you that, because…" is wanted here, not
impertinent.

Ask the person whenever you need them, as you would check a dependency or read the docs
before relying on them: which way in they prefer, a trade-off only they can rank, a
constraint you suspect but cannot read. Asking is \`needs_input\` with everything you need
from them at once, each question with its options: you carry on from here with their
answers, so asking costs you nothing you have found. Hand the
plan over only when you believe it is ready — the alternatives worth weighing put to them,
and their choice made — because it goes to them to approve as it stands, and a question
left in it is one they approve past.`
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
 * Where a **discovery** session works, and what it may leave there.
 *
 * With a checkout of its own it has no branch, as a writing session in that
 * place does: it commits nothing and pushes nothing, so the only thing worth
 * saying about the place is that nothing written in it is kept. In a scratchpad
 * there is no checkout to hand out and the tree is the parent's, so nothing is
 * cleaned after the session and what is already uncommitted there is somebody
 * else's.
 *
 * **What it may not do on GitHub is bounded, and filing is outside that bound.**
 * A run files a record, which for a skill of this kind may be the whole point
 * of it, and where it goes is the skill's: a brief that read as "change nothing
 * on GitHub" would contradict the skill loaded in the same prompt. What no
 * discovery run does is alter a record that is already there, and that holds
 * whichever skill it follows, which is why it is said here rather than left to
 * one of them.
 */
function discoveryPlaceNote(own?: { submodules: readonly string[] }): string {
  const note = `## Where you are

${
  own
    ? "You have a checkout of your own, in a workspace nobody else is working in while you are."
    : "You are in the workspace this conversation shares rather than a checkout of your own, and what is already uncommitted here is somebody else's."
}
This session opens no branch, commits nothing, pushes nothing and opens no pull request. ${
    own
      ? "Anything you write in the checkout is deleted when you finish."
      : "Nothing is deleted after you, so write under `/tmp` rather than in the tree."
  }
Leave every repository here as you found it.

Filing is not changing. File what you find wherever your skill says to, and leave what is
already on GitHub as it stands: never close, reopen, edit or comment on an issue, a pull
request or an advisory, your own records included.`;
  if (!own || own.submodules.length === 0) return note;
  return `${note}

${submodulesNote(
  own.submodules,
  "Each is a repository of its own. Only one level of submodules is checked out."
)}`;
}

/**
 * How a discovery session reads a report an earlier run filed, and what to do
 * when it cannot.
 *
 * The links are in the task, put there by the agent that briefed this run. The
 * page is served two ways from one URL: a browser gets a rendered page, and a
 * plain request gets the report as Markdown, which is what `curl` sends. So the
 * failure worth naming is the one that reads like success: markup coming back
 * instead of the report, which is not an empty history but an unread one.
 */
const EARLIER_REPORTS_NOTE = `## Earlier reports

The task above may link to reports earlier runs of this kind filed. Read one with
\`curl -s <link>\`, which answers it as Markdown.

If what comes back is an HTML page rather than the report, or the link does not resolve,
then you did not read it: say so, and treat what it would have told you as **unknown**
rather than as nothing to find. A history you could not read is not an empty one.`;

/**
 * What a discovery session does with what it produces.
 *
 * The channel only. What belongs in the report, and what must stay out of it,
 * is the skill's and is not restated here: this says where it goes and who
 * reads it, which is the part the skill cannot know.
 */
const DISCOVERY_REPORT_NOTE = `## Your report

Answer with your report whole, in \`report\`. It is filed on a page of its own, and that
page is what the person is given and what the next run of this skill is handed as its
history. Nobody retells it on the way: what you answer is what they read.

\`lastReply\` is for the agent that briefed you, which does not read the report.

If the first line of the task named a skill that is not installed, nothing loaded and you
are following none: answer \`blocked\` saying which name it was, rather than improvising a
run of it. Your report would be filed under a name nothing ran.`;

/**
 * What a **discovery** session is told: the task with its skill named on the
 * first line, where it is, how to read the reports it was linked to, and what
 * to do with its own.
 *
 * The task comes first, as it does for every session here, and for this one
 * that ordering is load-bearing rather than conventional: the skill is loaded
 * by a `/<name>` line at the very start of the prompt, so anything put above
 * the task would leave the session with no skill at all.
 *
 * `own` is the checkout when the session has one of its own, and absent in a
 * scratchpad, where the tree it works in is the parent's.
 */
export function discoveryBrief(
  task: string,
  note?: string,
  own?: { submodules: readonly string[] }
): string {
  const parts = [
    task,
    "",
    GITHUB_NOTE,
    "",
    discoveryPlaceNote(own),
    "",
    EARLIER_REPORTS_NOTE,
    "",
    DISCOVERY_REPORT_NOTE
  ];
  if (note) {
    parts.push("", "## The state of this workspace", "", note);
  }
  return parts.join("\n");
}

/**
 * What the parent is told of a planning session: the plan's id and title, and
 * what the session had to say about it — never the plan, which the parent hands
 * on by its id — or the questions it stopped on, before there is a plan to read.
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
    | {
        kind: "asked";
        id: string;
        questions: SessionQuestions;
        lastReply: string;
      }
    | { kind: "unanswered" }
    | { kind: "refused"; id: string; lastReply: string }
): string {
  const result = outcome.session.result;
  const footer = result ? `_${sessionFooter(result)}_` : "";
  if (filed.kind === "filed") {
    return [`**Plan \`${filed.id}\`: ${filed.title}**`, filed.lastReply, footer]
      .filter(Boolean)
      .join("\n\n");
  }
  if (filed.kind === "asked") {
    return [
      `**The planning session for \`${filed.id}\` stopped to ask the person before it plans.**`,
      filed.lastReply,
      questionsText(filed.questions),
      footer
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  if (filed.kind === "refused") {
    return [
      `**The plan \`${filed.id}\` was not changed**: it was locked while the session ran, it is gone, or it is not a page this agent may write on. Write a new plan if it still needs one.`,
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
    ? "**The conversation that wrote this plan is gone from its workspace, so nothing was revised.** Nothing was spent. Call claude_code_plan again with the same plan and comment: the next session starts from the plan's text, and what you give it."
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
 * branch. `node_modules` is spared: the installed dependencies are the
 * checkout's, and the next session would otherwise wait on a full install.
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

/**
 * Put each listed repository back on the worktree's own branch, after a
 * revision checked out others: a worktree left on one of those reads as holding
 * work, and is held from the next session. After {@link DISCARD}, so `-f` takes
 * nothing that was still uncommitted.
 */
export const RETURN_TO_START = `rc=0
while IFS= read -r p; do
  [ -n "$p" ] || continue
  git -C "$p" checkout -q -f "$WORKTREE_BRANCH" || rc=1
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
 * `kept` is what became of the branches, the host's account rather than the
 * session's: {@link writingNote} or {@link revisionNote}. The footer under it
 * is {@link sessionFooter}, which carries its own reasoning — including why a
 * denial count belongs beside the cost.
 */
export function sessionReport(outcome: SessionOutcome, kept = ""): string {
  const { session } = outcome;
  const result = session.result;

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

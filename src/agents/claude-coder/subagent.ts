import type { AgentPlugin, CoreConfigOverrides } from "@dynamicagents/core";
import type { PluginHost } from "@dynamicagents/core/host";
import { RecipeSubagentHost } from "@dynamicagents/core/round";
import type {
  ChunkProgressContext,
  ProgressEvent,
  RecipeChunkResult,
  RecipeExecutionRequest,
  RecipeExecutionResult,
  SubtaskRuntime
} from "@dynamicagents/core/subtasks";
import {
  claudeCodeSession,
  CLAUDE_CODE_READ_TYPE,
  CLAUDE_CODE_TYPE,
  followUpExecIdFor,
  WORKSPACE_RUNTIME_KEY,
  type ClaudeCodeResult,
  type ClaudeCodeSession,
  type DrainCursor,
  type DrainOutcome,
  type RateLimitInfo,
  type SessionRuntime
} from "@dynamicagents/plugins/claude-code";
import {
  sessionAdvisory,
  truncateOutput
} from "@dynamicagents/plugins/computer";
import { CLAUDE_CODE_SESSION, CLAUDE_CODER_CONFIG } from "@/config";
import { claudeCoder } from "./definition";
import { computerExec, openWorkspace } from "@dynamicagents/plugins/computer";
import { readSubmodules } from "@/workspace/subtask-workspace";
import { subtaskBranch } from "@/workspace/worktree-pool";
import { container } from "./plugins";
import { claudeCodeConfig, noWorkspaceRouting } from "./claude-code";
import { subagentPlugins } from "./plugins";

/**
 * The claude-coder's subagent facet — a Claude Code session, not a model loop.
 *
 * This is the one facet in this repository that does **not** run core's
 * resumable runner. `executeChunk` is overridden outright: the loop, the tools,
 * the context management and the system prompt all belong to a `claude -p`
 * process inside the workspace container, and core's job shrinks to what it is
 * uniquely good at — durable chunking, retry, cancellation and persistence.
 *
 * The mapping is exact, which is why this is a small file rather than a
 * framework. `RecipeChunkResult` is already
 * `{done:false, progress}` | `{done:true, result, progress}` — which is
 * precisely "the CLI is still running" versus "it exited with a report".
 */

/** Where this facet keeps its place in the session's event stream. */
const CURSOR_KEY = "claude-cursor";

/**
 * Which session this facet started, and in which workspace — what
 * {@link ClaudeCoderSubagent.abortExecution} needs to stop it with no drain in
 * hand.
 */
const SESSION_KEY = "claude-session";

/**
 * Each repository a writing session could commit in, and the commit it started
 * at — recorded before it starts, so what it committed can be counted after.
 */
const REPOS_KEY = "claude-repos";

/**
 * The session's own result while its warning round runs. The report is about
 * the session; the round only decides what of it was kept.
 */
const WARNING_KEY = "claude-warning";

/** Bound on the report text, so one runaway session cannot fill the row. */
const REPORT_MAX = 24_000;

/**
 * How long a cancellation waits for the interrupted drain to unwind.
 *
 * Generous, because what it is waiting on is a process exit plus a
 * container-to-workspace filesystem sync whose cost scales with the number of
 * files the session touched — a session that ran an install is moving a whole
 * dependency tree — and because the alternative to waiting is a working-tree
 * reset racing that sync. Still bounded: a cancellation must complete whether or
 * not the container is answering, and what the bound gives up is only speed. A
 * pull cut short here resumes from its cursor when the workspace next drives
 * one.
 */
const SETTLE_MAX_MS = 60_000;

/**
 * Wait for an interrupted drain to unwind, but never indefinitely.
 *
 * Module-level and exported so the bound can be driven in a spec: the wait it
 * implements is about a container the suite deliberately never reaches, so the
 * only way to cover both arms is to inject the window.
 *
 * Returns whether the drain settled in time. Exceeding the bound means the
 * ordering this exists to establish was **not** established — the tree may be
 * reset under a session that is still shutting down — so it is reported rather
 * than passed over in silence. Bounded at all because a cancellation has to
 * finish whether or not the container is answering.
 */
export async function settleDrain(
  drained: Promise<void>,
  maxMs: number = SETTLE_MAX_MS
): Promise<boolean> {
  const timedOut = Symbol("timed-out");
  const result = await Promise.race([
    drained.then(() => undefined),
    scheduler.wait(maxMs).then(() => timedOut)
  ]);
  if (result !== timedOut) return true;
  console.warn(
    "[claude-coder] the session did not unwind within the settle window; " +
      "the working-tree reset may race its final filesystem sync"
  );
  return false;
}

/**
 * What a session cost, as one line under its report.
 *
 * Added here because `CLAUDE_CODE_RECIPE` sets `reportMetrics: false` and core
 * adds none — it is not driving this run. What a session spent is worth knowing
 * when the bucket is shared with a human at their desk.
 *
 * Module-level and exported for the reason {@link settleDrain} is: `#report` is
 * private and reaching it means driving a whole chunk against a container the
 * suite deliberately never starts, so the one part with a rule in it would go
 * untested.
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
interface RepoStart {
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
  /** The warning round's own account of itself, when it had one. */
  warning?: ClaudeCodeResult;
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

/** A list of files a model can read at a glance, bounded. */
function listFiles(files: readonly string[], max = 12): string {
  const shown = files
    .slice(0, max)
    .map((file) => `\`${file}\``)
    .join(", ");
  return files.length > max ? `${shown} and ${files.length - max} more` : shown;
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
 * writing subtask that says nothing about its branch is one the parent cannot
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
 * The subtask's own prompt, plus the verbatim history the delegating model
 * selected, plus whatever the workspace has to say for itself. A Claude Code
 * session has no view of the parent's conversation and cannot ask, so anything
 * that matters has to be inline — which is the same contract every subagent in
 * this repo works under, said to a different process. The workspace note is
 * inline for the same reason: the session cannot query the host, and a broken
 * install or a workspace that has stopped accepting writes is the difference
 * between a failure worth retrying and one that never will be.
 *
 * {@link GH_NOTE} is here for the same reason and earns its tokens the same way:
 * what a session cannot find out by looking, and would otherwise spend turns
 * discovering by failing.
 */
export function sessionBrief(
  request: RecipeExecutionRequest,
  note?: string,
  writing?: {
    branch: string;
    submodules: readonly string[];
    continues: boolean;
  }
): string {
  const parts = [request.prompt, "", GH_NOTE];
  // Writing only. A reading session works in a copy that is deleted when it
  // ends, and the plugin tells it so; a brief that asked it to commit would
  // spend the session on work nobody will see.
  if (writing) {
    parts.push(
      "",
      branchNote(writing.branch, writing.submodules, writing.continues)
    );
  }
  if (note) {
    parts.push("", "## The state of this workspace", "", note);
  }
  if (request.references.length > 0) {
    parts.push(
      "",
      "## Context from the conversation that produced this task",
      "",
      ...request.references.map((ref) => `**${ref.role}:** ${ref.text}`)
    );
  }
  return parts.join("\n");
}

/** What a host may hand a drain beyond its window. */
type Sinks = Parameters<ClaudeCodeSession["start"]>[5];

/** What {@link ClaudeCoderSubagent} reports a session from. */
type SessionEnd = {
  result?: ClaudeCodeResult;
  exitCode: number;
  stderr?: string;
};

/**
 * How a session the host stopped exits: Claude Code's answer to the `SIGTERM`
 * `killRun` in `@dynamicagents/plugins/claude-code` sends.
 */
const STOPPED_EXIT = 143;

/**
 * The branch a writing subtask works on: the one it was asked to continue, or its
 * own. Resolved on the parent against the worktrees before anything ran — see
 * `@/workspace/subtask-workspace` — so here it only has to be named.
 */
function branchOf(request: RecipeExecutionRequest): string {
  return request.params.continue || subtaskBranch(request);
}

/** Each listed repository and the commit it is on. */
const READ_HEADS = `while IFS= read -r p; do
  [ -n "$p" ] || continue
  printf '%s\\t%s\\n' "$p" "$(git -C "$p" rev-parse HEAD 2>/dev/null)"
done <<EOF
$REPO_PATHS
EOF`;

/**
 * What each listed repository holds uncommitted: its path, a tab, a file.
 * Ignored files are not listed — they are not work anybody forgot to commit.
 */
const LIST_UNCOMMITTED = `while IFS= read -r p; do
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
const DISCARD = `rc=0
while IFS= read -r p; do
  [ -n "$p" ] || continue
  git -C "$p" reset -q --hard || rc=1
  git -C "$p" clean -ffdxq -e node_modules || rc=1
done <<EOF
$REPO_PATHS
EOF
exit $rc`;

/** Commits each listed repository has past where it started. */
const COUNT_COMMITS = `tab="$(printf '\\t')"
while IFS="$tab" read -r p start; do
  [ -n "$p" ] || continue
  printf '%s\\t%s\\n' "$p" "$(git -C "$p" rev-list --count "$start..HEAD" 2>/dev/null)"
done <<EOF
$REPO_STARTS
EOF`;

/** Tab-separated lines as fields. */
function tabbed(out: string): string[][] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

export class ClaudeCoderSubagent extends RecipeSubagentHost<Env> {
  protected agentConfig(): CoreConfigOverrides {
    return { ...CLAUDE_CODER_CONFIG, agentName: claudeCoder.tenant };
  }

  protected agentPlugins(host: PluginHost<Env>): AgentPlugin[] {
    return subagentPlugins(host);
  }

  /**
   * The session driver, built from the same config the parent and the workspace
   * object hold. Its `credentials` thunk is never called here — the swap happens
   * on the Worker side of the container boundary, inside the workspace object.
   */
  #sessionMemo?: ClaudeCodeSession;

  get #session(): ClaudeCodeSession {
    return (this.#sessionMemo ??= claudeCodeSession(
      claudeCodeConfig(
        this.env,
        noWorkspaceRouting("a facet resolves its workspace from ctx.runtime")
      )
    ));
  }

  /**
   * The run this instance is holding open right now, for {@link abortRun}.
   *
   * In memory only, and that is correct rather than lazy: an isolate that lost
   * it has no in-flight drain to interrupt, so there is nothing for a persisted
   * copy to do. Mirrors the base class's own `inflight`.
   *
   * `settled` resolves when that drain has finished unwinding — see
   * {@link abortRun}. `yielded` ends its window early — see {@link yieldRun}.
   */
  #inflight?: {
    name: string;
    subtaskId: number;
    settled: Promise<void>;
    yielded: AbortController;
  };

  /**
   * Execute one durable chunk by draining a Claude Code session.
   *
   * The whole method is one of two shapes: start a session and drain its first
   * window, or re-attach to a running one and drain another. Everything else is
   * bookkeeping around those two calls.
   */
  override async executeChunk(
    request: RecipeExecutionRequest,
    chunk: number,
    runtime?: SubtaskRuntime,
    selfOrigin?: string,
    live?: ChunkProgressContext
  ): Promise<RecipeChunkResult> {
    // Every type this agent declares is a Claude Code session, and each has to
    // be named here: one that is not goes to core's runner, which runs its inert
    // recipe on the subagent model — one turn, no tools, and a report that is
    // the script the model would have run.
    if (
      request.type !== CLAUDE_CODE_TYPE &&
      request.type !== CLAUDE_CODE_READ_TYPE
    ) {
      return super.executeChunk(request, chunk, runtime, selfOrigin, live);
    }

    /**
     * Arm the callback channel by hand, because this method never reaches
     * `super.executeChunk` — which is where the base normally does it — and
     * a channel left over from a previous chunk on this isolate would post this
     * session's notes to the previous turn's gatekeeper callback.
     */
    this.noteProgressContext(request, live);

    /**
     * Which workspace this session runs in, resolved on the **parent**.
     *
     * `callerKey()` throws on a facet by design, so this cannot be derived here
     * — it is written by the `claude-code` plugin's `resolveRuntime`, which core
     * dispatches to whichever plugin declared the subtask type. Its absence is a
     * wiring fault, not a runtime condition, so it fails loudly.
     */
    const name = runtime?.[WORKSPACE_RUNTIME_KEY];
    if (typeof name !== "string" || !name) {
      return this.#failed(
        "this subtask arrived without a workspace name on its runtime, so " +
          "there is no checkout to work in. That is a wiring fault: the " +
          "claude-code plugin must be installed on the parent, which is where " +
          "`resolveRuntime` runs."
      );
    }

    const stub = this.env.CLAUDE_CODER_WORKSPACE.get(
      this.env.CLAUDE_CODER_WORKSPACE.idFromName(name)
    );
    const cursor = await this.ctx.storage.get<DrainCursor>(CURSOR_KEY);

    /**
     * Ask before paying for a container start.
     *
     * An invocation carries an 18.7-27k-token cached prefix before it does
     * anything, so starting a session whose first model call the egress gateway will
     * refuse costs that prefix to learn what one RPC answers for free — and
     * reports it as a failed run rather than as a limit with a time on it.
     *
     * Only on the first chunk. A session already running is not asking for a new
     * credential, and refusing to drain one would strand a run that is fine.
     */
    if (!cursor) {
      const lead = await stub.claudeCredentials();
      if (!lead.ok) return this.#failed(this.#exhausted(lead.retryAt));
    }

    /**
     * Where the checkout is — resolved **before** the workspace is opened, so a
     * subtask with nothing to work on costs one RPC rather than a container.
     *
     * From the workspace object, never from the brief: it is the path a checkout
     * was recorded at and `.git` was found at, so it is exact and a model cannot
     * point a session somewhere else. Undefined means there is no checkout,
     * which is a wiring-order mistake the parent's soul is told to avoid — so it
     * fails with that sentence rather than guessing a path.
     */
    const dir = cursor ? undefined : await stub.checkoutDir();
    if (!cursor && !dir) {
      /**
       * The advisories are worth the extra RPC **here specifically**.
       *
       * A refusal that names only the ordering mistake is the wrong sentence for
       * a workspace that is full, or whose install broke: both refuse for a
       * reason the model can act on, and neither is "you forgot to clone". The
       * same call is made a few lines below for a session that does start, so
       * this is the same fact reaching the one path that could not see it.
       *
       * Only on the way to failing, so the "one RPC rather than a container
       * start" property of the check above is kept.
       */
      const note = sessionAdvisory(await stub.advisories());
      return this.#failed(
        "there is no checkout in this workspace yet, so there is nothing to " +
          "work on. Clone a repository with `repo_clone`, or open a scratchpad " +
          "with `scratch_open`, before delegating." +
          (note ? `\n\n${note}` : "")
      );
    }

    /**
     * What is true about the workspace, folded into the brief.
     *
     * The session starts whatever the workspace's state, and its own report is
     * the only channel out — a subtask carries what the session said and nothing
     * else. So a fact the session is not given is a fact the parent and the
     * operator never see either, which is why this belongs in the brief rather
     * than somewhere the session could look it up. It cannot: it has no tool
     * that reaches the host.
     *
     * **Reported, never enforced.** Nothing here refuses to start the session.
     * Blocking on a broken install deadlocks — nothing clears that record except
     * another checkout — and returning `{ done: false }` to wait out one in
     * flight would spend the branch's whole chunk allowance, since such a chunk
     * returns in milliseconds. A Claude Code session can run `npm ci` itself, so
     * the useful thing is to hand it the facts.
     *
     * The wording is the plugin's, deliberately: severity belongs with the
     * definition of each advisory rather than being re-derived here from an
     * error string. First chunk only — a resumed session was told this already.
     */
    const note = cursor ? undefined : sessionAdvisory(await stub.advisories());

    // `using`, so the client is released even when the drain throws. The handle
    // it hands back is rebuilt on this side of the boundary from the stub's byte
    // stream, so it is a real `ReadableStream` of runtime events — which is what
    // lets the drain live here rather than inside the workspace object.
    using workspace = await openWorkspace(stub);
    const runner = workspace.runtime as SessionRuntime;
    // Before `#inflight` is armed, so a write that fails leaves no run behind
    // for `abortRun` to wait on.
    if (!cursor)
      await this.ctx.storage.put(SESSION_KEY, {
        name,
        subtaskId: request.subtaskId
      });

    /**
     * Where a note goes the moment it is written, and where the drain may
     * checkpoint.
     *
     * A session's chunk is the whole session, so a chunk boundary is the wrong
     * clock for a note: what it reports is bounded by the drain window, not by
     * when the session had something to say. `postProgress` labels and posts
     * each note as the line is parsed, so the thread keeps pace.
     *
     * The checkpoint is only safe **because** of that, and the drain enforces
     * the pairing — see `DrainOptions` in `@dynamicagents/plugins/claude-code`,
     * which carries the reasoning for both.
     */
    const sinks: Sinks = {
      onProgress: (event: ProgressEvent) => this.postProgress(event),
      onCheckpoint: (at: DrainCursor) => this.ctx.storage.put(CURSOR_KEY, at)
    };

    // Writing or reading, asked once. What that *means* for the session — a
    // reading one works in a throwaway copy — is not decided here and is not
    // reachable from here: the plugin derives it from the type inside `start`,
    // precisely so a host cannot leave the copy out. What this decides is the
    // host's own half: a branch, and what of the session is kept.
    const writes = request.type === CLAUDE_CODE_TYPE;

    // What the brief says about the branch, and which repositories it spans —
    // recorded with where each starts, so what the session commits can be
    // counted afterwards. First chunk only, like the rest of the brief.
    let writing: Parameters<typeof sessionBrief>[2];
    if (writes && !cursor) {
      const submodules = await this.#submodules(name, dir as string);
      await this.#recordStarts(name, dir as string, [".", ...submodules]);
      writing = {
        branch: branchOf(request),
        submodules,
        continues: Boolean(request.params.continue)
      };
    }

    const outcome = await this.#drain(name, request.subtaskId, (signal) =>
      cursor
        ? this.#session.resume(runner, cursor, { ...sinks, signal })
        : this.#session.start(
            runner,
            request.subtaskId,
            // Required: the session decides from it whether to work in a copy.
            request.type,
            sessionBrief(request, note, writing),
            dir as string,
            { ...sinks, signal }
          )
    );

    /**
     * Commit the cursor **after** the drain, on every path including `done`.
     *
     * A Workflow retries a chunk step up to three times, and a retry re-reads
     * whatever was last committed — so writing before the drain would skip
     * events the retry never saw. Writing after means a retry re-drains from the
     * last committed sequence, and the duplicated progress notes are harmless
     * because the keys are positional, which is exactly why they are positional.
     *
     * Still the authority even with `onCheckpoint` above: a checkpoint bounds
     * what a crash loses, and this is what records where a window actually
     * ended.
     */
    await this.ctx.storage.put(CURSOR_KEY, outcome.cursor);
    // The session has exited, so there is nothing left for a teardown to stop.
    if (outcome.done) await this.ctx.storage.delete(SESSION_KEY);

    // What the client said about the subscription bucket it is spending, if it
    // said anything. Best-effort — a session that did the work must not fail for
    // want of a bookkeeping RPC.
    if (outcome.rateLimit) await this.#noteRateLimit(stub, outcome.rateLimit);

    /**
     * **Empty, because `onProgress` already posted them.**
     *
     * `RecipeChunkResult.progress` is what core's parent posts at the chunk
     * boundary, and every note in `outcome.progress` has been through the
     * channel already. Returning them here as well would post the session twice
     * — deduped by the gatekeeper on their positional keys, and paid for either
     * way.
     */
    if (!outcome.done) return { done: false, progress: [] };
    if (!writes) {
      return { done: true, progress: [], result: this.#report(outcome) };
    }
    return await this.#finishWriting(request, name, runner, outcome, sinks);
  }

  /**
   * Drain one window of a session, with {@link abortRun} able to stop it.
   *
   * `settled` resolves in the `finally`, so a cancellation waits for the drain
   * to unwind rather than only for its signal to be delivered.
   */
  async #drain(
    name: string,
    subtaskId: number,
    run: (signal: AbortSignal) => Promise<DrainOutcome>
  ): Promise<DrainOutcome> {
    let drained: () => void = () => {};
    const inflight = {
      name,
      subtaskId,
      settled: new Promise<void>((resolve) => {
        drained = resolve;
      }),
      yielded: new AbortController()
    };
    this.#inflight = inflight;
    try {
      return await run(inflight.yielded.signal);
    } finally {
      // Only its own: a drain unwinding after a retry started must not clear
      // the retry's.
      if (this.#inflight === inflight) this.#inflight = undefined;
      drained();
    }
  }

  /**
   * End a writing session: give it its one warning round if it left work
   * uncommitted, then delete what is still uncommitted and count what it kept.
   *
   * **After the drain, and that ordering is load-bearing.** Every read here goes
   * through the workspace's filesystem, which the container's edits only reach
   * once the sync has unwound; `done` is what says it has.
   *
   * The round is only for a session that finished and said it succeeded. One
   * that failed, or died without a result, is reported as it is and loses what it
   * left uncommitted without being asked — a turn spent asking a session that
   * could not finish its task is a turn spent on a session that cannot finish.
   *
   * The round drains in this chunk when it can, and through the ordinary cursor
   * on later chunks when it cannot: its drain is a session's drain. The exec id
   * on the outcome is what says whose end is in hand; {@link WARNING_KEY} keeps
   * the session's own result for the report meanwhile.
   */
  async #finishWriting(
    request: RecipeExecutionRequest,
    name: string,
    runner: SessionRuntime,
    outcome: Extract<DrainOutcome, { done: true }>,
    sinks: Sinks
  ): Promise<RecipeChunkResult> {
    const stub = this.env.CLAUDE_CODER_WORKSPACE.get(
      this.env.CLAUDE_CODER_WORKSPACE.idFromName(name)
    );
    const dir = await stub.checkoutDir();
    const repos = (await this.ctx.storage.get<RepoStart[]>(REPOS_KEY)) ?? [];
    const roundId = followUpExecIdFor(request.subtaskId);
    const waiting = await this.ctx.storage.get<ClaudeCodeResult>(WARNING_KEY);
    let session: SessionEnd = outcome;
    let warning: ClaudeCodeResult | undefined;
    if (waiting && outcome.cursor.execId === roundId) {
      session = { result: waiting, exitCode: 0 };
      warning = outcome.result;
    } else {
      // The session's own end — or, on a retry that lost the round's cursor
      // before its first checkpoint, that end drained again, which starts the
      // round or re-attaches to the one already running.
      const first = waiting ?? outcome.result;
      if (waiting) session = { result: waiting, exitCode: 0 };
      if (dir && first && !first.isError && first.sessionId) {
        const sessionId = first.sessionId;
        const dirty = await this.#uncommitted(name, dir, repos);
        if (dirty.length > 0) {
          await this.ctx.storage.put(WARNING_KEY, first);
          await this.ctx.storage.put(SESSION_KEY, {
            name,
            subtaskId: request.subtaskId
          });
          const round = await this.#drain(name, request.subtaskId, (signal) =>
            this.#session.followUp(
              runner,
              request.subtaskId,
              sessionId,
              warningPrompt(dirty),
              dir,
              { ...sinks, signal }
            )
          );
          await this.ctx.storage.put(CURSOR_KEY, round.cursor);
          if (!round.done) return { done: false, progress: [] };
          warning = round.result;
        }
      }
    }
    await this.ctx.storage.delete(SESSION_KEY);

    /**
     * Nothing is discarded for a session stopped from outside. It did not choose
     * what it left, and whoever stopped it decides: a cancel resets the worktree,
     * and a failed branch keeps it — `fail` in `@/workspace/subtask-workspace`
     * commits it, and a discard here, on a drain still unwinding when the
     * branch failed, would race that commit and lose the work it exists to keep.
     */
    const stopped = outcome.exitCode === STOPPED_EXIT;
    const discarded =
      dir && !stopped
        ? await this.#discard(name, dir, repos)
        : { files: [], failed: false };
    const commits = dir ? await this.#commits(name, dir, repos) : [];
    return {
      done: true,
      progress: [],
      result: this.#report(session, {
        branch: branchOf(request),
        commits,
        discarded: discarded.files,
        ...(discarded.failed ? { discardFailed: true } : {}),
        ...(warning ? { warning } : {})
      })
    };
  }

  /**
   * Tell the credential pool what the session's own client reported.
   *
   * The pool's state lives on the workspace object, which is also where the
   * egress gateway reads it, so the reading goes there rather than being acted
   * on here. Whether it means anything at all is
   * `readRateLimitEvent`'s to decide, in the plugin — today it means nothing for
   * every status anyone has seen, and the plugin's comment says why that is a
   * finding rather than a gap.
   */
  async #noteRateLimit(
    stub: { claudeNoteRateLimit: (info: RateLimitInfo) => Promise<void> },
    info: RateLimitInfo
  ): Promise<void> {
    try {
      await stub.claudeNoteRateLimit(info);
    } catch (err) {
      console.warn("[claude-coder] could not record the bucket reading", {
        err: String(err)
      });
    }
  }

  /**
   * Stop the session this instance is holding, so a cancellation lands on the
   * running process rather than at the next chunk boundary.
   *
   * `SIGTERM` rather than `SIGKILL`, and it is chosen for what Claude Code does
   * *after* it: aborts the turn, kills its own Bash process tree, runs
   * `SessionEnd` hooks, exits 143. `SIGKILL` would leave whatever the session
   * spawned still running in a container that outlives the task.
   *
   * Best-effort, and it must be: a cancellation has to complete whether or not
   * the container is reachable.
   *
   * **The return value is a claim about who resolves the row, not a status.**
   * `true` means "there was live work and it has been interrupted, so the chunk
   * path will come back and resolve this subtask"; `false` means "no live
   * promise — nobody is coming back", on which core transitions the row itself
   * and **deletes this facet**. So `super.abortRun()` is the wrong answer to
   * return: it tracks an in-flight *model call*, set inside the `executeChunk`
   * this class overrides outright, so it always answers `false` here — tearing
   * the facet down while `executeChunk` is still unwinding its drain. A stopped
   * session does come back, so it is reported as `true`. The base's answer is
   * still right where this override does not reach: no session held, or a `stop`
   * that could not be delivered.
   *
   * **It waits for the drain, not just for the signal.** `onTaskCanceled` awaits
   * this and then runs `git reset --hard && git clean -fdx` in the same
   * container. Returning at delivery would let that reset run while the session
   * is still writing — and the container-to-workspace sync is driven by the
   * drain reaching `done` (`withPostPull`), so files written after the reset
   * would be synced into the durable checkout behind it. The cleanup whose whole
   * purpose is a clean tree would leave an arbitrary half-reset one. Bounded: a
   * drain that will not settle is logged and left.
   */
  override async abortRun(): Promise<boolean> {
    /**
     * Stop narrating before anything else, on both paths.
     *
     * The base disarms live posting inside its own `abortRun`, which the branch
     * below never reaches — and its abort *signal* cannot stand in for it here,
     * because that signal tracks a model call and this class holds none. Left
     * armed, every note the drain parses while the session takes its `SIGTERM`
     * and unwinds is posted to a Task the user already canceled.
     */
    this.stopProgress();

    const inflight = this.#inflight;
    if (!inflight) return await super.abortRun();

    try {
      const stub = this.env.CLAUDE_CODER_WORKSPACE.get(
        this.env.CLAUDE_CODER_WORKSPACE.idFromName(inflight.name)
      );
      using workspace = await openWorkspace(stub);
      await this.#session.stop(
        workspace.runtime as SessionRuntime,
        inflight.subtaskId
      );
      await settleDrain(inflight.settled);
      // Stopped, so the chunk's own teardown after this has nothing to stop.
      await this.ctx.storage.delete(SESSION_KEY);
      return true;
    } catch (err) {
      // The signal never landed, so the process may still be running and this
      // chunk may never return. `false` is the honest answer: it asks core to
      // finish the transition and clean up rather than wait for a drain that is
      // not coming.
      console.warn("[claude-coder] could not stop the session", {
        err: String(err)
      });
      return await super.abortRun();
    }
  }

  /**
   * Give the session back to the retry that replaced this chunk: the window ends
   * now and returns its cursor, and the session goes on running.
   *
   * Core calls this when a chunk step is retried while the attempt it replaces
   * is still draining — see `chunk-attempts.ts` in `@dynamicagents/core/round`.
   * The session's stream admits one subscriber, so a drain left running is what
   * refused every retry until the step had none left. `super.yieldRun()` would
   * reach only a model call, and this class holds none.
   */
  override async yieldRun(): Promise<void> {
    this.#inflight?.yielded.abort();
  }

  /**
   * Stop the session a failed or canceled branch leaves behind.
   *
   * Core calls this for such a branch once {@link abortRun} has had its turn.
   * That stops a drain this instance is holding; this reaches the session with
   * none — a drain that lost its subscriber to a retry, or an isolate that went
   * away — by the id it was started under. Left running, it goes on editing the
   * checkout while a later round delegates the same work again. Best-effort,
   * like every teardown core runs.
   */
  override async abortExecution(toolFamilies: string[]): Promise<void> {
    await super.abortExecution(toolFamilies);
    const session = await this.ctx.storage.get<{
      name: string;
      subtaskId: number;
    }>(SESSION_KEY);
    if (!session) return;
    try {
      const stub = this.env.CLAUDE_CODER_WORKSPACE.get(
        this.env.CLAUDE_CODER_WORKSPACE.idFromName(session.name)
      );
      using workspace = await openWorkspace(stub);
      await this.#session.stop(
        workspace.runtime as SessionRuntime,
        session.subtaskId
      );
    } catch (err) {
      // A session that has already exited lands here too.
      console.warn("[claude-coder] could not stop the session on teardown", {
        err: String(err)
      });
    }
  }

  /**
   * The submodules this worktree carries, for the brief and the accounting.
   *
   * Read from the checkout rather than carried from `resolve`, which ran on the
   * parent: the two never share memory, and the checkout is what was cloned.
   * Unreadable reads as none — the brief loses a paragraph, and what the session
   * commits in a submodule is kept all the same, just not counted.
   */
  async #submodules(workspace: string, dir: string): Promise<string[]> {
    try {
      return (await readSubmodules(this.#exec(workspace), dir)).map(
        (sub) => sub.path
      );
    } catch (err) {
      console.warn("[claude-coder] could not read the checkout's submodules", {
        err: String(err)
      });
      return [];
    }
  }

  /** A shell in a named workspace, under the settings every tool uses. */
  #exec(workspace: string) {
    return computerExec(container(this.env, () => workspace));
  }

  /**
   * Where each repository starts, for {@link #commits} to count from.
   *
   * Once per subtask. A retried first chunk can arrive after the session it
   * started has committed — the retry attaches to that session rather than
   * starting another — and reading HEAD again then would move the baseline past
   * the commits it exists to count.
   */
  async #recordStarts(
    workspace: string,
    dir: string,
    paths: readonly string[]
  ): Promise<void> {
    if (await this.ctx.storage.get(REPOS_KEY)) return;
    let starts: RepoStart[] = [];
    try {
      const read = await this.#exec(workspace)(READ_HEADS, {
        cwd: dir,
        env: { REPO_PATHS: paths.join("\n") }
      });
      starts = tabbed(read.stdout).map(([path = "", start = ""]) => ({
        path,
        start
      }));
    } catch (err) {
      console.warn("[claude-coder] could not read where the session starts", {
        err: String(err)
      });
    }
    await this.ctx.storage.put(
      REPOS_KEY,
      starts.length > 0 ? starts : paths.map((path) => ({ path, start: "" }))
    );
  }

  /** The repositories to account for — at least the checkout itself. */
  #repos(repos: readonly RepoStart[]): readonly RepoStart[] {
    return repos.length > 0 ? repos : [{ path: ".", start: "" }];
  }

  /** What each repository holds uncommitted, in the order they were recorded. */
  async #uncommitted(
    workspace: string,
    dir: string,
    repos: readonly RepoStart[]
  ): Promise<Uncommitted[]> {
    try {
      const listed = await this.#exec(workspace)(LIST_UNCOMMITTED, {
        cwd: dir,
        env: {
          REPO_PATHS: this.#repos(repos)
            .map((repo) => repo.path)
            .join("\n")
        }
      });
      const byPath = new Map<string, string[]>();
      for (const [path = "", file = ""] of tabbed(listed.stdout)) {
        byPath.set(path, [...(byPath.get(path) ?? []), file]);
      }
      return [...byPath].map(([path, files]) => ({ path, files }));
    } catch (err) {
      console.warn("[claude-coder] could not read what is uncommitted", {
        err: String(err)
      });
      return [];
    }
  }

  /**
   * Delete everything uncommitted, answering what that was and whether it went.
   *
   * Every repository is cleaned, not only the ones with something to report:
   * ignored build output is not listed, and it is not the branch either.
   * Reported whether or not the delete succeeds — a file named here that is still
   * on disk is a smaller problem than one deleted without a word — but reported
   * as what it was, which is what `failed` carries.
   */
  async #discard(
    workspace: string,
    dir: string,
    repos: readonly RepoStart[]
  ): Promise<{ files: Uncommitted[]; failed: boolean }> {
    const dirty = await this.#uncommitted(workspace, dir, repos);
    try {
      const done = await this.#exec(workspace)(DISCARD, {
        cwd: dir,
        env: {
          REPO_PATHS: this.#repos(repos)
            .map((repo) => repo.path)
            .join("\n")
        }
      });
      if (!done.success) {
        console.warn(
          "[claude-coder] the uncommitted work was not all deleted",
          {
            stderr: done.stderr.trim().slice(0, 500)
          }
        );
      }
      return { files: dirty, failed: !done.success };
    } catch (err) {
      console.warn("[claude-coder] could not delete the uncommitted work", {
        err: String(err)
      });
      return { files: dirty, failed: true };
    }
  }

  /** Commits past where each repository started; uncounted where unreadable. */
  async #commits(
    workspace: string,
    dir: string,
    repos: readonly RepoStart[]
  ): Promise<WritingOutcome["commits"]> {
    const listed = this.#repos(repos);
    try {
      const read = await this.#exec(workspace)(COUNT_COMMITS, {
        cwd: dir,
        env: {
          REPO_STARTS: listed
            .map((repo) => `${repo.path}\t${repo.start}`)
            .join("\n")
        }
      });
      const counts = new Map(
        tabbed(read.stdout).map(([path = "", count = ""]) => [path, count])
      );
      return listed.map((repo) => {
        const count = Number(counts.get(repo.path) || NaN);
        return Number.isInteger(count)
          ? { path: repo.path, count }
          : { path: repo.path };
      });
    } catch (err) {
      console.warn("[claude-coder] could not count the session's commits", {
        err: String(err)
      });
      return listed.map((repo) => ({ path: repo.path }));
    }
  }

  /**
   * Turn a finished drain into a terminal result.
   *
   * **The text can never be empty.** `persistResult` converts an empty result
   * into a failure, so a session that exits 0 having said nothing would be
   * recorded as a failed subtask — and so would one whose `result` event never
   * arrived because the process died first. Both are handled below rather than
   * left to produce a misleading row.
   *
   * The footer under both is {@link sessionFooter}, which carries its own
   * reasoning — including why a denial count belongs beside the cost.
   */
  #report(
    outcome: SessionEnd,
    writing?: WritingOutcome
  ): RecipeExecutionResult {
    const result = outcome.result;
    const kept = writing ? writingNote(writing) : "";
    // Diagnostic only — core never persists it, and the model that actually ran
    // is the one the session was launched with.
    const modelId = CLAUDE_CODE_SESSION.model;

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
      const said = outcome.stderr?.trim();
      return {
        status: "failed",
        error:
          `the Claude Code session exited with code ${outcome.exitCode} ` +
          "without reporting a result. Its output was lost with the process — " +
          "anything it left uncommitted has been deleted." +
          (said ? `\n\nIt printed:\n\n\`\`\`\n${said}\n\`\`\`` : "") +
          (kept ? `\n\n${kept}` : ""),
        modelId
      };
    }

    const footer = sessionFooter(result);

    if (result.isError) {
      // Bounded on this path too. A failing session is the *more* likely one to
      // have produced a runaway string — a loop that kept retrying, a command
      // that dumped a binary — and `error` lands in the same durable subtask row
      // the success path writes, so leaving it unbounded would defeat
      // {@link REPORT_MAX} exactly where it matters most.
      const detail =
        truncateOutput(result.text, REPORT_MAX) ||
        `the session ended as ${result.subtype}` +
          (result.apiErrorStatus === null
            ? ""
            : ` after an API ${result.apiErrorStatus}`);
      return {
        status: "failed",
        error: [detail, kept, `_${footer}_`].filter(Boolean).join("\n\n"),
        modelId
      };
    }

    const text =
      truncateOutput(result.text, REPORT_MAX) ||
      "The session completed and reported nothing. Check the working tree " +
        "before assuming the change was made.";

    return {
      status: "completed",
      resultParts: [
        {
          kind: "text",
          text: [
            text,
            kept,
            `_${footer}_`,
            writing?.warning
              ? `_warning round: ${sessionFooter(writing.warning)}_`
              : ""
          ]
            .filter(Boolean)
            .join("\n\n")
        }
      ],
      modelId
    };
  }

  /** A terminal failure with words an operator or the parent can act on. */
  #failed(error: string): RecipeChunkResult {
    return {
      done: true,
      progress: [],
      result: { status: "failed", error, modelId: null }
    };
  }

  /** What to say when the whole credential pool is unavailable. */
  #exhausted(retryAt: number | undefined): string {
    if (retryAt === undefined) {
      return (
        "no Anthropic credential in this deployment is usable, and none will " +
        "recover on its own — every one was rejected, or none is configured. " +
        "An operator has to mint a fresh `claude setup-token` credential. " +
        "Nothing was changed in the repository."
      );
    }
    return (
      "every Anthropic credential in this deployment has reached its " +
      `subscription limit. The earliest resets at ${new Date(retryAt).toISOString()}. ` +
      "Nothing was changed in the repository — send this request again after that."
    );
  }
}

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
  CLAUDE_CODE_TYPE,
  WORKSPACE_RUNTIME_KEY,
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
import { openWorkspace } from "@dynamicagents/plugins/computer";
import { claudeCodeConfig } from "./claude-code";
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
 */
export function sessionBrief(
  request: RecipeExecutionRequest,
  note?: string
): string {
  const parts = [request.prompt];
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
      claudeCodeConfig(this.env, () => {
        throw new Error("a facet resolves its workspace from ctx.runtime");
      })
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
   * {@link abortRun}, which is the only reason it is recorded.
   */
  #inflight?: {
    name: string;
    subtaskId: number;
    settled: Promise<void>;
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
    // Defensive rather than expected: this agent declares one type. A different
    // one means somebody added a second, and core's runner is the right thing to
    // hand it to.
    if (request.type !== CLAUDE_CODE_TYPE) {
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
    // Resolved in the `finally` below, so {@link abortRun} can wait for this
    // drain to unwind rather than only for the signal to be delivered.
    let drained: () => void = () => {};
    this.#inflight = {
      name,
      subtaskId: request.subtaskId,
      settled: new Promise<void>((resolve) => {
        drained = resolve;
      })
    };

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
    const sinks = {
      onProgress: (event: ProgressEvent) => this.postProgress(event),
      onCheckpoint: (at: DrainCursor) => this.ctx.storage.put(CURSOR_KEY, at)
    };

    let outcome: DrainOutcome;
    try {
      outcome = cursor
        ? await this.#session.resume(runner, cursor, sinks)
        : await this.#session.start(
            runner,
            request.subtaskId,
            sessionBrief(request, note),
            dir as string,
            sinks
          );
    } finally {
      this.#inflight = undefined;
      drained();
    }

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
    return outcome.done
      ? {
          done: true,
          progress: [],
          result: this.#report(outcome)
        }
      : { done: false, progress: [] };
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
    outcome: Extract<DrainOutcome, { done: true }>
  ): RecipeExecutionResult {
    const result = outcome.result;
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
          "the working tree may still hold partial edits." +
          (said ? `\n\nIt printed:\n\n\`\`\`\n${said}\n\`\`\`` : ""),
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
        error: `${detail}\n\n_${footer}_`,
        modelId
      };
    }

    const text =
      truncateOutput(result.text, REPORT_MAX) ||
      "The session completed and reported nothing. Check the working tree " +
        "before assuming the change was made.";

    return {
      status: "completed",
      resultParts: [{ kind: "text", text: `${text}\n\n_${footer}_` }],
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

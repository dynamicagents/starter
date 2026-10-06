import type { ThinkModel } from "@cloudflare/think";
import type {
  SubAgentPrepareContext,
  SubAgentSettleContext,
  SubAgentSpec
} from "@dynamicagents/core";
import { requireArtifactsStub } from "@dynamicagents/core/artifacts";
import { SubAgent } from "@dynamicagents/core/subagent";
import {
  CLAUDE_CODE_AGENT,
  claudeCodeModel,
  type RateLimitInfo,
  type SessionEnd,
  type SessionOutcome,
  type SessionWorkspace
} from "@dynamicagents/plugins/claude-code";
import {
  openWorkspace,
  sessionAdvisory,
  workspaceExec,
  workspaceNameFromRuntime,
  WORKSPACE_RUNTIME_KEY
} from "@dynamicagents/plugins/workspace";
import {
  readSubmodules,
  type RunRef,
  type SessionPlace,
  type SubtaskWorkspaces
} from "@/workspace/subtask-workspace";
import { claudeCodeConfig } from "./claude-code";
import {
  createPlan,
  lastPlanIndex,
  latestPlan,
  latestVersion,
  lookUpPlan,
  PLAN_INPUT,
  PLAN_LABEL,
  PLAN_OUTPUT,
  PlanAnswer,
  PLANNER_DESCRIPTION,
  plannedSession,
  planText,
  recordPlanRun,
  WRITE_INPUT,
  type PlannedSession,
  type PlanInput,
  type WriteInput
} from "./plans";
import { container, sessionWorkspaces } from "./plugins";
import type { SessionNote } from "./workspace";
import {
  COUNT_COMMITS,
  DISCARD,
  LIST_UNCOMMITTED,
  READ_HEADS,
  STOPPED_EXIT,
  needsWarning,
  notResumable,
  planBrief,
  planReport,
  sessionBrief,
  sessionReport,
  tabbed,
  unresumableReport,
  warningPrompt,
  type RepoStart,
  type Uncommitted,
  type WritingOutcome
} from "./session";

/**
 * `anthropic-coding`'s sub-agents: a Claude Code session each, not a model loop.
 *
 * The session is the sub-agent's **model** — `claudeCodeModel` in
 * `@dynamicagents/plugins/claude-code` — so Think's recovery drives it: a run
 * cut by an eviction or a deploy is continued, and the model re-attaches to the
 * session from where it stopped. What is here is this deployment's half: the
 * brief, the one warning for work left uncommitted, the report, and where each
 * session works.
 */

/**
 * Each repository a writing session could commit in, and the commit it started
 * at — recorded before it starts, so what it committed can be counted after.
 */
const REPOS_KEY = "claude-repos";

/** Where a failed run's kept-work note waits for the message that reports it. */
const KEPT_TABLE = "claude_kept_work";

function ensureKept(storage: DurableObjectStorage): void {
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS ${KEPT_TABLE} (run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, note TEXT NOT NULL)`
  );
}

/**
 * Keep a failed run's note for its follow-up.
 *
 * `settle` runs in the finish hook, before the parent builds the message that
 * reports the run, and returns nothing — so the note is stored under the run,
 * and `AnthropicCodingAgent.formatDetachedCompletion` reads it back. SQL rather than
 * `storage.get`, because that formatter is synchronous.
 */
export function keepNote(
  storage: DurableObjectStorage,
  taskId: string,
  runId: string,
  note: string
): void {
  ensureKept(storage);
  storage.sql.exec(
    `INSERT OR REPLACE INTO ${KEPT_TABLE} (run_id, task_id, note) VALUES (?, ?, ?)`,
    runId,
    taskId,
    note
  );
}

/** A run's kept-work note, if its settle left one. */
export function keptNote(
  storage: DurableObjectStorage,
  runId: string
): string | undefined {
  ensureKept(storage);
  return storage.sql
    .exec<{ note: string }>(
      `SELECT note FROM ${KEPT_TABLE} WHERE run_id = ?`,
      runId
    )
    .toArray()[0]?.note;
}

/** Drop a finished task's notes: its follow-ups have been written. */
export function forgetKept(
  storage: DurableObjectStorage,
  taskId: string
): void {
  ensureKept(storage);
  storage.sql.exec(`DELETE FROM ${KEPT_TABLE} WHERE task_id = ?`, taskId);
}

/**
 * Where a session works, as `prepare` hands it over. `workspaceName` is
 * `WORKSPACE_RUNTIME_KEY`, so the plugins' own readers find it too.
 */
function runtimeOf(place: SessionPlace): Record<string, unknown> {
  return {
    [WORKSPACE_RUNTIME_KEY]: place.workspaceName,
    dir: place.dir,
    ...(place.branch ? { branch: place.branch } : {}),
    ...(place.continues ? { continues: true } : {})
  };
}

/** The same, read back in the sub-agent. Its absence is a wiring fault. */
function placeOf(runtime: Record<string, unknown> | undefined): SessionPlace {
  const workspaceName = workspaceNameFromRuntime(runtime);
  const dir = runtime?.dir;
  if (!workspaceName || typeof dir !== "string") {
    throw new Error(
      "anthropic-coding: this run carries no workspace; its spec's prepare supplies one"
    );
  }
  return {
    workspaceName,
    dir,
    ...(typeof runtime?.branch === "string" ? { branch: runtime.branch } : {}),
    ...(runtime?.continues === true ? { continues: true } : {})
  };
}

/**
 * A session gets a worktree of its own, on its branch.
 *
 * A claim this run made and will never use is released before the refusal
 * goes back: the run has not started, so no `settle` comes to free it, and a
 * claim left live is passed over for good.
 */
async function claimPlace(
  workspaces: SubtaskWorkspaces,
  ctx: Parameters<SubtaskWorkspaces["resolve"]>[0]
): Promise<SessionPlace> {
  try {
    return await workspaces.resolve(ctx);
  } catch (err) {
    await releaseUnused(workspaces, ctx);
    throw err;
  }
}

async function releaseUnused(
  workspaces: SubtaskWorkspaces,
  run: RunRef,
  options: { forgetBranch?: boolean } = {}
): Promise<void> {
  await workspaces
    .release({ taskId: run.taskId, runId: run.runId }, options)
    .catch((released: unknown) =>
      console.warn("[anthropic-coding] could not release an unused worktree", {
        runId: run.runId,
        err: String(released)
      })
    );
}

/**
 * A writing session's worktree, on the branch its input names or one of its
 * own — in the worktree `near` names when that one is free.
 */
export async function claimSession(
  workspaces: SubtaskWorkspaces,
  ctx: {
    input: WriteInput;
    taskId: string;
    runId: string;
    near?: { repo: string; slot: number };
  }
): Promise<SessionPlace> {
  return claimPlace(workspaces, {
    taskId: ctx.taskId,
    runId: ctx.runId,
    // An empty name is no name: a model may fill an optional string with
    // one, and refusing it would fail a call that asked for nothing.
    ...(ctx.input.continue ? { continue: ctx.input.continue } : {}),
    ...(ctx.input.branch ? { branch: ctx.input.branch } : {}),
    ...(ctx.near ? { near: ctx.near } : {})
  });
}

/**
 * What a writing session leaves: a run that did not complete — failed or
 * canceled — keeps its work where a `continue` will find it, and every run's
 * worktree is recorded and freed. One whose work could not be secured is held
 * instead. See `keep` in `@/workspace/subtask-workspace`.
 */
export async function settleSession(
  workspaces: SubtaskWorkspaces,
  storage: DurableObjectStorage,
  ctx: Pick<SubAgentSettleContext<Env>, "taskId" | "runId" | "result">,
  options: { forgetBranch?: boolean } = {}
): Promise<void> {
  const run = { taskId: ctx.taskId, runId: ctx.runId };
  const forget = options.forgetBranch ? { forgetBranch: true } : {};
  if (ctx.result.status === "completed") {
    return workspaces.release(run, forget);
  }
  const kept = await workspaces.keep(run);
  if (kept.note) keepNote(storage, ctx.taskId, ctx.runId, kept.note);
  // A worktree held for work it could not secure keeps its branch, which is
  // how its work is found.
  await workspaces.release(
    run,
    kept.settled ? { hold: false, ...forget } : { hold: true }
  );
}

/**
 * A writing session gets a worktree of its own, and the plan it carries out if
 * it names one — checked before the worktree is claimed, so a plan that is not
 * the caller's refuses the run with nothing to release.
 *
 * **A plan is built by carrying on from the conversation that wrote it**, which
 * already holds everything the planning session read and found. That
 * conversation is in the workspace that ran it, so the build asks for that
 * worktree, and forks the conversation if it gets it: the build gets a session
 * of its own, and the plan's stays whole for another build. Anywhere else it
 * starts fresh from the plan's text, as a build always could.
 *
 * `workspaces` is the parent's own unless a spec hands it another.
 */
export async function prepareWriter(
  ctx: SubAgentPrepareContext<WriteInput, Env>,
  workspaces: SubtaskWorkspaces = sessionWorkspaces(ctx.parent)
): Promise<Record<string, unknown>> {
  const plan = ctx.input.plan;
  let planned: PlannedSession | undefined;
  if (plan !== undefined) {
    const found = await lookUpPlan(ctx.parent.env, ctx.parent.storage, plan);
    if (!found.ok) throw new Error(`claude_code: ${found.reason}`);
    if (found.plan === undefined) {
      throw new Error(
        `claude_code: the plan \`${plan}\` has nothing on it yet — its planning session wrote no plan.`
      );
    }
    planned = await plannedSession(
      ctx.parent.storage,
      { id: plan, version: latestVersion(found.page) },
      sessionLookup(ctx.parent.env),
      ctx.runId
    );
  }
  const place = await claimSession(workspaces, {
    ...ctx,
    ...(planned?.near ? { near: planned.near } : {})
  });
  const resume = carryOn(planned, place, { fork: true });
  return {
    ...runtimeOf(place),
    ...(plan === undefined ? {} : { [PLAN_KEY]: plan }),
    ...(resume ? { [RESUME_KEY]: resume } : {})
  };
}

const settleWriter = (ctx: SubAgentSettleContext<Env>): Promise<void> =>
  settleSession(sessionWorkspaces(ctx.parent), ctx.parent.storage, ctx);

function workspaceStub(env: Env, name: string) {
  const binding = env.ANTHROPIC_CODING_WORKSPACE;
  return binding.get(binding.idFromName(name));
}

/** How a `prepare` asks a workspace for a run's session. */
function sessionLookup(env: Env) {
  return (workspaceName: string, runId: string) =>
    workspaceStub(env, workspaceName).sessionOf(runId);
}

/** Where a run's conversation to carry on from is kept in what `prepare` hands it. */
const RESUME_KEY = "resume";

/** A conversation a run carries on from, as `prepare` hands it over. */
interface CarryOn {
  sessionId: string;
  /** Under a new session id — a build, which leaves the plan's own whole. */
  fork?: true;
  /** The run that wrote it, whose record goes if the conversation is gone. */
  fromRun: string;
}

/**
 * The conversation a run placed in `place` carries on from: `planned`'s, when
 * the run landed in the workspace that holds it. A scratchpad is the parent's
 * own and always does; a worktree does when it was free to be had again.
 */
function carryOn(
  planned: PlannedSession | undefined,
  place: SessionPlace,
  options: { fork: boolean }
): CarryOn | undefined {
  if (!planned || planned.workspaceName !== place.workspaceName) {
    return undefined;
  }
  return {
    sessionId: planned.sessionId,
    fromRun: planned.runId,
    ...(options.fork ? { fork: true as const } : {})
  };
}

function carryOnOf(
  runtime: Record<string, unknown> | undefined
): CarryOn | undefined {
  const resume = runtime?.[RESUME_KEY];
  return resume &&
    typeof resume === "object" &&
    typeof (resume as CarryOn).sessionId === "string"
    ? (resume as CarryOn)
    : undefined;
}

/**
 * A planning session works in a worktree of its own, as a writing one does, on a
 * plan of this caller's: a new one, opened only once the workspace has admitted
 * the run, or one it names, which must not be locked — approved, or failed
 * before it was written, a locked plan does not change.
 *
 * An edit carries on from the conversation that wrote the plan, in the
 * worktree that holds it, without a fork: revising is one conversation
 * accumulating. See {@link prepareWriter} for where else it ends up.
 */
export async function preparePlanner(
  ctx: SubAgentPrepareContext<PlanInput, Env>,
  workspaces: SubtaskWorkspaces = sessionWorkspaces(ctx.parent)
): Promise<Record<string, unknown>> {
  const { env, storage } = ctx.parent;
  const edits = ctx.input.plan;
  let planned: PlannedSession | undefined;
  if (edits !== undefined) {
    const found = await lookUpPlan(env, storage, edits);
    if (!found.ok) throw new Error(`claude_code_plan: ${found.reason}`);
    if (found.locked) {
      throw new Error(
        `claude_code_plan: the plan \`${edits}\` is locked (${found.status ?? "locked"}), and a locked plan does not change. Write a new plan instead.`
      );
    }
    planned = await plannedSession(
      storage,
      { id: edits, version: latestVersion(found.page) },
      sessionLookup(env),
      ctx.runId
    );
  }
  const run = { taskId: ctx.taskId, runId: ctx.runId };
  const place = await claimPlace(workspaces, {
    ...run,
    ...(planned?.near ? { near: planned.near } : {})
  });
  let id: string;
  try {
    id =
      edits ?? (await createPlan(env, storage, `${ctx.taskId}:${ctx.runId}`));
  } catch (err) {
    // A `prepare` that throws gets no `settle`, so nothing else lets go —
    // and it lets go of the branch, as a planning session's settle does.
    await releaseUnused(workspaces, run, { forgetBranch: true });
    throw err;
  }
  recordPlanRun(storage, {
    runId: ctx.runId,
    planId: id,
    workspaceName: place.workspaceName,
    ...(place.slot ? { slot: place.slot } : {})
  });
  const resume = carryOn(planned, place, { fork: false });
  const plan: PlanPlace = { id, isNew: edits === undefined };
  return {
    ...runtimeOf(place),
    [PLAN_KEY]: plan,
    ...(resume ? { [RESUME_KEY]: resume } : {})
  };
}

/**
 * A planning session's end. A new plan its session never wrote is locked as
 * `failed`, so its page says so rather than waiting on a plan nobody will write
 * — whether or not stopping the session worked; an edit that failed leaves the
 * plan as it was.
 */
export async function settlePlanner(
  ctx: SubAgentSettleContext<Env>,
  workspaces: SubtaskWorkspaces = sessionWorkspaces(ctx.parent)
): Promise<void> {
  try {
    // Without its branch: a planning session commits nothing, and a branch
    // with no work on it is nothing for the parent to review.
    await settleSession(workspaces, ctx.parent.storage, ctx, {
      forgetBranch: true
    });
  } finally {
    await closeUnwritten(ctx);
  }
}

async function closeUnwritten(ctx: SubAgentSettleContext<Env>): Promise<void> {
  const plan = planPlaceOf(ctx.runtime);
  if (!plan?.isNew) return;
  const artifacts = requireArtifactsStub(ctx.parent.env);
  const page = await artifacts.readArtifact(plan.id);
  if (page && !page.locked && latestPlan(page.entries) === undefined) {
    await artifacts.lock(plan.id, "failed");
  }
}

/**
 * What the parent is told of a planning session, having filed its plan: the
 * plan's id and title, and the session's account — see `./plans.ts`.
 * The session answers through `--json-schema`; one that did not files nothing.
 */
export async function reportPlan(
  env: Env,
  plan: PlanPlace,
  runId: string,
  outcome: SessionOutcome,
  onFiled?: (sessionId: string, version: number) => Promise<void>
): Promise<string> {
  const result = outcome.session.result;
  const answer = PlanAnswer.safeParse(result?.structured);
  if (!result || result.isError || !answer.success) {
    return planReport(outcome, { kind: "unanswered" });
  }
  const filed = await requireArtifactsStub(env).addEntry(plan.id, {
    label: PLAN_LABEL,
    text: planText(answer.data),
    key: runId
  });
  if (filed === null) {
    return planReport(outcome, {
      kind: "locked",
      id: plan.id,
      lastReply: answer.data.lastReply
    });
  }
  // What lets an edit or a build carry on from this conversation: see
  // `plannedSession` in `./plans.ts`.
  const sessionId = result.sessionId || outcome.session.sessionId;
  if (onFiled && sessionId) await onFiled(sessionId, filed.sequence);
  return planReport(outcome, {
    kind: "filed",
    id: plan.id,
    title: answer.data.title.trim(),
    lastReply: answer.data.lastReply
  });
}

/** Where a run's plan is kept in what `prepare` hands it. */
const PLAN_KEY = "plan";

/** A planning session's plan, as `prepare` hands it over. */
export interface PlanPlace {
  id: string;
  /** Opened for this run, rather than an edit of one that was there. */
  isNew: boolean;
}

function planPlaceOf(
  runtime: Record<string, unknown> | undefined
): PlanPlace | undefined {
  const plan = runtime?.[PLAN_KEY];
  return plan && typeof plan === "object" && "id" in plan
    ? (plan as PlanPlace)
    : undefined;
}

/** The plan a writing session carries out, if it names one. */
function writerPlanOf(
  runtime: Record<string, unknown> | undefined
): string | undefined {
  const plan = runtime?.[PLAN_KEY];
  return typeof plan === "string" ? plan : undefined;
}

/** A Claude Code session as a sub-agent: the writer, the planner and the reader below. */
abstract class ClaudeCodeRun extends SubAgent<Env> {
  protected abstract readonly kind: "write" | "plan";

  override getModel(): ThinkModel {
    const runtime = this.pluginContext().runtime();
    const place = placeOf(runtime);
    const writes = this.kind === "write" && place.branch !== undefined;
    const plan = this.kind === "plan" ? planPlaceOf(runtime) : undefined;
    if (this.kind === "plan" && !plan) {
      throw new Error(
        "anthropic-coding: this planning run carries no plan; its spec's prepare opens one"
      );
    }
    const resume = carryOnOf(runtime);
    return claudeCodeModel({
      config: claudeCodeConfig(this.env),
      // A new stub per open: a re-attach after a cut stream opens it again, and
      // the stub that stream came over may not have survived it.
      workspace: () =>
        openWorkspace(
          this.#stub(place.workspaceName)
        ) as Promise<SessionWorkspace>,
      storage: this.ctx.storage,
      runId: this.name,
      dir: place.dir,
      // A plan is a writing session under `plan`, answering as data: it reads,
      // changes nothing, and has nobody to approve its plan mid-run.
      ...(plan
        ? { jsonSchema: PLAN_OUTPUT, permissionMode: "plan" as const }
        : {}),
      ...(resume
        ? {
            resume: {
              sessionId: resume.sessionId,
              ...(resume.fork ? { fork: true } : {})
            }
          }
        : {}),
      // The method itself, bound: a wrapper's argument list is a place to drop
      // the card, and plugins' own spec is what proves the model passes it.
      note: this.note.bind(this),
      // Every run's, so a later one can carry on from it: see `noteSession`
      // on the workspace.
      onSession: (record) =>
        this.#noteSession(place, { sessionId: record.sessionId }),
      brief: (task) =>
        plan
          ? this.#planBrief(task, place, plan, resume !== undefined)
          : this.#brief(
              task,
              place,
              writes,
              writerPlanOf(runtime),
              resume !== undefined
            ),
      ...(writes
        ? { followUp: (session: SessionEnd) => this.#followUp(session, place) }
        : {}),
      report: async (outcome) => {
        if (resume && notResumable(outcome)) {
          await this.#forgetSession(place, resume.fromRun);
          return unresumableReport(plan ? "plan" : "write");
        }
        return plan
          ? reportPlan(
              this.env,
              plan,
              this.name,
              outcome,
              (sessionId, version) =>
                this.#noteSession(place, { sessionId, plan: plan.id, version })
            )
          : this.#report(outcome, place, writes);
      }
    });
  }

  /**
   * Record a run's session on the workspace that holds its conversation.
   * Best-effort: a record lost is a later run starting fresh from the plan,
   * which it always could.
   */
  async #noteSession(place: SessionPlace, note: SessionNote): Promise<void> {
    try {
      await this.#stub(place.workspaceName).noteSession(this.name, note);
    } catch (err) {
      console.warn("[anthropic-coding] could not record the session", {
        runId: this.name,
        err: String(err)
      });
    }
  }

  /** A conversation found gone, so the next run starts fresh rather than fail again. */
  async #forgetSession(place: SessionPlace, runId: string): Promise<void> {
    try {
      await this.#stub(place.workspaceName).forgetSession(runId);
    } catch (err) {
      console.warn("[anthropic-coding] could not forget a lost session", {
        runId,
        err: String(err)
      });
    }
  }

  #stub(name: string) {
    return workspaceStub(this.env, name);
  }

  /** A shell in a named workspace, under the settings every tool uses. */
  #exec(name: string) {
    return workspaceExec(container(this.env, () => name));
  }

  /**
   * The session's prompt. Runs once per run, before the session starts, and a
   * throw fails the run with its message. Whether the run can be paid for was
   * asked in `prepare` — see `admitSession` in `./plugins.ts`.
   *
   * **What is true about the workspace, folded in.** The session starts whatever
   * the workspace's state, and it has no tool that reaches the host, so a fact
   * it is not given is one the parent never sees either. Reported, never
   * enforced: a Claude Code session can run `npm ci` itself, so the useful
   * thing is to hand it the facts. The wording is the plugin's.
   */
  async #brief(
    task: string,
    place: SessionPlace,
    writes: boolean,
    planId: string | undefined,
    resumed: boolean
  ): Promise<string> {
    const note = sessionAdvisory(
      await this.#stub(place.workspaceName).advisories()
    );
    const plan = planId
      ? { text: await this.#plan(planId), resumed }
      : undefined;
    if (!writes) return sessionBrief(task, note, undefined, plan);
    const submodules = await this.#submodules(place);
    await this.#recordStarts(place, [".", ...submodules]);
    return sessionBrief(
      task,
      note,
      {
        branch: place.branch as string,
        submodules,
        continues: place.continues ?? false
      },
      plan
    );
  }

  /** The latest version of a plan `prepare` checked; gone since is a refusal. */
  async #plan(id: string): Promise<string> {
    const page = await requireArtifactsStub(this.env).readArtifact(id);
    const plan = page ? latestPlan(page.entries) : undefined;
    if (plan === undefined) {
      throw new Error(
        `claude_code: the plan \`${id}\` is gone. Write it again.`
      );
    }
    return plan;
  }

  /**
   * A planning session's prompt: the task and, for an edit, the plan it changes
   * with everything said about it since — the person's comments are on the
   * plan's page, and the session has no other view of them.
   */
  async #planBrief(
    task: string,
    place: SessionPlace,
    plan: PlanPlace,
    resumed: boolean
  ): Promise<string> {
    const note = sessionAdvisory(
      await this.#stub(place.workspaceName).advisories()
    );
    if (plan.isNew) return planBrief(task, note);
    const page = await requireArtifactsStub(this.env).readArtifact(plan.id);
    const entries = page?.entries ?? [];
    // Carrying on, the session has read what was said up to the version it
    // wrote; what is new is what came after it.
    const since = resumed ? entries.slice(lastPlanIndex(entries) + 1) : entries;
    return planBrief(task, note, {
      ...(page && !resumed ? { plan: latestPlan(entries) } : {}),
      said: since
        .filter((entry) => entry.label !== PLAN_LABEL)
        .map((entry) => entry.text),
      resumed
    });
  }

  /**
   * One more turn for a session that finished and left work uncommitted.
   *
   * Only for a session that finished and said it succeeded. One that failed, or
   * died without a result, is reported as it is and loses what it left
   * uncommitted without being asked — a turn spent asking a session that could
   * not finish its task is a turn spent on a session that cannot finish.
   */
  async #followUp(
    session: SessionEnd,
    place: SessionPlace
  ): Promise<string | undefined> {
    if (!needsWarning(session)) return undefined;
    const dirty = await this.#uncommitted(place, await this.#starts());
    return dirty.length > 0 ? warningPrompt(dirty) : undefined;
  }

  /**
   * What the parent receives. For a writing session: delete what it left
   * uncommitted, and count what it kept.
   *
   * **After the session, and that ordering is load-bearing.** Every read here
   * goes through the workspace's filesystem, which the container's edits only
   * reach once the drain has unwound; the model calls this after it has.
   *
   * Nothing is discarded for a session stopped from outside: it did not choose
   * what it left, and whoever stopped it decides. `keep` in
   * `@/workspace/subtask-workspace` commits it, and a discard here would race
   * that commit and lose the work it exists to keep.
   */
  async #report(
    outcome: SessionOutcome,
    place: SessionPlace,
    writes: boolean
  ): Promise<string> {
    const last = outcome.followUp ?? outcome.session;
    const reading = last.rateLimit ?? outcome.session.rateLimit;
    if (reading) await this.#noteRateLimit(place, reading);
    if (!writes) return sessionReport(outcome);

    const repos = await this.#starts();
    const stopped = last.exitCode === STOPPED_EXIT;
    const discarded = stopped
      ? { files: [], failed: false }
      : await this.#discard(place, repos);
    const writing: WritingOutcome = {
      branch: place.branch as string,
      commits: await this.#commits(place, repos),
      discarded: discarded.files,
      ...(discarded.failed ? { discardFailed: true } : {})
    };
    return sessionReport(outcome, writing);
  }

  /**
   * Tell the credential pool what the session's own client reported.
   *
   * The pool's state lives on the workspace object, which is also where the
   * egress gateway reads it, so the reading goes there rather than being acted
   * on here. Best-effort — a session that did the work must not fail for want
   * of a bookkeeping RPC.
   */
  async #noteRateLimit(
    place: SessionPlace,
    info: RateLimitInfo
  ): Promise<void> {
    try {
      await this.#stub(place.workspaceName).claudeNoteRateLimit(info);
    } catch (err) {
      console.warn("[anthropic-coding] could not record the bucket reading", {
        err: String(err)
      });
    }
  }

  /**
   * The submodules this worktree carries, for the brief and the accounting.
   *
   * Read from the checkout rather than carried from `prepare`: the checkout is
   * what was cloned. Unreadable reads as none — the brief loses a paragraph,
   * and what the session commits in a submodule is kept all the same, just not
   * counted.
   */
  async #submodules(place: SessionPlace): Promise<string[]> {
    try {
      return (
        await readSubmodules(this.#exec(place.workspaceName), place.dir)
      ).map((sub) => sub.path);
    } catch (err) {
      console.warn(
        "[anthropic-coding] could not read the checkout's submodules",
        {
          err: String(err)
        }
      );
      return [];
    }
  }

  /**
   * Where each repository starts, for {@link #commits} to count from. Once per
   * run: reading HEAD again after the session has committed would move the
   * baseline past the commits it exists to count.
   */
  async #recordStarts(
    place: SessionPlace,
    paths: readonly string[]
  ): Promise<void> {
    if (await this.ctx.storage.get(REPOS_KEY)) return;
    let starts: RepoStart[] = [];
    try {
      const read = await this.#exec(place.workspaceName)(READ_HEADS, {
        cwd: place.dir,
        env: { REPO_PATHS: paths.join("\n") }
      });
      starts = tabbed(read.stdout).map(([path = "", start = ""]) => ({
        path,
        start
      }));
    } catch (err) {
      console.warn(
        "[anthropic-coding] could not read where the session starts",
        {
          err: String(err)
        }
      );
    }
    await this.ctx.storage.put(
      REPOS_KEY,
      starts.length > 0 ? starts : paths.map((path) => ({ path, start: "" }))
    );
  }

  /** The repositories to account for — at least the checkout itself. */
  async #starts(): Promise<readonly RepoStart[]> {
    const repos = (await this.ctx.storage.get<RepoStart[]>(REPOS_KEY)) ?? [];
    return repos.length > 0 ? repos : [{ path: ".", start: "" }];
  }

  /** What each repository holds uncommitted, in the order they were recorded. */
  async #uncommitted(
    place: SessionPlace,
    repos: readonly RepoStart[]
  ): Promise<Uncommitted[]> {
    try {
      const listed = await this.#exec(place.workspaceName)(LIST_UNCOMMITTED, {
        cwd: place.dir,
        env: { REPO_PATHS: repos.map((repo) => repo.path).join("\n") }
      });
      const byPath = new Map<string, string[]>();
      for (const [path = "", file = ""] of tabbed(listed.stdout)) {
        byPath.set(path, [...(byPath.get(path) ?? []), file]);
      }
      return [...byPath].map(([path, files]) => ({ path, files }));
    } catch (err) {
      console.warn("[anthropic-coding] could not read what is uncommitted", {
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
    place: SessionPlace,
    repos: readonly RepoStart[]
  ): Promise<{ files: Uncommitted[]; failed: boolean }> {
    const dirty = await this.#uncommitted(place, repos);
    try {
      const done = await this.#exec(place.workspaceName)(DISCARD, {
        cwd: place.dir,
        env: { REPO_PATHS: repos.map((repo) => repo.path).join("\n") }
      });
      if (!done.success) {
        console.warn(
          "[anthropic-coding] the uncommitted work was not all deleted",
          {
            stderr: done.stderr.trim().slice(0, 500)
          }
        );
      }
      return { files: dirty, failed: !done.success };
    } catch (err) {
      console.warn("[anthropic-coding] could not delete the uncommitted work", {
        err: String(err)
      });
      return { files: dirty, failed: true };
    }
  }

  /** Commits past where each repository started; uncounted where unreadable. */
  async #commits(
    place: SessionPlace,
    repos: readonly RepoStart[]
  ): Promise<WritingOutcome["commits"]> {
    try {
      const read = await this.#exec(place.workspaceName)(COUNT_COMMITS, {
        cwd: place.dir,
        env: {
          REPO_STARTS: repos
            .map((repo) => `${repo.path}\t${repo.start}`)
            .join("\n")
        }
      });
      const counts = new Map(
        tabbed(read.stdout).map(([path = "", count = ""]) => [path, count])
      );
      return repos.map((repo) => {
        const count = Number(counts.get(repo.path) || NaN);
        return Number.isInteger(count)
          ? { path: repo.path, count }
          : { path: repo.path };
      });
    } catch (err) {
      console.warn("[anthropic-coding] could not count the session's commits", {
        err: String(err)
      });
      return repos.map((repo) => ({ path: repo.path }));
    }
  }
}

/** A writing session, in a worktree of its own, carrying out a plan if given one. */
export class AnthropicCodingWriterChild extends ClaudeCodeRun {
  static override spec = {
    ...CLAUDE_CODE_AGENT,
    inputSchema: WRITE_INPUT,
    prepare: prepareWriter,
    settle: settleWriter
  } as SubAgentSpec<never, never>;
  protected readonly kind = "write";
}

/**
 * A planning session: a writing session under `plan`, in a worktree of its
 * own, that answers through `--json-schema` and whose answer is filed as a plan
 * — see `./plans.ts`. The writer's spec under another name, description and
 * input, since what makes it a planner is how it is launched.
 */
export class AnthropicCodingPlannerChild extends ClaudeCodeRun {
  static override spec = {
    ...CLAUDE_CODE_AGENT,
    name: "claude_code_plan",
    description: PLANNER_DESCRIPTION,
    inputSchema: PLAN_INPUT,
    prepare: preparePlanner,
    settle: settlePlanner
  } as SubAgentSpec<never, never>;
  protected readonly kind = "plan";
}

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
  type SandboxRuns,
  type SessionEnd,
  type SessionOutcome
} from "@dynamicagents/plugins/claude-code";
import {
  sandboxName,
  sandboxNameFromRuntime,
  SANDBOX_RUNTIME_KEY,
  sessionAdvisory
} from "@dynamicagents/plugins/sandbox";
import { CLAUDE_CODE_SESSION } from "@/config";
import { sandboxShell } from "@/workspace/container";
import {
  placementRepo,
  readSubmodules,
  type RunRef,
  type SessionPlace,
  type SubtaskWorkspaces
} from "@/workspace/subtask-workspace";
import { activeRepo } from "@/workspace/active-repo";
import { isBranchName } from "@/workspace/worktree-pool";
import { branchSession, recordBranchRun, type BranchScope } from "./branches";
import {
  createPlan,
  lastPlanIndex,
  latestPlan,
  latestVersion,
  lookUpPlan,
  PLAN_INPUT,
  PLAN_LABEL,
  PlanAnswer,
  PLANNER_DESCRIPTION,
  plannedSession,
  planText,
  recordPlanRun,
  REVISE_INPUT,
  REVISER_DESCRIPTION,
  revisionsText,
  WRITE_INPUT,
  WRITER_DESCRIPTION,
  type PlannedSession,
  type PlanInput,
  type ReviseInput,
  type WriteInput
} from "./plans";
import { sessionWorkspaces } from "./plugins";
import {
  DISCOVER_INPUT,
  DISCOVERER_DESCRIPTION,
  discoveryLine,
  fileReport,
  forgetReport,
  openReport,
  reportDiscovery,
  reportWasFiled,
  type DiscoverInput
} from "./reports";
import type { SessionNote } from "./sandbox";
import type { SessionSchema } from "./schemas";
import {
  COUNT_COMMITS,
  DISCARD,
  LIST_UNCOMMITTED,
  READ_HEADS,
  RETURN_TO_START,
  STOPPED_EXIT,
  discoveryBrief,
  needsWarning,
  notResumable,
  planBrief,
  planReport,
  revisionNote,
  sessionBrief,
  sessionReport,
  tabbed,
  unresumableReport,
  warningPrompt,
  writingNote,
  type ArtifactWriteContext,
  type RepoStart,
  type Uncommitted,
  type WritingOutcome
} from "./session";

/**
 * `claude-coordinator`'s sub-agents: a Claude Code session each, not a model loop.
 *
 * The session is the sub-agent's **model** — `claudeCodeModel` in
 * `@dynamicagents/plugins/claude-code` — so Think's recovery drives it: a run
 * cut by an eviction or a deploy is continued, and the model polls the
 * session, which the sandbox kept running, from where it stopped. What is here is this deployment's half: the
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
 * and `ClaudeCoordinatorAgent.formatDetachedCompletion` reads it back. SQL rather than
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
 * Where a session works, as `prepare` hands it over. Its sandbox is under
 * `SANDBOX_RUNTIME_KEY`, so the plugins' own readers find it too.
 */
function runtimeOf(place: SessionPlace): Record<string, unknown> {
  return {
    [SANDBOX_RUNTIME_KEY]: place.workspaceName,
    dir: place.dir,
    ...(place.branch ? { branch: place.branch } : {}),
    ...(place.continues ? { continues: true } : {})
  };
}

/** The same, read back in the sub-agent. Its absence is a wiring fault. */
function placeOf(runtime: Record<string, unknown> | undefined): SessionPlace {
  const workspaceName = sandboxNameFromRuntime(runtime);
  const dir = runtime?.dir;
  if (!workspaceName || typeof dir !== "string") {
    throw new Error(
      "claude-coordinator: this run carries no workspace; its spec's prepare supplies one"
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
      console.warn(
        "[claude-coordinator] could not release an unused worktree",
        {
          runId: run.runId,
          err: String(released)
        }
      )
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
 *
 * A session that worked on a branch takes the parent's reads with it, so the
 * report and the files it describes are in front of the parent together. A
 * planning session's branch is forgotten, and its reads stay where they were.
 */
export async function settleSession(
  workspaces: SubtaskWorkspaces,
  storage: DurableObjectStorage,
  ctx: Pick<SubAgentSettleContext<Env>, "taskId" | "runId" | "result">,
  options: { forgetBranch?: boolean } = {}
): Promise<void> {
  const run = { taskId: ctx.taskId, runId: ctx.runId };
  const forget = options.forgetBranch ? { forgetBranch: true } : {};
  const follow = options.forgetBranch ? {} : { follow: true };
  if (ctx.result.status === "completed") {
    return workspaces.release(run, { ...forget, ...follow });
  }
  const kept = await workspaces.keep(run);
  if (kept.note) keepNote(storage, ctx.taskId, ctx.runId, kept.note);
  // A worktree held for work it could not secure keeps its branch, which is
  // how its work is found.
  await workspaces.release(
    run,
    kept.settled
      ? { hold: false, ...forget, ...follow }
      : { hold: true, ...follow }
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
  if (plan === undefined && ctx.input.continue) {
    if (ctx.input.branch) {
      throw new Error(
        "claude_code: pass `continue` to add to a branch, or `branch` to name a new one — not both."
      );
    }
    return await placeOnBranch(ctx, ctx.input.continue, workspaces);
  }
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
  noteBranchRun(ctx, place);
  const resume = carryOn(planned, place, { fork: true });
  return {
    ...runtimeOf(place),
    ...(plan === undefined ? {} : { [PLAN_KEY]: plan }),
    ...(resume ? { [RESUME_KEY]: resume } : {})
  };
}

/**
 * A session sent back to a branch, carrying on the conversation that last
 * worked on it — in that worktree, which is where the conversation is — and
 * without a fork: one conversation accumulating is what going back means.
 * Anywhere else it starts fresh, told the branch holds earlier work.
 *
 * `revising` is what else a revision works on, held by the same claim.
 */
async function placeOnBranch(
  ctx: Pick<
    SubAgentPrepareContext<unknown, Env>,
    "taskId" | "runId" | "parent"
  >,
  branch: string,
  workspaces: SubtaskWorkspaces,
  revising: readonly string[] = []
): Promise<Record<string, unknown>> {
  const last = await branchSession(
    ctx.parent.storage,
    branch,
    branchScope(ctx.parent),
    sessionLookup(ctx.parent.env),
    ctx.runId
  );
  const place = await claimPlace(workspaces, {
    taskId: ctx.taskId,
    runId: ctx.runId,
    continue: branch,
    ...(last?.near ? { near: last.near } : {}),
    ...(revising.length > 0 ? { revising } : {})
  });
  noteBranchRun(ctx, place);
  const resume = carryOn(last, place, { fork: false });
  return {
    ...runtimeOf(place),
    ...(resume ? { [RESUME_KEY]: resume } : {})
  };
}

/**
 * Which of this caller's runs on a branch name are *this* branch's: the ones
 * placed where this session will be. Read the way `resolve` in
 * `@/workspace/subtask-workspace.ts` places the session — a worktree of the
 * selected repository's root, or the parent's own workspace when the selection
 * names no repository. See {@link BranchScope}.
 */
function branchScope(parent: {
  storage: DurableObjectStorage;
  callerKey: () => string;
}): BranchScope {
  const active = activeRepo(parent.storage);
  const repo = placementRepo(active);
  return repo === undefined
    ? { workspaceName: sandboxName(parent.callerKey(), active.get()) }
    : { repo };
}

/** Which conversation a branch now carries: see `./branches.ts`. */
function noteBranchRun(
  ctx: Pick<SubAgentPrepareContext<unknown, Env>, "runId" | "parent">,
  place: SessionPlace
): void {
  if (!place.branch) return;
  recordBranchRun(ctx.parent.storage, {
    runId: ctx.runId,
    branch: place.branch,
    workspaceName: place.workspaceName,
    ...(place.slot ? { slot: place.slot } : {})
  });
}

/**
 * A revising session, sent back to the branches it is named.
 *
 * **Every branch is checked before anything is claimed**, and a call naming one
 * that cannot be worked on is refused whole, saying why for each: a name git
 * would not take, one named twice, or one a session is working on now. Each of
 * those is answerable here, from this object's own state.
 *
 * **Whether a pull request is open is not checked, deliberately.** It was, and
 * it cost an API call per branch per repository on the path of every revision —
 * to prevent a failure a session reports for itself in a sentence. A branch
 * whose pull request is merged, closed or absent is dispatched, and the session
 * says so. The worst of it is one container start; a revising session pushes
 * only the branches it was named and never merges.
 *
 * Then the session is placed on `branch` as a `continue` is, carrying on the
 * conversation that last worked on it (see {@link placeOnBranch}), and checks
 * out any other listed branch itself. Only `branch`'s conversation is carried
 * on: the others are a dependency's pull requests, written as part of the same
 * change or by somebody else.
 */
export async function prepareReviser(
  ctx: SubAgentPrepareContext<ReviseInput, Env>,
  workspaces: SubtaskWorkspaces = sessionWorkspaces(ctx.parent)
): Promise<Record<string, unknown>> {
  const active = activeRepo(ctx.parent.storage);
  const root = placementRepo(active);
  if (root === undefined) {
    throw new Error(
      "claude_code_revise: there is no repository checked out. Clone the one the branches are in with `repo_clone` first."
    );
  }
  const home = ctx.input.branch;
  const check = (branch: string): string | undefined => {
    if (!isBranchName(branch)) return "not a branch name";
    if (workspaces.working(branch)) {
      return "a session is working on it now; wait for its report";
    }
    return undefined;
  };
  const seen = new Set<string>();
  const refused: { branch: string; why: string }[] = [];
  const homeWhy = check(home);
  if (homeWhy) refused.push({ branch: home, why: homeWhy });
  for (const { branch } of ctx.input.revisions) {
    if (seen.has(branch)) {
      refused.push({ branch, why: "named more than once" });
      continue;
    }
    seen.add(branch);
    // `branch` is checked once, as the branch the work is on.
    const why = branch === home ? undefined : check(branch);
    if (why) refused.push({ branch, why });
  }
  if (refused.length > 0) {
    throw new Error(
      [
        "claude_code_revise: nothing was started, because:",
        ...refused.map((check) => `- \`${check.branch}\`: ${check.why}.`)
      ].join("\n")
    );
  }
  const revisions: Revision[] = [...seen].map((branch) => ({ branch }));
  const runtime = await placeOnBranch(
    ctx,
    home,
    workspaces,
    [...seen].filter((branch) => branch !== home)
  );
  return { ...runtime, [REVISIONS_KEY]: revisions };
}

/** A branch a revising session was sent back to. */
interface Revision {
  branch: string;
}

/** Where a revising run's branches are kept in what `prepare` hands it. */
const REVISIONS_KEY = "revisions";

function revisionsOf(
  runtime: Record<string, unknown> | undefined
): Revision[] | undefined {
  const revisions = runtime?.[REVISIONS_KEY];
  return Array.isArray(revisions) ? (revisions as Revision[]) : undefined;
}

/**
 * What a revising session leaves. Completed, its worktree is released on the
 * branch the work is on, where the next revision finds it and the conversation
 * it carries on. Stopped before that, what it had not pushed is kept in the
 * worktree, which stays held. The note says so itself rather than pass on
 * `keep`'s, which tells the parent to `continue` a branch that has a pull
 * request, and names the worktree's branch for work left on another one the
 * session had checked out.
 */
export async function settleReviser(
  ctx: Pick<
    SubAgentSettleContext<Env>,
    "taskId" | "runId" | "result" | "runtime"
  >,
  workspaces: SubtaskWorkspaces,
  storage: DurableObjectStorage
): Promise<void> {
  const run = { taskId: ctx.taskId, runId: ctx.runId };
  if (ctx.result.status === "completed") {
    return workspaces.release(run, { follow: true });
  }
  await workspaces.keep(run);
  const branch = placeOf(ctx.runtime).branch;
  keepNote(
    storage,
    ctx.taskId,
    ctx.runId,
    "What it pushed is on the pull requests. What it had not is kept in its " +
      `worktree, which \`repo_worktree\` with \`${branch}\` points your reads at, ` +
      `and \`claude_code_revise\` with \`${branch}\` as its branch carries on.`
  );
  await workspaces.release(run, { hold: true });
}

const settleWriter = (ctx: SubAgentSettleContext<Env>): Promise<void> =>
  settleSession(sessionWorkspaces(ctx.parent), ctx.parent.storage, ctx);

function sandboxStub(env: Env, name: string) {
  return env.CLAUDE_COORDINATOR_SANDBOX.getByName(name);
}

/** How a `prepare` asks a sandbox for a run's session. */
function sessionLookup(env: Env) {
  return (workspaceName: string, runId: string) =>
    sandboxStub(env, workspaceName).sessionOf(runId);
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
  /**
   * The transcript the conversation's notes are on, when this run carries
   * the conversation on rather than forking it: the same session, so the
   * same page. A fork is a session of its own, with a page of its own.
   */
  transcript?: string;
  /** The conversation stopped to ask: what carries it on is the answer. */
  asked?: true;
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
    ...(options.fork
      ? { fork: true as const }
      : { transcript: planned.transcript }),
    ...(planned.asked ? { asked: true as const } : {})
  };
}

/**
 * The transcript a run files on, when it is not its own: the conversation's it
 * carries on. A sub-agent spec's `transcriptKey`, so a plan edited or a branch
 * continued goes on the page the session already has, and the thread is not
 * given a second link to it.
 */
export function carriedTranscript({
  runtime
}: {
  runtime: Record<string, unknown> | undefined;
}): string | undefined {
  return carryOnOf(runtime)?.transcript;
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
 * accumulating — and so does answering a session that stopped to ask. See
 * {@link prepareWriter} for where else it ends up.
 */
export async function preparePlanner(
  ctx: SubAgentPrepareContext<PlanInput, Env>,
  workspaces: SubtaskWorkspaces = sessionWorkspaces(ctx.parent)
): Promise<Record<string, unknown>> {
  const { env, storage } = ctx.parent;
  const edits = ctx.input.plan;
  let planned: PlannedSession | undefined;
  let version: number | undefined;
  if (edits !== undefined) {
    const found = await lookUpPlan(env, storage, edits);
    if (!found.ok) throw new Error(`claude_code_plan: ${found.reason}`);
    if (found.locked) {
      throw new Error(
        `claude_code_plan: the plan \`${edits}\` is locked (${found.status ?? "locked"}), and a locked plan does not change. Write a new plan instead.`
      );
    }
    version = latestVersion(found.page);
    planned = await plannedSession(
      storage,
      { id: edits, version },
      sessionLookup(env),
      ctx.runId,
      { asked: true }
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
      edits ??
      (await createPlan(env, storage, {
        owner: ctx.parent.callerKey(),
        sourceKey: `${ctx.taskId}:${ctx.runId}`
      }));
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
  const plan: PlanPlace = {
    id,
    isNew: edits === undefined,
    ...(version !== undefined ? { version } : {})
  };
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
 * plan as it was. A session that stopped to ask has not written it yet, and
 * answering it carries it on, so its plan stays open.
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
  // `isNew` carries the authorization as well as the behaviour: core's `lock`
  // takes no owner, and a new plan's page is one this run's `prepare` opened
  // rather than one a model named.
  if (!plan?.isNew) return;
  const workspaceName = sandboxNameFromRuntime(ctx.runtime);
  let note: SessionNote | undefined;
  try {
    note = workspaceName
      ? await sessionLookup(ctx.parent.env)(workspaceName, ctx.runId)
      : undefined;
  } catch {
    // Unreadable: left open, since closing it would refuse an answer to a
    // question the session may have asked. An open page with nothing on it
    // costs nothing.
    return;
  }
  if (note?.asked) return;
  const artifacts = requireArtifactsStub(ctx.parent.env);
  const page = await artifacts.readArtifact(plan.id);
  if (page && !page.locked && latestPlan(page.entries) === undefined) {
    await artifacts.lock(plan.id, "failed");
  }
}

/**
 * What the parent is told of a planning session, having filed its plan: the
 * plan's id and title, and the session's account — see `./plans.ts`. One that
 * stopped to ask files nothing, and its questions go to the parent instead.
 * The session answers through `--json-schema`; one that did not files nothing.
 *
 * `onSession` records the session against the plan — the version it filed, or
 * the one it asked on — which is what lets an edit, an answer or a build carry
 * this conversation on: see `plannedSession` in `./plans.ts`. A record of a
 * version filed is best-effort; one of a question must land or fail the run.
 *
 * The version filed below asserts `run.owner` against the plan's own, so a
 * page this caller did not open, and one owned by nobody, take no version from
 * it. {@link ClaudeCodeRun.artifactWriteContext} is where that owner is read,
 * and says why it is read there rather than carried in {@link PlanPlace}.
 */
export async function reportPlan(
  env: Env,
  plan: PlanPlace,
  run: ArtifactWriteContext,
  outcome: SessionOutcome,
  onSession?: (
    sessionId: string,
    filed: { version?: number; asked?: true }
  ) => Promise<void>
): Promise<string> {
  const result = outcome.session.result;
  const answer = PlanAnswer.safeParse(result?.structured);
  if (!result || result.isError || !answer.success) {
    return planReport(outcome, { kind: "unanswered" });
  }
  const sessionId = result.sessionId || outcome.session.sessionId;
  if (answer.data.status === "needs_input") {
    // Recorded before the question is reported, and not best-effort: the
    // record is what keeps the plan open for the answer — see `closeUnwritten`.
    if (onSession && sessionId) {
      await onSession(sessionId, {
        ...(plan.version !== undefined ? { version: plan.version } : {}),
        asked: true
      });
    }
    return planReport(outcome, {
      kind: "asked",
      id: plan.id,
      questions: answer.data.questions,
      lastReply: answer.data.lastReply
    });
  }
  const filed = await requireArtifactsStub(env).addEntry(
    plan.id,
    {
      label: PLAN_LABEL,
      text: planText(answer.data),
      key: run.runId
    },
    { owner: run.owner }
  );
  if (filed === null) {
    return planReport(outcome, {
      kind: "refused",
      id: plan.id,
      lastReply: answer.data.lastReply
    });
  }
  if (onSession && sessionId) {
    await onSession(sessionId, { version: filed.sequence });
  }
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
  /**
   * The version the run starts from — what it carries on or is shown — and
   * none on a plan with nothing on it yet. A run that asks is recorded against
   * it, not against whatever is latest when it ends: another edit may have
   * filed a newer one meanwhile, which this conversation never saw.
   */
  version?: number;
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

/**
 * A discovery session works in a checkout of its own, on a page opened for the
 * report it will file.
 *
 * The page is opened here, before the session runs, for the reason a plan's is:
 * the run needs an id to file onto, and no model may choose one. The skill it
 * runs under is read from the task, which is where the model named it, and it
 * is what the page is filed under so a later run of the same skill is handed
 * it. See `./reports.ts`.
 */
export async function prepareDiscoverer(
  ctx: SubAgentPrepareContext<DiscoverInput, Env>,
  workspaces: SubtaskWorkspaces = sessionWorkspaces(ctx.parent)
): Promise<Record<string, unknown>> {
  const run = { taskId: ctx.taskId, runId: ctx.runId };
  const place = await claimPlace(workspaces, run);
  const line = discoveryLine(ctx.input.task);
  let id: string;
  try {
    id = await openReport(ctx.parent.env, ctx.parent.storage, {
      ...(line ? { line } : {}),
      runId: ctx.runId,
      sourceKey: `${ctx.taskId}:${ctx.runId}`,
      owner: ctx.parent.callerKey()
    });
  } catch (err) {
    // Given up here, with its branch, for the reason {@link preparePlanner}
    // gives where it does the same.
    await releaseUnused(workspaces, run, { forgetBranch: true });
    throw err;
  }
  const report: ReportPlace = { id, ...(line ? { line } : {}) };
  return { ...runtimeOf(place), [REPORT_KEY]: report };
}

/**
 * A discovery session's end. Its worktree goes back without its branch, as a
 * planning session's does: it commits nothing, and a branch with no work on it
 * is nothing for the parent to review.
 *
 * Then the record of the page it was given becomes history, or goes. A page
 * with no report on it is not history: left listed, it would be handed to a
 * later run as an earlier attempt and read as a blank one.
 */
export async function settleDiscoverer(
  ctx: SubAgentSettleContext<Env>,
  workspaces: SubtaskWorkspaces = sessionWorkspaces(ctx.parent)
): Promise<void> {
  try {
    await settleSession(workspaces, ctx.parent.storage, ctx, {
      forgetBranch: true
    });
  } finally {
    await settleRecord(ctx);
  }
}

async function settleRecord(ctx: SubAgentSettleContext<Env>): Promise<void> {
  const report = reportPlaceOf(ctx.runtime);
  if (!report) return;
  let filed = true;
  try {
    filed = await reportWasFiled(ctx.parent.env, report.id);
  } catch (err) {
    // Unreadable is not unfiled: a record is dropped on an answer, never on a
    // failure to get one. A page that is there with a report on it would
    // otherwise be lost to every later run.
    console.warn("[claude-coordinator] could not read a report's page", {
      err: String(err)
    });
  }
  if (filed) fileReport(ctx.parent.storage, report.id);
  else forgetReport(ctx.parent.storage, report.id);
}

/** Where a discovery run's report page is kept in what `prepare` hands it. */
const REPORT_KEY = "report";

/** The page a discovery run files on, as `prepare` hands it over. */
export interface ReportPlace {
  id: string;
  /** The skill the task named, which the page is filed under. */
  line?: string;
}

function reportPlaceOf(
  runtime: Record<string, unknown> | undefined
): ReportPlace | undefined {
  const report = runtime?.[REPORT_KEY];
  return report && typeof report === "object" && "id" in report
    ? (report as ReportPlace)
    : undefined;
}

/** A Claude Code session as a sub-agent: every kind below runs one. */
abstract class ClaudeCodeRun extends SubAgent<Env> {
  protected abstract readonly kind: "write" | "revise" | "plan" | "discover";

  /**
   * This run, as an artifact write names it: see {@link ArtifactWriteContext}.
   *
   * The one place that decides which value is the owner, so no artifact write
   * can disagree with another about it. The owner is read here rather than
   * carried in the {@link PlanPlace} or {@link ReportPlace} that `prepare`
   * parked, because a parked place is runtime a replay hands back and the
   * authority for a write is established by the write. `callerKey` answers off
   * the turn and throws outside one, so this is callable only from within a
   * turn, which is where an artifact write runs.
   */
  protected artifactWriteContext(): ArtifactWriteContext {
    return { owner: this.callerKey(), runId: this.name };
  }

  override getModel(): ThinkModel {
    const runtime = this.pluginContext().runtime();
    const place = placeOf(runtime);
    // Named by the kinds that commit rather than by the ones that do not: a
    // kind added here writes nothing until somebody says it does, and what
    // `writes` turns on is a brief about a branch and the accounting after it.
    const writes =
      (this.kind === "write" || this.kind === "revise") &&
      place.branch !== undefined;
    const revisions = this.kind === "revise" ? revisionsOf(runtime) : undefined;
    const plan = this.kind === "plan" ? planPlaceOf(runtime) : undefined;
    if (this.kind === "plan" && !plan) {
      throw new Error(
        "claude-coordinator: this planning run carries no plan; its spec's prepare opens one"
      );
    }
    const report =
      this.kind === "discover" ? reportPlaceOf(runtime) : undefined;
    if (this.kind === "discover" && !report) {
      throw new Error(
        "claude-coordinator: this discovery run carries no report page; its spec's prepare opens one"
      );
    }
    const resume = carryOnOf(runtime);
    // Recorded with the session, so a run carrying it on finds the page.
    const transcript = resume?.transcript ?? this.name;
    const schema: SessionSchema = plan
      ? "plan"
      : report
        ? "discovery"
        : "write";
    return claudeCodeModel({
      // A new stub per call: a call that failed may have been its stub's last.
      sandbox: () => this.#stub(place.workspaceName) as unknown as SandboxRuns,
      storage: this.ctx.storage,
      runId: this.name,
      dir: place.dir,
      timeoutMs: CLAUDE_CODE_SESSION.timeoutMs,
      // A plan is a writing session under `plan`, answering as data: it reads,
      // changes nothing, and has nobody to approve its plan mid-run.
      schema,
      ...(plan ? { permissionMode: "plan" as const } : {}),
      // The run that holds the conversation, in this same sandbox: `carryOn`
      // hands one over only where that is so.
      ...(resume
        ? {
            resume: {
              run: resume.fromRun,
              ...(resume.fork ? { fork: true } : {})
            }
          }
        : {}),
      // The method itself, bound: a wrapper's argument list is a place to drop
      // the card, and plugins' own spec is what proves the model passes it.
      note: this.note.bind(this),
      // Every run's, so a later one can carry on from it: see `noteSession`
      // on the sandbox.
      onSession: (record) =>
        this.#noteSession(place, { sessionId: record.sessionId, transcript }),
      brief: (task) =>
        plan
          ? this.#planBrief(task, place, plan, resume)
          : report
            ? this.#discoveryBrief(task, place)
            : this.#brief(
                task,
                place,
                writes,
                writerPlanOf(runtime),
                resume !== undefined,
                revisions !== undefined
              ),
      ...(writes
        ? { followUp: (session: SessionEnd) => this.#followUp(session, place) }
        : {}),
      report: async (outcome) => {
        if (resume && notResumable(outcome)) {
          await this.#forgetSession(place, resume.fromRun);
          return unresumableReport(
            plan ? "plan" : resume.fork ? "write" : "branch"
          );
        }
        if (plan) {
          return reportPlan(
            this.env,
            plan,
            this.artifactWriteContext(),
            outcome,
            (sessionId, filed) =>
              this.#noteSession(
                place,
                { sessionId, transcript, plan: plan.id, ...filed },
                { required: filed.asked === true }
              )
          );
        }
        if (report) return this.#discoveryReport(outcome, place, report);
        return this.#report(outcome, place, writes, revisions);
      }
    });
  }

  /**
   * Record a run's session on the sandbox that holds its conversation.
   * Best-effort: a record lost is a later run starting fresh from the plan,
   * which it always could — unless `required`, for a record the run's result
   * depends on, which then fails the run rather than report without it.
   */
  async #noteSession(
    place: SessionPlace,
    note: SessionNote,
    options: { required?: boolean } = {}
  ): Promise<void> {
    try {
      await this.#stub(place.workspaceName).noteSession(this.name, note);
    } catch (err) {
      if (options.required) throw err;
      console.warn("[claude-coordinator] could not record the session", {
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
      console.warn("[claude-coordinator] could not forget a lost session", {
        runId,
        err: String(err)
      });
    }
  }

  #stub(name: string) {
    return sandboxStub(this.env, name);
  }

  /** A shell in a named sandbox, the one every tool uses. */
  #exec(name: string) {
    return sandboxShell(this.env.CLAUDE_COORDINATOR_SANDBOX, () => name);
  }

  /**
   * The session's prompt. Runs once per run, before the session starts, and a
   * throw fails the run with its message. The credential pool was reopened in
   * `prepare` — see `admitSession` in `./plugins.ts`.
   *
   * **What is true about the sandbox, folded in.** The session starts whatever
   * the sandbox's state, and it has no tool that reaches the host, so a fact
   * it is not given is one the parent never sees either. Reported, never
   * enforced: a Claude Code session can run `npm ci` itself, so the useful
   * thing is to hand it the facts. The wording is the plugin's.
   */
  async #brief(
    task: string,
    place: SessionPlace,
    writes: boolean,
    planId: string | undefined,
    resumed: boolean,
    revising: boolean
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
        continues: place.continues ?? false,
        ...(revising ? { revising } : {})
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
    resume: CarryOn | undefined
  ): Promise<string> {
    const resumed = resume !== undefined;
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
      resumed,
      ...(resume?.asked ? { asked: true } : {})
    });
  }

  /**
   * A discovery session's prompt: the task, whose first line names the skill,
   * and the repositories this checkout holds.
   *
   * The repositories are recorded as a writing session's are, and for a second
   * reason here: the same list is what the discard in {@link #discoveryReport}
   * runs over, so it has to be read before the session starts rather than after
   * it has had a chance to add one.
   *
   * A branch is what says the checkout is this session's, so it is also what
   * says the tree will be cleaned after it: see {@link #discoveryReport}.
   */
  async #discoveryBrief(task: string, place: SessionPlace): Promise<string> {
    const note = sessionAdvisory(
      await this.#stub(place.workspaceName).advisories()
    );
    const submodules = await this.#submodules(place);
    await this.#recordStarts(place, [".", ...submodules]);
    return discoveryBrief(
      task,
      note,
      place.branch !== undefined ? { submodules } : undefined
    );
  }

  /**
   * What the parent receives from a discovery run: the session's account, what
   * became of its report, and a checkout left as it was found.
   *
   * **Only a checkout that is this session's.** A scratchpad has no worktree to
   * hand out, so the place resolves to the parent's own workspace with no
   * branch, and what is uncommitted there is the parent's and may be older than
   * this run. A session with no branch keeps what it leaves, which is the rule
   * a writing session in a scratchpad works under too: see `sessionBrief` in
   * `./session.ts`.
   *
   * **The discard is not reported**, and that is the difference from a writing
   * session's. There, what is uncommitted may be the work; here the run changes
   * nothing by construction, so anything in the tree is scratch, and naming
   * deleted scratch gives the parent something it cannot act on. A delete that
   * fails is logged where {@link #discard} logs it.
   *
   * Nothing is discarded for a session stopped from outside, for the reason
   * {@link #report} gives: it did not choose what it left, and whoever stopped
   * it decides.
   */
  async #discoveryReport(
    outcome: SessionOutcome,
    place: SessionPlace,
    report: ReportPlace
  ): Promise<string> {
    if (
      place.branch !== undefined &&
      outcome.session.exitCode !== STOPPED_EXIT
    ) {
      await this.#discard(place, await this.#starts());
    }
    return reportDiscovery(
      this.env,
      report,
      this.artifactWriteContext(),
      outcome
    );
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
   * is of the checkout the session wrote, and the model calls this only once
   * the session has ended.
   *
   * Nothing is discarded for a session stopped from outside: it did not choose
   * what it left, and whoever stopped it decides. `keep` in
   * `@/workspace/subtask-workspace` commits it, and a discard here would race
   * that commit and lose the work it exists to keep.
   */
  async #report(
    outcome: SessionOutcome,
    place: SessionPlace,
    writes: boolean,
    revisions?: readonly Revision[]
  ): Promise<string> {
    if (!writes) return sessionReport(outcome);
    const last = outcome.followUp ?? outcome.session;

    const repos = await this.#starts();
    const stopped = last.exitCode === STOPPED_EXIT;
    const discarded = stopped
      ? { files: [], failed: false }
      : await this.#discard(place, repos);
    if (revisions) {
      // A worktree left on another listed branch is held from the next
      // session. Only over a clean tree: one that would not clean is held as
      // it is.
      if (!stopped && !discarded.failed)
        await this.#returnToStart(place, repos);
      return sessionReport(
        outcome,
        revisionNote(
          revisions.map(({ branch }) => branch),
          discarded.files,
          discarded.failed
        )
      );
    }
    const writing: WritingOutcome = {
      branch: place.branch as string,
      commits: await this.#commits(place, repos),
      discarded: discarded.files,
      ...(discarded.failed ? { discardFailed: true } : {})
    };
    return sessionReport(outcome, writingNote(writing));
  }

  /** Put the worktree back on its own branch: see `RETURN_TO_START`. */
  async #returnToStart(
    place: SessionPlace,
    repos: readonly RepoStart[]
  ): Promise<void> {
    try {
      const done = await this.#exec(place.workspaceName)(RETURN_TO_START, {
        cwd: place.dir,
        env: {
          REPO_PATHS: repos.map((repo) => repo.path).join("\n"),
          WORKTREE_BRANCH: place.branch as string
        }
      });
      if (!done.success) {
        console.warn(
          "[claude-coordinator] a revised worktree did not go back to its branch",
          { stderr: done.stderr.trim().slice(0, 500) }
        );
      }
    } catch (err) {
      console.warn(
        "[claude-coordinator] could not put a revised worktree back on its branch",
        { err: String(err) }
      );
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
        "[claude-coordinator] could not read the checkout's submodules",
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
        "[claude-coordinator] could not read where the session starts",
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
      console.warn("[claude-coordinator] could not read what is uncommitted", {
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
          "[claude-coordinator] the uncommitted work was not all deleted",
          {
            stderr: done.stderr.trim().slice(0, 500)
          }
        );
      }
      return { files: dirty, failed: !done.success };
    } catch (err) {
      console.warn(
        "[claude-coordinator] could not delete the uncommitted work",
        {
          err: String(err)
        }
      );
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
      console.warn(
        "[claude-coordinator] could not count the session's commits",
        {
          err: String(err)
        }
      );
      return repos.map((repo) => ({ path: repo.path }));
    }
  }
}

/**
 * A writing session, in a worktree of its own, carrying out a plan if given
 * one, and delivering a pull request.
 */
export class ClaudeCoordinatorWriterChild extends ClaudeCodeRun {
  static override spec = {
    ...CLAUDE_CODE_AGENT,
    description: WRITER_DESCRIPTION,
    inputSchema: WRITE_INPUT,
    prepare: prepareWriter,
    settle: settleWriter,
    transcriptKey: carriedTranscript
  } as SubAgentSpec<never, never>;
  protected readonly kind = "write";
}

/**
 * A writing session sent back to branches with open pull requests, carrying on
 * the conversation of the branch the work is on: see {@link prepareReviser}.
 */
export class ClaudeCoordinatorReviserChild extends ClaudeCodeRun {
  static override spec = {
    ...CLAUDE_CODE_AGENT,
    name: "claude_code_revise",
    description: REVISER_DESCRIPTION,
    inputSchema: REVISE_INPUT,
    formatInput: revisionsText,
    prepare: (ctx: SubAgentPrepareContext<ReviseInput, Env>) =>
      prepareReviser(ctx),
    settle: (ctx: SubAgentSettleContext<Env>) =>
      settleReviser(ctx, sessionWorkspaces(ctx.parent), ctx.parent.storage),
    transcriptKey: carriedTranscript
  } as SubAgentSpec<never, never>;
  protected readonly kind = "revise";
}

/**
 * A planning session: a writing session under `plan`, in a worktree of its
 * own, that answers through `--json-schema` and whose answer is filed as a plan
 * — see `./plans.ts`. The writer's spec under another name, description and
 * input, since what makes it a planner is how it is launched.
 */
export class ClaudeCoordinatorPlannerChild extends ClaudeCodeRun {
  static override spec = {
    ...CLAUDE_CODE_AGENT,
    name: "claude_code_plan",
    description: PLANNER_DESCRIPTION,
    inputSchema: PLAN_INPUT,
    prepare: preparePlanner,
    settle: settlePlanner,
    transcriptKey: carriedTranscript
  } as SubAgentSpec<never, never>;
  protected readonly kind = "plan";
}

/**
 * A discovery session: one following a skill its task names on the first line,
 * which reads, files what it finds where that skill says, changes nothing, and
 * answers with one report that is filed on a page of its own.
 *
 * The writer's spec under another name, description and input, as the planner
 * is, since what makes it a discovery run is how it is launched and what it
 * answers. Which skill it follows is not this agent's to know: see
 * `./reports.ts`.
 */
export class ClaudeCoordinatorDiscoveryChild extends ClaudeCodeRun {
  static override spec = {
    ...CLAUDE_CODE_AGENT,
    name: "claude_code_discover",
    description: DISCOVERER_DESCRIPTION,
    inputSchema: DISCOVER_INPUT,
    prepare: prepareDiscoverer,
    settle: (ctx: SubAgentSettleContext<Env>) => settleDiscoverer(ctx)
  } as SubAgentSpec<never, never>;
  protected readonly kind = "discover";
}

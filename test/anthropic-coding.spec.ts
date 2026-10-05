import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { TurnConfig, TurnContext } from "@cloudflare/think";
import type { PluginContext } from "@dynamicagents/core";
import { makeDoHelpers } from "@dynamicagents/core/testing";
import {
  credentialPool,
  type CredentialState
} from "@dynamicagents/plugins/claude-code";
import { openWorkspace, workspaceName } from "@dynamicagents/plugins/workspace";
import type { AgentToolLifecycleResult, AgentToolRunInfo } from "agents";
import type { ContextConfig } from "agents/context";
import type { AnthropicCodingWorkspace } from "@/index";
import { requireArtifactsStub } from "@dynamicagents/core/artifacts";
import {
  AnthropicCodingPlannerChild,
  AnthropicCodingWriterChild,
  claimSession,
  forgetKept,
  keepNote,
  preparePlanner,
  prepareWriter,
  reportPlan,
  settlePlanner,
  settleSession
} from "@/agents/anthropic-coding/children";
import {
  createPlan,
  ownsPlan,
  PLAN_LABEL
} from "@/agents/anthropic-coding/plans";
import {
  notResumable,
  planBrief,
  sessionBrief,
  sessionFooter,
  unresumableReport,
  warningPrompt,
  writingNote
} from "@/agents/anthropic-coding/session";
import { CLAUDE_CODE_SESSION } from "@/config";
import {
  claudeCodeConfig,
  CREDENTIALS_KEY,
  GH_TOKEN_PLACEHOLDER
} from "@/agents/anthropic-coding/claude-code";
import { admitSession } from "@/agents/anthropic-coding/plugins";
import { activeRepo } from "@/workspace/active-repo";
import { SCRATCH_REPO } from "@/workspace/scratch";
import { gitIdentity } from "@/workspace/git-identity";
import type {
  KeptWork,
  SessionPlace,
  SubtaskWorkspaces
} from "@/workspace/subtask-workspace";

/**
 * `anthropic-coding`'s wiring, pinned.
 *
 * The division of labour between this file and `@dynamicagents/plugins` is worth
 * stating, because it is what keeps both suites small. The *machine* — the
 * session as a model, the drain, the cursor, the credential pool — is
 * specified in the package, against fakes, with no container in sight. What is
 * asserted here is the **seam**: that this agent hands that machine the right
 * things, and that the paths where it cannot are the ones that fail with a
 * sentence instead of a stack trace.
 *
 * Every test below runs **without a container**, which the pool cannot start.
 * That is not a limitation here — the guards under test are exactly the ones
 * that must fire before a container is ever needed.
 */

const TASK = "add a --json flag";

interface Parent {
  getTools(): Record<string, unknown>;
  getActions(): Record<string, unknown>;
  getSubAgents(): { name: string }[];
  configureContext(): ContextConfig[];
  beforeTurn(ctx: TurnContext): Promise<TurnConfig | void>;
  workspaceBash: boolean;
  pluginContext(): PluginContext<Env>;
  formatDetachedCompletion(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): string;
  ctx: DurableObjectState;
}

const onParent = <T>(
  read: (agent: Parent) => T | Promise<T>,
  key = `anthropic-coding-spec:${crypto.randomUUID()}`
) =>
  runInDurableObject(
    (env.AnthropicCodingAgent as unknown as DurableObjectNamespace).get(
      env.AnthropicCodingAgent.idFromName(key)
    ),
    (instance) => read(instance as unknown as Parent)
  );

const { freshStub: freshWorkspace } = makeDoHelpers<AnthropicCodingWorkspace>(
  env.ANTHROPIC_CODING_WORKSPACE
);

/**
 * The tool split, which no typechecker can see: an allowlist of tool *names*
 * passed to `restrictTools`, the `activeTools` a turn runs with, and Think's own
 * `bash` switched off. Each fails quietly.
 */
describe("the parent's surface", () => {
  it("is git and its worktrees, a scratchpad, a browser, grep, and the sessions", async () => {
    const tools = await onParent((agent) =>
      Object.keys(agent.getTools()).sort()
    );
    expect(tools).toEqual([
      "ask_user",
      "browser_extract",
      "browser_links",
      "browser_markdown",
      "browser_scrape",
      "check_back",
      "claude_code",
      "claude_code_plan",
      "grep",
      "repo_clone",
      "repo_commit",
      "repo_diff",
      "repo_fetch",
      "repo_issue_view",
      "repo_open_pr",
      "repo_pr_review_status",
      "repo_pr_threads",
      "repo_pr_view",
      "repo_push",
      "repo_status",
      // The switch into a writing session's worktree, which is the parent's
      // alone: a session moving the parent's tools would move them mid-review.
      "repo_worktree",
      "repo_worktrees",
      "scratch_open",
      "search_history"
    ]);
  });

  it("can find out whether a review has landed, read it, and answer it", async () => {
    const { tools, actions } = await onParent((agent) => ({
      tools: Object.keys(agent.getTools()),
      actions: Object.keys(agent.getActions()).sort()
    }));
    expect(tools).toContain("repo_pr_review_status");
    expect(tools).toContain("repo_pr_threads");
    // Actions, so a recovered turn never posts the same reply twice.
    expect(actions).toEqual(["repo_pr_comment", "repo_pr_thread_reply"]);
  });

  it("has no shell, no writer and no editor", async () => {
    const { bash, active } = await onParent(async (agent) => {
      const think = ["read", "write", "edit", "delete", "list", "find", "grep"];
      const tools = Object.fromEntries(
        [...think, ...Object.keys(agent.getTools())].map((name) => [name, {}])
      );
      const turn = await agent.beforeTurn({ tools } as unknown as TurnContext);
      return { bash: agent.workspaceBash, active: turn?.activeTools ?? [] };
    });

    expect(bash).toBe(false);
    for (const forbidden of ["bash", "write", "edit", "delete"]) {
      expect(active).not.toContain(forbidden);
    }
  });

  it("offers the writing session first, then the planning one", async () => {
    const names = await onParent((agent) =>
      agent.getSubAgents().map((Cls) => Cls.name)
    );
    expect(names).toEqual([
      "AnthropicCodingWriterChild",
      "AnthropicCodingPlannerChild"
    ]);
  });
});

describe("the sessions", () => {
  it("run in the background, because a session outlasts a turn", () => {
    expect(AnthropicCodingWriterChild.spec.detached).toBe(true);
    expect(AnthropicCodingPlannerChild.spec.detached).toBe(true);
  });

  it.each([
    ["ANTHROPIC_CODING_WRITER_CHILD"],
    ["ANTHROPIC_CODING_PLANNER_CHILD"]
  ])("install no tools on %s: the session brings its own", async (binding) => {
    const ns = (env as unknown as Record<string, DurableObjectNamespace>)[
      binding
    ]!;
    const tools = await runInDurableObject(
      ns.get(ns.idFromName(`anthropic-coding-spec:${crypto.randomUUID()}`)),
      (instance) =>
        Object.keys((instance as unknown as { getTools(): object }).getTools())
    );
    expect(tools).toEqual([]);
  });
});

/**
 * Where a session works, resolved on the parent before anything is dispatched.
 * A refusal here reaches the parent's model as the tool's error, at the cost
 * of one RPC rather than a container.
 */
describe("preparing a session", () => {
  it.each([
    ["writing", AnthropicCodingWriterChild],
    ["planning", AnthropicCodingPlannerChild]
  ])(
    "refuses a %s session in a workspace with nothing checked out",
    async (_label, Cls) => {
      const refused = await onParent((agent) =>
        Cls.spec.prepare!({
          input: { task: TASK } as never,
          taskId: "task-1",
          runId: "detached:call_1",
          parent: agent.pluginContext() as never
        }).then(
          () => "",
          (err: unknown) => String(err)
        )
      );
      expect(refused).toMatch(/Clone a repository with `repo_clone`/);
    }
  );

  it("does not mistake a checkout with nothing to install for an empty workspace", async () => {
    const dir = "/workspace/scratch";
    const key = `anthropic-coding-spec:${crypto.randomUUID()}`;
    const name = workspaceName(key, SCRATCH_REPO);
    const workspace = env.ANTHROPIC_CODING_WORKSPACE.get(
      env.ANTHROPIC_CODING_WORKSPACE.idFromName(name)
    );

    // A scratchpad — a git repository of its own — with no lockfile: opened,
    // recorded, and skipped by the resolver.
    using ws = await openWorkspace(workspace);
    await ws.fs.mkdir(`${dir}/.git`, { recursive: true });
    await ws.fs.writeFile(`${dir}/.git/HEAD`, "ref: refs/heads/main\n");
    await workspace.noteCheckout({ dir, kind: "scratch" });
    expect((await workspace.startInstall({ dir })).state).toBe("skipped");

    const runtime = await onParent((agent) => {
      activeRepo(agent.ctx.storage).set(SCRATCH_REPO);
      return AnthropicCodingWriterChild.spec.prepare!({
        input: { task: TASK } as never,
        taskId: "task-1",
        runId: "detached:call_1",
        parent: agent.pluginContext() as never
      });
    }, key);
    expect(runtime).toEqual({ workspaceName: name, dir });
  });
});

/**
 * A plan: opened on the parent for this caller, written by a planning session,
 * put to the caller by id, and carried out by a writing session given it whole.
 * What travels between them is the id — see `@/agents/anthropic-coding/plans`.
 */
describe("a plan", () => {
  const planning = (plan?: string) =>
    ({
      input: { task: TASK, ...(plan ? { plan } : {}) },
      taskId: "task-1",
      runId: `detached:${crypto.randomUUID()}`
    }) as const;

  /** A planning session's outcome: its answer through `--json-schema`, or none. */
  const outcome = (structured?: unknown) => ({
    session: {
      exitCode: 0,
      result: {
        subtype: "success",
        isError: false,
        text: structured ? JSON.stringify(structured) : "I looked around.",
        sessionId: "s1",
        numTurns: 3,
        durationMs: 12_000,
        apiErrorStatus: null,
        costUsd: 0.2,
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        permissionDenials: 0,
        ...(structured ? { structured } : {})
      }
    }
  });

  const ANSWER = {
    title: "Add a --json flag",
    plan: "Change `cli.ts` to print JSON when `--json` is given, and test it.",
    lastReply:
      "Adds --json to the list command; assumes the output shape stays."
  };

  it("opens a new plan for this caller, once a workspace has admitted the run", async () => {
    const { pool } = placingPool(worktree());
    const { runtime, owned } = await onParent(async (agent) => {
      const runtime = await preparePlanner(
        { ...planning(), parent: agent.pluginContext() },
        pool
      );
      const plan = runtime.plan as { id: string };
      return { runtime, owned: ownsPlan(agent.ctx.storage, plan.id) };
    });

    expect(runtime).toMatchObject({ plan: { isNew: true } });
    expect(runtime).not.toHaveProperty("resume");
    expect(owned).toBe(true);
  });

  /**
   * A planning session works in a worktree of its own, as a writing one does,
   * and commits nothing — so its branch is no work for the parent to review.
   */
  it("claims a worktree of its own, and frees it without its branch", async () => {
    const place = worktree();
    const { pool, asked, calls } = placingPool(place);
    const ctx = planning();
    const runtime = await onParent(async (agent) => {
      const runtime = await preparePlanner(
        { ...ctx, parent: agent.pluginContext() },
        pool
      );
      await settlePlanner(
        {
          runId: ctx.runId,
          taskId: ctx.taskId,
          runtime,
          result: { status: "completed" } as never,
          parent: agent.pluginContext()
        },
        pool
      );
      return runtime;
    });

    expect(asked).toEqual([{ taskId: ctx.taskId, runId: ctx.runId }]);
    expect(runtime).toMatchObject({
      workspaceName: place.workspaceName,
      dir: place.dir
    });
    expect(calls).toEqual(["release, forgetting its branch"]);
  });

  it.each([
    ["settled", true, ["keep", "release, forgetting its branch"]],
    ["unsettled", false, ["keep", "release, held"]]
  ] as const)(
    "keeps a failed planning session's worktree as a writing one's when %s",
    async (_label, settled, expected) => {
      const { pool, calls } = recordingPool(undefined, { settled });
      const ctx = planning();
      await onParent((agent) =>
        settlePlanner(
          {
            runId: ctx.runId,
            taskId: ctx.taskId,
            runtime: { workspaceName: "w", dir: "/d" },
            result: { status: "error" } as never,
            parent: agent.pluginContext()
          },
          pool
        )
      );
      expect(calls).toEqual(expected);
    }
  );

  it("opens the plan it opened before when prepare runs again for the same run", async () => {
    const { pool } = placingPool(worktree());
    const ids = await onParent(async (agent) => {
      const ctx = { ...planning(), parent: agent.pluginContext() };
      const first = await preparePlanner(ctx, pool);
      const again = await preparePlanner(ctx, pool);
      return [first, again].map((r) => (r.plan as { id: string }).id);
    });

    expect(ids[1]).toBe(ids[0]);
  });

  it.each([
    ["one another caller opened", "foreign"],
    ["one that was approved", "locked"]
  ])("refuses to edit %s, before any workspace", async (_label, which) => {
    const refused = await onParent(async (agent) => {
      const id =
        which === "foreign"
          ? await requireArtifactsStub(env).createArtifact("plan")
          : await createPlan(env, agent.ctx.storage);
      if (which === "locked") {
        await requireArtifactsStub(env).lock(id, "approved");
      }
      return preparePlanner({
        ...planning(id),
        parent: agent.pluginContext()
      }).then(
        () => "",
        (err: unknown) => String(err)
      );
    });
    expect(refused).toMatch(
      which === "foreign" ? /is not a plan of yours/ : /is locked \(approved\)/
    );
  });

  it("files the session's answer as the plan, and tells the parent its id, not its text", async () => {
    const id = await requireArtifactsStub(env).createArtifact("plan");
    const recorded: string[] = [];
    const report = await reportPlan(
      env,
      { id, isNew: true },
      "run-1",
      outcome(ANSWER) as never,
      async (sessionId) => {
        recorded.push(sessionId);
      }
    );

    // The session that filed it, for an edit or a build to carry on from.
    expect(recorded).toEqual(["s1"]);

    expect(report).toContain(`\`${id}\``);
    expect(report).toContain(ANSWER.title);
    expect(report).toContain(ANSWER.lastReply);
    expect(report).not.toContain(`/a/${id}`);
    expect(report).not.toContain(ANSWER.plan);
    expect(
      (await requireArtifactsStub(env).readArtifact(id))?.entries
    ).toMatchObject([
      { label: PLAN_LABEL, text: `# ${ANSWER.title}\n\n${ANSWER.plan}` }
    ]);
  });

  it("files nothing for a session that did not answer through the schema", async () => {
    const id = await requireArtifactsStub(env).createArtifact("plan");
    const recorded: string[] = [];
    const report = await reportPlan(
      env,
      { id, isNew: true },
      "run-1",
      outcome() as never,
      async (sessionId) => {
        recorded.push(sessionId);
      }
    );
    expect(report).toMatch(/returned no plan, so nothing was filed/);
    expect(recorded).toEqual([]);
    expect((await requireArtifactsStub(env).readArtifact(id))?.entries).toEqual(
      []
    );
  });

  it("does not change a plan that was approved while its session ran", async () => {
    const artifacts = requireArtifactsStub(env);
    const id = await artifacts.createArtifact("plan");
    await artifacts.addEntry(id, { label: PLAN_LABEL, text: "the plan" });
    await artifacts.lock(id, "approved");

    const report = await reportPlan(
      env,
      { id, isNew: false },
      "run-2",
      outcome(ANSWER) as never
    );
    expect(report).toMatch(/was not changed/);
    expect((await artifacts.readArtifact(id))?.entries).toHaveLength(1);
  });

  it("marks a new plan its session never wrote as failed, and leaves a written one open", async () => {
    const artifacts = requireArtifactsStub(env);
    const settle = (id: string, isNew: boolean) =>
      onParent((agent) =>
        settlePlanner({
          runId: "run-1",
          taskId: "task-1",
          runtime: { workspaceName: "w", dir: "/d", plan: { id, isNew } },
          result: { status: "completed" } as never,
          parent: agent.pluginContext()
        })
      );

    const empty = await artifacts.createArtifact("plan");
    await settle(empty, true);
    expect(await artifacts.artifactState(empty)).toMatchObject({
      status: "failed",
      locked: true
    });

    const written = await artifacts.createArtifact("plan");
    await artifacts.addEntry(written, { label: PLAN_LABEL, text: "a plan" });
    await settle(written, true);
    expect(await artifacts.artifactState(written)).toMatchObject({
      locked: false
    });
  });

  it.each([
    ["one another caller opened", "foreign", /is not a plan of yours/],
    ["one with nothing on it yet", "empty", /has nothing on it yet/]
  ])(
    "refuses a writing session given %s, before claiming a worktree",
    async (_label, which, message) => {
      const refused = await onParent(async (agent) => {
        const id =
          which === "foreign"
            ? await requireArtifactsStub(env).createArtifact("plan")
            : await createPlan(env, agent.ctx.storage);
        return prepareWriter({
          ...planning(id),
          parent: agent.pluginContext()
        }).then(
          () => "",
          (err: unknown) => String(err)
        );
      });
      expect(refused).toMatch(message);
    }
  );

  it("is given whole to the writing session that carries it out", () => {
    const brief = sessionBrief(
      TASK,
      undefined,
      { branch: "anthropic-coding/t/c", submodules: [], continues: false },
      { text: "# The plan\n\nDo the thing.", resumed: false }
    );
    expect(brief).toContain("## The plan");
    expect(brief).toContain("Do the thing.");
  });

  /**
   * The session carrying on was last told it plans and changes nothing, and has
   * every version it wrote in context — so it is told planning is over, and
   * which version was approved.
   */
  it("is given whole to a build carrying on from it, which is told planning is over", () => {
    const brief = sessionBrief(
      TASK,
      undefined,
      { branch: "anthropic-coding/t/c", submodules: [], continues: false },
      { text: "# The plan\n\nDo the thing.", resumed: true }
    );
    expect(brief).toContain("## Carrying out your plan");
    expect(brief).toContain("no longer in plan mode");
    expect(brief).toContain("Do the thing.");
    expect(brief).toContain("## Your branch");
  });

  it("is given to a session in a scratchpad too, which has no branch", () => {
    const brief = sessionBrief(TASK, undefined, undefined, {
      text: "# The plan\n\nDo the thing.",
      resumed: false
    });
    expect(brief).toContain("Do the thing.");
    expect(brief).not.toContain("## Your branch");
  });

  it("is written in plan mode, which the planning session is told", () => {
    expect(planBrief(TASK)).toContain("plan mode");
  });

  it("is edited with its latest version and what was said about it in the brief", () => {
    const brief = planBrief(TASK, undefined, {
      plan: "# v1\n\nthe first plan",
      said: ["Comment: smaller, please"]
    });
    expect(brief).toContain("## The plan you are changing");
    expect(brief).toContain("the first plan");
    expect(brief).toContain("- Comment: smaller, please");
  });

  /** The conversation that wrote it already holds the plan and the code it read. */
  it("is revised by the conversation that wrote it with only what is new", () => {
    const brief = planBrief(TASK, undefined, {
      said: ["Comment: smaller, please"],
      resumed: true
    });
    expect(brief).toContain("## Revising your plan");
    expect(brief).toContain("- Comment: smaller, please");
    expect(brief).not.toContain("## The plan you are changing");
    expect(brief).not.toContain("## `gh` in this container");
  });
});

/**
 * An approved plan is built, and a plan is revised, by carrying on from the
 * conversation that wrote it — in the worktree that holds it, which is where
 * its transcript is. See `prepareWriter` in `@/agents/anthropic-coding/children`.
 */
describe("carrying a plan on from the session that wrote it", () => {
  const planning = (plan?: string) =>
    ({
      input: { task: TASK, ...(plan ? { plan } : {}) },
      taskId: "task-1",
      runId: `detached:${crypto.randomUUID()}`
    }) as const;

  /** A planning run placed in `place`, with a version of its plan filed. */
  async function planned(agent: Parent, place: SessionPlace) {
    const ctx = planning();
    const runtime = await preparePlanner(
      { ...ctx, parent: agent.pluginContext() },
      placingPool(place).pool
    );
    const id = (runtime.plan as { id: string }).id;
    await requireArtifactsStub(env).addEntry(id, {
      label: PLAN_LABEL,
      text: "# The plan\n\nDo it."
    });
    return { id, runId: ctx.runId };
  }

  /** A build of `id`, placed in `place`. */
  function build(agent: Parent, id: string, place: SessionPlace) {
    const placing = placingPool(place);
    return prepareWriter(
      {
        input: { task: TASK, plan: id },
        taskId: "task-1",
        runId: `detached:${crypto.randomUUID()}`,
        parent: agent.pluginContext()
      },
      placing.pool
    ).then((runtime) => ({ runtime, asked: placing.asked }));
  }

  it("builds an approved plan by forking the session that filed it, in its worktree", async () => {
    const place = worktree(3);
    const { runtime, asked, plan } = await onParent(async (agent) => {
      const plan = await planned(agent, place);
      await workspaceAt(place.workspaceName).noteSession(plan.runId, {
        sessionId: "s-plan",
        plan: plan.id
      });
      return { ...(await build(agent, plan.id, place)), plan };
    });

    expect(asked[0]).toMatchObject({ near: { repo: "acme/plan", slot: 3 } });
    expect(runtime).toMatchObject({
      plan: plan.id,
      resume: { sessionId: "s-plan", fork: true, fromRun: plan.runId }
    });
  });

  it("starts a build fresh from the plan when that worktree was not free", async () => {
    const place = worktree(3);
    const runtime = await onParent(async (agent) => {
      const plan = await planned(agent, place);
      await workspaceAt(place.workspaceName).noteSession(plan.runId, {
        sessionId: "s-plan",
        plan: plan.id
      });
      return (await build(agent, plan.id, worktree(4))).runtime;
    });

    expect(runtime).toHaveProperty("plan");
    expect(runtime).not.toHaveProperty("resume");
  });

  it("starts a build fresh when no session is recorded as having filed the plan", async () => {
    const place = worktree(3);
    const { runtime, asked } = await onParent(async (agent) => {
      const plan = await planned(agent, place);
      // Its handle, but not the plan: it ended before filing a version.
      await workspaceAt(place.workspaceName).noteSession(plan.runId, {
        sessionId: "s-plan"
      });
      return build(agent, plan.id, place);
    });

    expect(asked[0]).not.toHaveProperty("near");
    expect(runtime).not.toHaveProperty("resume");
  });

  it("revises a plan in the conversation that wrote it, without a fork", async () => {
    const place = worktree(3);
    const { runtime, asked, plan } = await onParent(async (agent) => {
      const plan = await planned(agent, place);
      await workspaceAt(place.workspaceName).noteSession(plan.runId, {
        sessionId: "s-plan",
        plan: plan.id
      });
      const placing = placingPool(place);
      const runtime = await preparePlanner(
        {
          ...planning(plan.id),
          input: { task: "smaller, please", plan: plan.id },
          parent: agent.pluginContext()
        },
        placing.pool
      );
      return { runtime, asked: placing.asked, plan };
    });

    expect(asked[0]).toMatchObject({ near: { repo: "acme/plan", slot: 3 } });
    expect(runtime).toMatchObject({
      plan: { id: plan.id, isNew: false },
      resume: { sessionId: "s-plan", fromRun: plan.runId }
    });
    expect(
      (runtime as { resume: Record<string, unknown> }).resume
    ).not.toHaveProperty("fork");
  });

  /** A later edit wins over the version it revised, wherever it ran. */
  it("builds from the session that filed the latest version", async () => {
    const first = worktree(3);
    const second = worktree(5);
    const { asked, runtime } = await onParent(async (agent) => {
      const plan = await planned(agent, first);
      await workspaceAt(first.workspaceName).noteSession(plan.runId, {
        sessionId: "s-first",
        plan: plan.id
      });
      const edit = planning(plan.id);
      await preparePlanner(
        { ...edit, parent: agent.pluginContext() },
        placingPool(second).pool
      );
      await workspaceAt(second.workspaceName).noteSession(edit.runId, {
        sessionId: "s-second",
        plan: plan.id
      });
      return build(agent, plan.id, second);
    });

    expect(asked[0]).toMatchObject({ near: { repo: "acme/plan", slot: 5 } });
    expect(runtime).toMatchObject({ resume: { sessionId: "s-second" } });
  });

  /** A recovered turn reports the handle again, without the plan it filed. */
  it("keeps the plan a session filed, and forgets a session found gone", async () => {
    const stub = workspaceAt(`anthropic-coding-spec:${crypto.randomUUID()}`);
    await stub.noteSession("run-1", { sessionId: "s1", plan: "p1" });
    await stub.noteSession("run-1", { sessionId: "s1" });
    expect(await stub.sessionOf("run-1")).toEqual({
      sessionId: "s1",
      plan: "p1"
    });
    await stub.forgetSession("run-1");
    expect(await stub.sessionOf("run-1")).toBeUndefined();
  });

  it("tells a conversation that is gone apart from a session that failed", () => {
    const ended = (errors: string[]) =>
      ({
        session: { exitCode: 1, result: { isError: true, errors } }
      }) as never;
    expect(
      notResumable(ended(["No conversation found with session ID: s1"]))
    ).toBe(true);
    expect(notResumable(ended(["API Error: 500"]))).toBe(false);
    expect(notResumable({ session: { exitCode: 143 } } as never)).toBe(false);
  });

  it("tells the parent a run that found it gone to delegate again", () => {
    expect(unresumableReport("write")).toMatch(
      /Delegate again with the same plan/
    );
    expect(unresumableReport("plan")).toMatch(/claude_code_plan again/);
  });
});

/** A worktree of a planning or writing session, in a workspace of its own. */
function worktree(slot = 3): SessionPlace {
  return {
    workspaceName: `anthropic-coding-spec:${crypto.randomUUID()}`,
    dir: "/workspace/plan",
    branch: "anthropic-coding/p",
    slot: { repo: "acme/plan", slot }
  };
}

/** A pool that places every run in `place`, and records what it was asked. */
function placingPool(place: SessionPlace) {
  const asked: unknown[] = [];
  const { pool, calls } = recordingPool();
  return {
    asked,
    calls,
    pool: {
      ...pool,
      resolve: async (ctx) => {
        asked.push(ctx);
        return place;
      }
    } satisfies SubtaskWorkspaces
  };
}

/** The workspace object a session ran in, where its handle is recorded. */
function workspaceAt(name: string) {
  return env.ANTHROPIC_CODING_WORKSPACE.get(
    env.ANTHROPIC_CODING_WORKSPACE.idFromName(name)
  );
}

/** A pool that records what a session's hooks asked of it. */
function recordingPool(
  resolve?: () => Promise<never>,
  kept: KeptWork = {
    note: "Its work up to that point is kept on `anthropic-coding/task-1/call_1`.",
    settled: true
  }
) {
  const calls: string[] = [];
  const pool = {
    resolve:
      resolve ??
      (async () => ({
        workspaceName: "w",
        dir: "/workspace/w",
        branch: "anthropic-coding/task-1/call_1"
      })),
    release: async (_ctx, options) => {
      calls.push(
        options?.hold
          ? "release, held"
          : options?.forgetBranch
            ? "release, forgetting its branch"
            : "release"
      );
    },
    keep: async () => {
      calls.push("keep");
      return kept;
    },
    releaseTask: async () => {
      calls.push("releaseTask");
    }
  } satisfies SubtaskWorkspaces;
  return { pool, calls };
}

describe("a writing session's worktree", () => {
  it("is released when preparing it fails, since no settle will come", async () => {
    const { pool, calls } = recordingPool(async () => {
      throw new Error("could not clone");
    });
    await expect(
      claimSession(pool, {
        input: { task: TASK },
        taskId: "task-1",
        runId: "detached:call_1"
      })
    ).rejects.toThrow("could not clone");
    expect(calls).toEqual(["release"]);
  });

  it("hands the session its workspace, checkout and branch", async () => {
    const { pool } = recordingPool();
    const runtime = await claimSession(pool, {
      input: { task: TASK },
      taskId: "task-1",
      runId: "detached:call_1"
    });
    expect(runtime).toEqual({
      workspaceName: "w",
      dir: "/workspace/w",
      branch: "anthropic-coding/task-1/call_1"
    });
  });

  it("asks for the branch the caller named", async () => {
    const { pool } = recordingPool();
    const asked: unknown[] = [];
    await claimSession(
      {
        ...pool,
        resolve: async (ctx) => {
          asked.push(ctx);
          return pool.resolve();
        }
      },
      {
        input: { task: TASK, branch: "docs/readme" },
        taskId: "task-1",
        runId: "detached:call_1"
      }
    );
    expect(asked).toEqual([
      { taskId: "task-1", runId: "detached:call_1", branch: "docs/readme" }
    ]);
  });

  it("reads an empty `branch` or `continue` as none", async () => {
    const { pool } = recordingPool();
    const asked: unknown[] = [];
    await claimSession(
      {
        ...pool,
        resolve: async (ctx) => {
          asked.push(ctx);
          return pool.resolve();
        }
      },
      {
        input: { task: TASK, branch: "", continue: "" },
        taskId: "task-1",
        runId: "detached:call_1"
      }
    );
    expect(asked).toEqual([{ taskId: "task-1", runId: "detached:call_1" }]);
  });

  it.each([
    ["completed", ["release"]],
    ["aborted", ["keep", "release"]],
    ["error", ["keep", "release"]],
    ["interrupted", ["keep", "release"]]
  ] as const)("on a run that %s: %j", async (status, expected) => {
    const { pool, calls } = recordingPool();
    await onParent((agent) =>
      settleSession(pool, agent.ctx.storage, {
        taskId: "task-1",
        runId: "detached:call_1",
        result: { status } as AgentToolLifecycleResult
      })
    );
    expect(calls).toEqual(expected);
  });

  it("holds the worktree of a run whose work could not be secured", async () => {
    const { pool, calls } = recordingPool(undefined, { settled: false });
    await onParent((agent) =>
      settleSession(pool, agent.ctx.storage, {
        taskId: "task-1",
        runId: "detached:call_1",
        result: { status: "aborted" } as AgentToolLifecycleResult
      })
    );
    expect(calls).toEqual(["keep", "release, held"]);
  });

  it("tells the parent where a failed run's work was kept, once, in its follow-up", async () => {
    const text = await onParent((agent) => {
      keepNote(agent.ctx.storage, "task-1", "detached:call_1", "kept on b");
      const run = {
        runId: "detached:call_1",
        agentType: "AnthropicCodingWriterChild",
        displayOrder: 1
      } as unknown as AgentToolRunInfo;
      const failed = { status: "error", error: "boom" } as const;
      const before = agent.formatDetachedCompletion(run, failed);
      forgetKept(agent.ctx.storage, "task-1");
      return { before, after: agent.formatDetachedCompletion(run, failed) };
    });
    expect(text.before).toContain("kept on b");
    expect(text.after).not.toContain("kept on b");
  });
});

/** The pre-flight: see `admitSession` in `@/agents/anthropic-coding/plugins`. */
describe("the credential pool", () => {
  it("reports a fresh pool as usable", async () => {
    const workspace = freshWorkspace("fresh-pool");
    const lead = await workspace.claudeCredentials();

    expect(lead.ok).toBe(true);
    if (lead.ok) {
      // The first entry, because order is priority — and the *test* credential,
      // which is the other half of the invariant: nothing real is in this suite.
      expect(lead.index).toBe(0);
      expect(lead.token).toBe("sk-ant-oat01-test-1");
    }
  });

  it("admits a session into a workspace whose pool is fresh", async () => {
    await expect(
      admitSession(env, `admit-fresh:${crypto.randomUUID()}`)
    ).resolves.toBeUndefined();
  });

  it("refuses a session once every credential is spent, saying when one resets", async () => {
    const name = `admit-spent:${crypto.randomUUID()}`;
    const resetAt = Date.now() + 60 * 60_000;
    const binding = env.ANTHROPIC_CODING_WORKSPACE;
    await runInDurableObject(
      binding.get(binding.idFromName(name)),
      async (_, state) => {
        const pool = credentialPool({
          credentials: claudeCodeConfig(env).credentials,
          store: {
            read: async () =>
              (await state.storage.get<CredentialState[]>(CREDENTIALS_KEY)) ??
              [],
            write: (states) => state.storage.put(CREDENTIALS_KEY, states)
          }
        });
        let lead = await pool.lead();
        while (lead.ok) lead = await pool.spend(lead.id, resetAt);
      }
    );

    await expect(admitSession(env, name)).rejects.toThrow(
      new Date(resetAt).toISOString()
    );
  });
});

/**
 * What reaches the session, and in what order.
 *
 * A Claude Code session cannot query the host — it has no tool that reaches it —
 * so anything the brief omits is not merely inconvenient, it is unreachable.
 * The workspace note is the case that matters: a session working against a
 * broken install or a workspace that has stopped accepting writes needs to know
 * before it starts, and its own report is the only channel back to the parent.
 */
describe("the brief a session starts from", () => {
  it("carries what the container holds, when there is nothing else to add", () => {
    const brief = sessionBrief(TASK);

    expect(brief.startsWith(TASK)).toBe(true);
    // Unconditional, because it is true of every session: a model reaches for
    // `gh` unprompted, this one is authenticated as nobody, and neither "it is
    // missing" nor "it is signed in" is what it will assume.
    expect(brief).toContain("`gh` in this container");
    expect(brief).toContain("authenticated as nobody");
    // …and who does hold the credential, or the session tries to route around
    // the boundary rather than reporting back through it.
    expect(brief).toContain("belong to the agent");
  });

  /**
   * Order is not cosmetic. The task comes first; everything after it is context
   * for the task, and a note that preceded the instruction would read as part
   * of it.
   */
  it("carries the workspace note after the task", () => {
    const brief = sessionBrief(TASK, "the install failed: ERESOLVE");
    expect(brief.indexOf(TASK)).toBe(0);
    expect(brief).toContain("## The state of this workspace");
    expect(brief).toContain("the install failed: ERESOLVE");
  });
});

describe("the branch a writing session is told about", () => {
  it("names the submodules, and says to commit inside each one", () => {
    const brief = sessionBrief(TASK, undefined, {
      branch: "anthropic-coding/task-1/1",
      submodules: ["core", "starter"],
      continues: false
    });

    expect(brief).toContain("You are on `anthropic-coding/task-1/1`");
    expect(brief).toContain("- `core`\n- `starter`");
    expect(brief).toMatch(/Commit inside each one you\nchange/);
    // The install is the root's alone, and a session that does not know that
    // runs a submodule's suite against no dependencies.
    expect(brief).toMatch(/Run `npm ci` in a\nsubmodule/);
  });

  /** Only commits leave a session, and it has to hear that before it starts. */
  it("says uncommitted work is deleted, and that the parent pushes", () => {
    const brief = sessionBrief(TASK, undefined, {
      branch: "anthropic-coding/task-1/1",
      submodules: [],
      continues: false
    });

    expect(brief).toContain("## Your branch");
    expect(brief).toMatch(
      /anything left\nuncommitted is deleted when you finish/
    );
    expect(brief).toMatch(/Do not push/);
    expect(brief).not.toContain("Submodules");
    expect(brief).not.toContain("earlier work");
  });

  /** Each full run is minutes of the person's wait, and a baseline it was given is one. */
  it("says to check once, against the base the brief already gives", () => {
    const brief = sessionBrief(TASK, undefined, {
      branch: "anthropic-coding/task-1/1",
      submodules: [],
      continues: false
    });

    expect(brief).toContain("## Checking your work");
    expect(brief).toMatch(
      /on the tree you commit, and again only after changing\nsomething they cover/
    );
    expect(brief).toMatch(/instead of running the base\nagain/);
    expect(sessionBrief(TASK)).not.toContain("## Checking your work");
  });

  it("tells a continuing session the branch already holds work", () => {
    const brief = sessionBrief(TASK, undefined, {
      branch: "anthropic-coding/task-1/1",
      submodules: [],
      continues: true
    });

    expect(brief).toMatch(/already holds earlier work:/);
  });

  /** A scratchpad keeps what a session leaves in the tree, on no branch. */
  it("says nothing about a branch to a session in a scratchpad", () => {
    expect(sessionBrief(TASK)).not.toContain("## Your branch");
  });
});

/** The one turn a session gets when it left work uncommitted. */
describe("the warning round", () => {
  it("lists what would be deleted, per repository, and asks once", () => {
    const prompt = warningPrompt([
      { path: ".", files: ["notes.md"] },
      { path: "core", files: ["lib/a.js", "lib/b.js"] }
    ]);

    expect(prompt).toContain("they will be deleted when this session ends");
    expect(prompt).toContain("- the superproject: `notes.md`");
    expect(prompt).toContain("- `core`: `lib/a.js`, `lib/b.js`");
    expect(prompt).toMatch(/Commit what should be kept/);
  });

  it("calls a lone checkout the repository, and names every file", () => {
    const files = Array.from({ length: 15 }, (_, i) => `f${i}`);
    const prompt = warningPrompt([{ path: ".", files }]);

    expect(prompt).toContain("- the repository: `f0`");
    expect(prompt).toContain("`f14`");
    expect(prompt).not.toContain("more");
  });
});

/**
 * What the parent is told about the branch, which it cannot see for itself —
 * the discard runs after the session exits.
 */
describe("the note on what a writing session kept", () => {
  const branch = "anthropic-coding/task-1/1";

  it("names each repository with commits, and how to reach the worktree", () => {
    const note = writingNote({
      branch,
      commits: [
        { path: ".", count: 0 },
        { path: "starter", count: 2 },
        { path: "core", count: 1 }
      ],
      discarded: []
    });

    expect(note).toContain(
      `**Committed on \`${branch}\`** in \`starter\` (2 commits), \`core\` (1 commit).`
    );
    expect(note).toContain("Nothing is pushed.");
    expect(note).toContain("`repo_worktree`");
    expect(note).toContain("`continue`");
    // Nothing is said about a repository the session did not change.
    expect(note).not.toContain("superproject");
  });

  it("says there is nothing to review when nothing was committed", () => {
    const note = writingNote({
      branch,
      commits: [{ path: ".", count: 0 }],
      discarded: []
    });

    expect(note).toMatch(
      /No commits were made on `anthropic-coding\/task-1\/1`/
    );
  });

  it("names what was deleted uncommitted", () => {
    const note = writingNote({
      branch,
      commits: [{ path: ".", count: 1 }],
      discarded: [{ path: ".", files: ["scratch.txt"] }]
    });

    expect(note).toContain("the repository (1 commit)");
    expect(note).toContain(
      "**Deleted, uncommitted:** the repository: `scratch.txt`."
    );
  });

  /**
   * The loop that deletes it reports a failure — a masked one would leave these
   * files on disk under a line saying they are gone.
   */
  it("says so when the delete failed, rather than claiming it worked", () => {
    const note = writingNote({
      branch,
      commits: [{ path: ".", count: 1 }],
      discarded: [{ path: ".", files: ["scratch.txt"] }],
      discardFailed: true
    });

    expect(note).toContain(
      "**Still uncommitted — deleting it failed**, so these are in the " +
        "worktree: the repository: `scratch.txt`."
    );
    expect(note).not.toContain("**Deleted, uncommitted:**");
  });

  /** Uncounted is not the same as none, so it is not reported as none. */
  it("reports a repository whose commits could not be counted", () => {
    const note = writingNote({
      branch,
      commits: [{ path: "." }],
      discarded: []
    });

    expect(note).toContain("the repository (uncounted)");
  });
});

describe("the footer under a session's report", () => {
  const spent = {
    numTurns: 12,
    durationMs: 95_000,
    costUsd: 1.2345,
    usage: { cacheRead: 187_130 },
    permissionDenials: 0
  };

  it("accounts for what the session spent", () => {
    expect(sessionFooter(spent)).toBe(
      "turns: 12 · duration: 95s · cost: $1.2345 · cache reads: 187130"
    );
  });

  /**
   * The signal that was parsed and read by nobody while every session in the
   * deployment was being refused every write. A denied tool call never appears
   * in the session's own account of itself — the model narrates an alternative
   * approach and carries on — so this line is where it becomes visible.
   */
  it("says so when tool calls were refused", () => {
    expect(sessionFooter({ ...spent, permissionDenials: 3 })).toContain(
      "denials: 3"
    );
  });

  /**
   * Absent rather than `denials: 0`. A number that is always there is a number
   * nobody reads, and the whole value of this field is that its presence is
   * itself the alarm.
   */
  it("stays quiet on a run where nothing was refused", () => {
    expect(sessionFooter(spent)).not.toContain("denials");
  });
});

/**
 * The mode the session runs under, pinned.
 *
 * `claude -p` is headless: nothing can answer a permission prompt, so a mode
 * that would ask **auto-denies** instead. On the CLI's default a session reads
 * the checkout perfectly, cannot write to it, exits 0, and is recorded as
 * completed — which is how this went unnoticed for a release. The assertion is
 * cheap and the failure it guards against is not.
 */
describe("the permission mode this deployment runs sessions under", () => {
  it("bypasses, because every other mode cannot edit the checkout", () => {
    expect(CLAUDE_CODE_SESSION.permissionMode).toBe("bypassPermissions");
  });
});

/**
 * Pinned for the same reason as the mode above, against the same kind of
 * silence: a wrong value in either of these fails nothing and reports nothing,
 * so only an assertion catches it. `CLAUDE_CODE_SESSION` in `src/config.ts`
 * carries why each is what it is.
 */
describe("how hard this deployment asks a session to think", () => {
  it("buys depth, because a half-finished checkout costs more than a turn", () => {
    expect(CLAUDE_CODE_SESSION.effort).toBe("xhigh");
  });

  it("sets no turn ceiling, which would be inert rather than a limit", () => {
    expect(CLAUDE_CODE_SESSION).not.toHaveProperty("maxTurns");
  });
});

/**
 * What this agent hands the pool — not what the pool does with it.
 *
 * The rotation itself is specified in `@dynamicagents/plugins` against fakes.
 * What only this side can get wrong is the array: the order, which is priority
 * because the egress gateway spends entry 0 first, and the empty entry an unset
 * secret produces, which would otherwise be sent as a bare `Bearer `.
 */
describe("anthropic-coding's credential pool", () => {
  it("hands over every configured credential, in declared order", () => {
    const config = claudeCodeConfig(env as never);

    // A misspelled binding reads as `undefined` and is filtered out, so a
    // missing entry fails here rather than at the first 429.
    expect(config.credentials()).toEqual([
      env.CLAUDE_CODE_OAUTH_TOKEN_1,
      env.CLAUDE_CODE_OAUTH_TOKEN_2,
      env.CLAUDE_CODE_OAUTH_TOKEN_3
    ]);
  });

  it("drops an unset entry instead of offering an empty credential", () => {
    const config = claudeCodeConfig({
      CLAUDE_CODE_OAUTH_TOKEN_1: "sk-ant-oat01-one",
      CLAUDE_CODE_OAUTH_TOKEN_2: "",
      CLAUDE_CODE_OAUTH_TOKEN_3: "sk-ant-oat01-three"
    } as never);

    expect(config.credentials()).toEqual([
      "sk-ant-oat01-one",
      "sk-ant-oat01-three"
    ]);
  });
});

/**
 * Who a session's commits belong to.
 *
 * Why the session needs an identity of its own is beside the option, in
 * `@/agents/anthropic-coding/claude-code.ts`. What only this side can get wrong is
 * answering it with a *different* identity from the workspace object's, which
 * is the disagreement `@/workspace/git-identity` exists to prevent — so this
 * pins that they are one answer, not any particular name.
 */
describe("who a session commits as", () => {
  it("hands the session the deployment's git identity", () => {
    const config = claudeCodeConfig(env as never);

    expect(config.author).toEqual(gitIdentity(env as never));
  });
});

/**
 * Where `gh`'s placeholder token lives, which is the whole of its safety.
 *
 * It is only harmless behind the sessions' egress gateway, which strips it. In
 * the image it would also reach `coding`'s container, whose egress is `direct`,
 * and be presented to GitHub as a credential by anything that reads `GH_TOKEN`.
 */
describe("gh's placeholder token", () => {
  it("rides in the session env, which only the gateway-fronted sessions get", () => {
    const config = claudeCodeConfig(env as never);

    expect(config.env?.GH_TOKEN).toBe(GH_TOKEN_PLACEHOLDER);
  });

  it("tells the session which gh commands can work at all", () => {
    const brief = sessionBrief("look at the issue");

    // GitHub gives anonymous callers a GraphQL quota of zero, so the high-level
    // commands a model reaches for first are the ones that cannot work.
    expect(brief).toContain("gh api repos/");
    expect(brief).toContain("GraphQL");
  });
});

import { afterEach, describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { TurnConfig, TurnContext } from "@cloudflare/think";
import type { PluginContext } from "@dynamicagents/core";
import { makeDoHelpers } from "@dynamicagents/core/testing";
import {
  credentialPool,
  type CredentialState
} from "@dynamicagents/plugins/claude-code";
import { GITHUB_TOKEN_PLACEHOLDER } from "@dynamicagents/plugins/repo-github";
import {
  egressPlan,
  sandboxEgress,
  sandboxName,
  SANDBOX_RUNTIME_KEY
} from "@dynamicagents/plugins/sandbox";
import type { AgentToolLifecycleResult, AgentToolRunInfo } from "agents";
import type { ContextConfig } from "agents/context";
import type { ClaudeCoordinatorSandbox } from "@/index";
import { requireArtifactsStub } from "@dynamicagents/core/artifacts";
import {
  ClaudeCoordinatorPlannerChild,
  ClaudeCoordinatorReviserChild,
  ClaudeCoordinatorWriterChild,
  carriedTranscript,
  claimSession,
  forgetKept,
  keepNote,
  keptNote,
  preparePlanner,
  prepareReviser,
  prepareWriter,
  reportPlan,
  settlePlanner,
  settleReviser,
  settleSession
} from "@/agents/claude-coordinator/children";
import {
  branchSession,
  recordBranchRun
} from "@/agents/claude-coordinator/branches";
import {
  createPlan,
  ownsPlan,
  PLAN_LABEL,
  PLAN_OUTPUT,
  revisionsText,
  type ReviseInput
} from "@/agents/claude-coordinator/plans";
import { SOUL } from "@/agents/claude-coordinator/soul";
import {
  notResumable,
  planBrief,
  revisionNote,
  sessionBrief,
  sessionFooter,
  sessionReport,
  unresumableReport,
  warningPrompt,
  WRITE_OUTPUT,
  writingNote
} from "@/agents/claude-coordinator/session";
import { CLAUDE_CODE_SESSION } from "@/config";
import {
  claudeCredentials,
  CREDENTIALS_KEY
} from "@/agents/claude-coordinator/claude-code";
import { CLAUDE_COORDINATOR_EGRESS } from "@/agents/claude-coordinator/egress";
import { admitSession } from "@/agents/claude-coordinator/plugins";
import { activeRepo } from "@/workspace/active-repo";
import {
  sweepIdleWorkspaces,
  type SweptNamespace
} from "@/workspace/lifecycle";
import { SCRATCH_REPO } from "@/workspace/scratch";
import { sqlPoolStore, worktreeRepo } from "@/workspace/worktree-pool";
import { gitIdentity } from "@/workspace/git-identity";
import { sandboxEnv } from "@/workspace/container";
import {
  gitmodulesOf,
  submoduleRepos,
  type KeptWork,
  type SessionPlace,
  type SubtaskWorkspaces
} from "@/workspace/subtask-workspace";

/**
 * `claude-coordinator`'s wiring, pinned.
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
  key = `claude-coordinator-spec:${crypto.randomUUID()}`
) =>
  runInDurableObject(
    (env.ClaudeCoordinatorAgent as unknown as DurableObjectNamespace).get(
      env.ClaudeCoordinatorAgent.idFromName(key)
    ),
    (instance) => read(instance as unknown as Parent)
  );

const { freshStub: freshWorkspace } = makeDoHelpers<ClaudeCoordinatorSandbox>(
  env.CLAUDE_COORDINATOR_SANDBOX
);

/**
 * The tool split, which no typechecker can see: an allowlist of tool *names*
 * passed to `restrictTools`, the `activeTools` a turn runs with, and Think's own
 * `bash` switched off. Each fails quietly.
 */
describe("the parent's surface", () => {
  it("is a checkout to open, pull requests to watch, worktrees to read, a scratchpad, a browser, grep, and the sessions", async () => {
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
      "claude_code_revise",
      "grep",
      "repo_clone",
      "repo_issue_view",
      "repo_pr_checks",
      "repo_pr_threads",
      "repo_pr_view",
      "repo_worktree",
      "repo_worktrees",
      "scratch_open",
      "search_history"
    ]);
  });

  /**
   * Where its reads run moves between turns — a session settling takes them
   * into its worktree — so it is said every turn rather than remembered from a
   * `repo_worktree` answer. Moved through a selection of its own, which is the
   * one the agent's tools read.
   */
  it("says where its reads run, again whenever that moves", async () => {
    const { remind, before, after } = await onParent(async (agent) => {
      const reads = agent
        .configureContext()
        .find((block) => block.label.endsWith(".reads"));
      const read = async () =>
        String(await (reads?.provider as { get(): Promise<unknown> }).get());
      const active = activeRepo(agent.ctx.storage);
      active.set("acme/api");
      const before = await read();
      sqlPoolStore(agent.ctx.storage).put({
        repo: "acme/api",
        slot: 0,
        branch: "claude-coordinator/t/1",
        dir: "/workspace/api",
        repos: [],
        usedAt: 1
      });
      active.set(worktreeRepo("acme/api", 0));
      return { remind: reads?.whenChanged, before, after: await read() };
    });
    expect(remind).toBe("remind");
    expect(before).toMatch(/your own checkout of acme\/api/);
    expect(after).toMatch(/worktree holding `claude-coordinator\/t\/1`/);
  });

  /**
   * The sweep is a sandbox's only reclaim, and it walks `seen()`: a repository
   * whose sandbox it reclaimed, cloned again while still selected, has to be
   * walked again.
   */
  it("enrols a repository for the sweep again when it is cloned after a reclaim", async () => {
    const { swept, again } = await onParent(async (agent) => {
      const active = activeRepo(agent.ctx.storage);
      active.set("acme/api");
      const reclaimed = {
        getByName: () => ({
          reclaimIfIdle: async () => ({ reclaimed: true, idleMs: 0 })
        })
      } as unknown as SweptNamespace;
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      await sweepIdleWorkspaces({
        storage: agent.ctx.storage,
        callerKey: "spec",
        binding: reclaimed,
        label: "spec"
      });
      info.mockRestore();
      const swept = active.seen();
      active.set("acme/api");
      return { swept, again: active.seen() };
    });
    expect(swept).not.toContain("acme/api");
    expect(again).toContain("acme/api");
  });

  it("keeps its reads in a worktree when a task settles", async () => {
    const selected = await onParent(async (agent) => {
      activeRepo(agent.ctx.storage).set(worktreeRepo("acme/api", 0));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await (
        agent as unknown as { onTaskSettled(id: string): Promise<void> }
      ).onTaskSettled("task-1");
      warn.mockRestore();
      return activeRepo(agent.ctx.storage).get();
    });
    expect(selected).toBe(worktreeRepo("acme/api", 0));
  });

  /**
   * A pull request's commits, replies and resolutions are its session's: one
   * written here would be the smaller model answering a review it cannot judge.
   */
  it("watches a pull request's review and checks, and answers neither itself", async () => {
    const { tools, actions } = await onParent((agent) => ({
      tools: Object.keys(agent.getTools()),
      actions: Object.keys(agent.getActions())
    }));
    expect(tools).toContain("repo_pr_view");
    expect(tools).toContain("repo_pr_threads");
    expect(tools).toContain("repo_pr_checks");
    for (const writer of ["repo_commit", "repo_push", "repo_open_pr"]) {
      expect(tools).not.toContain(writer);
    }
    expect(actions).toEqual([]);
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

  it("reasons at max, in the shape the OpenAI provider reads", async () => {
    const options = await onParent(async (agent) => {
      const tools = Object.fromEntries(
        Object.keys(agent.getTools()).map((name) => [name, {}])
      );
      const turn = await agent.beforeTurn({ tools } as unknown as TurnContext);
      return turn?.providerOptions;
    });

    expect(options).toEqual({ openai: { reasoningEffort: "max" } });
  });

  it("offers building, then revising, then planning", async () => {
    const names = await onParent((agent) =>
      agent.getSubAgents().map((Cls) => Cls.name)
    );
    expect(names).toEqual([
      "ClaudeCoordinatorWriterChild",
      "ClaudeCoordinatorReviserChild",
      "ClaudeCoordinatorPlannerChild"
    ]);
  });
});

describe("the sessions", () => {
  it("run in the background, because a session outlasts a turn", () => {
    expect(ClaudeCoordinatorWriterChild.spec.detached).toBe(true);
    expect(ClaudeCoordinatorReviserChild.spec.detached).toBe(true);
    expect(ClaudeCoordinatorPlannerChild.spec.detached).toBe(true);
  });

  it.each([
    ["CLAUDE_COORDINATOR_WRITER_CHILD"],
    ["CLAUDE_COORDINATOR_REVISER_CHILD"],
    ["CLAUDE_COORDINATOR_PLANNER_CHILD"]
  ])("install no tools on %s: the session brings its own", async (binding) => {
    const ns = (env as unknown as Record<string, DurableObjectNamespace>)[
      binding
    ]!;
    const tools = await runInDurableObject(
      ns.get(ns.idFromName(`claude-coordinator-spec:${crypto.randomUUID()}`)),
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
    ["writing", ClaudeCoordinatorWriterChild],
    ["planning", ClaudeCoordinatorPlannerChild]
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

  it("places a session in a scratchpad, a checkout with nothing to install", async () => {
    const dir = "/workspace/scratch";
    const key = `claude-coordinator-spec:${crypto.randomUUID()}`;
    const name = sandboxName(key, SCRATCH_REPO);
    // Recorded as `scratch_open` records one, on a sandbox whose container is
    // stopped: a stopped sandbox answers from its record.
    await env.CLAUDE_COORDINATOR_SANDBOX.getByName(name).noteCheckout({
      dir,
      kind: "scratch"
    });

    const runtime = await onParent((agent) => {
      activeRepo(agent.ctx.storage).set(SCRATCH_REPO);
      return ClaudeCoordinatorWriterChild.spec.prepare!({
        input: { task: TASK } as never,
        taskId: "task-1",
        runId: "detached:call_1",
        parent: agent.pluginContext() as never
      });
    }, key);
    expect(runtime).toEqual({ [SANDBOX_RUNTIME_KEY]: name, dir });
  });
});

/**
 * A plan: opened on the parent for this caller, written by a planning session,
 * put to the caller by id, and carried out by a writing session given it whole.
 * What travels between them is the id — see `@/agents/claude-coordinator/plans`.
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
      [SANDBOX_RUNTIME_KEY]: place.workspaceName,
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
            runtime: { [SANDBOX_RUNTIME_KEY]: "w", dir: "/d" },
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
    const recorded: [string, number][] = [];
    const report = await reportPlan(
      env,
      { id, isNew: true },
      "run-1",
      outcome(ANSWER) as never,
      async (sessionId, version) => {
        recorded.push([sessionId, version]);
      }
    );

    // The session that filed it, and which version, for an edit or a build to
    // carry on from.
    expect(recorded).toEqual([["s1", 1]]);

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
          runtime: {
            [SANDBOX_RUNTIME_KEY]: "w",
            dir: "/d",
            plan: { id, isNew }
          },
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
      { branch: "claude-coordinator/t/c", submodules: [], continues: false },
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
      { branch: "claude-coordinator/t/c", submodules: [], continues: false },
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

  /**
   * The plan is what the person decides from, so a session that worked out one
   * way in and wrote it down has left them nothing to decide. Pinned because
   * the stance is prose a later edit would read as filler.
   */
  it("asks the planning session to weigh the ways in, and to say when a better one exists", () => {
    const brief = planBrief(TASK);
    expect(brief).toContain("## Planning it");
    expect(brief).toMatch(
      /weigh it in the plan rather than presenting the one/
    );
    expect(brief).toMatch(
      /Where the request names an approach and a different one would serve it better/
    );
    expect(brief).toMatch(/goes to them as a question/);
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
    // The stance it was told on the way in is still in its context; what a
    // comment puts in question is whether to comply with it.
    expect(brief).not.toContain("## Planning it");
  });

  /**
   * A comment is the person's, and it can still be worse than the plan it
   * changes. Complying silently loses the one reader who could choose.
   */
  it("is revised to the person's comment, and says so where the comment makes it worse", () => {
    const brief = planBrief(TASK, undefined, {
      said: ["Comment: drop the second table"],
      resumed: true
    });
    expect(brief).toMatch(
      /Where what they asked for would make the plan worse/
    );
    expect(brief).toMatch(/they read both and choose/);
  });

  /**
   * Both halves are pinned, because they pull against each other: a plan that
   * weighs nothing leaves the person nothing to decide, and one that always
   * carries an alternatives section pads what they read with "none".
   */
  it("asks for the alternatives that existed, and for nothing where none did", () => {
    const { plan, lastReply } = PLAN_OUTPUT.properties;
    expect(plan.description).toMatch(/what you weighed and what decided it/);
    expect(plan.description).toMatch(
      /only one sensible way, write nothing about alternatives/
    );
    // The planner has no `needs_input`: `lastReply` is the whole channel.
    expect(lastReply.description).toMatch(
      /a shape you would recommend over the one the request named/
    );
    expect(lastReply.description).toMatch(/cannot stop to ask mid-run/);
  });
});

/**
 * An approved plan is built, and a plan is revised, by carrying on from the
 * conversation that wrote it — in the worktree that holds it, which is where
 * its transcript is. See `prepareWriter` in `@/agents/claude-coordinator/children`.
 */
describe("carrying a plan on from the session that wrote it", () => {
  const planning = (plan?: string) =>
    ({
      input: { task: TASK, ...(plan ? { plan } : {}) },
      taskId: "task-1",
      runId: `detached:${crypto.randomUUID()}`
    }) as const;

  /** A version of plan `id` filed on its page; its sequence there. */
  async function file(id: string, text = "# The plan\n\nDo it.") {
    const filed = await requireArtifactsStub(env).addEntry(id, {
      label: PLAN_LABEL,
      text
    });
    return filed!.sequence;
  }

  /** A planning run placed in `place`, with a version of its plan filed. */
  async function planned(agent: Parent, place: SessionPlace) {
    const ctx = planning();
    const runtime = await preparePlanner(
      { ...ctx, parent: agent.pluginContext() },
      placingPool(place).pool
    );
    const id = (runtime.plan as { id: string }).id;
    return { id, runId: ctx.runId, version: await file(id) };
  }

  /** What a planning session's report records on the workspace that ran it. */
  function filedBy(
    place: SessionPlace,
    runId: string,
    sessionId: string,
    plan: { id: string; version: number }
  ) {
    return sandboxAt(place.workspaceName).noteSession(runId, {
      sessionId,
      plan: plan.id,
      version: plan.version
    });
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
      await filedBy(place, plan.runId, "s-plan", plan);
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
      await filedBy(place, plan.runId, "s-plan", plan);
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
      await sandboxAt(place.workspaceName).noteSession(plan.runId, {
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
      await filedBy(place, plan.runId, "s-plan", plan);
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

  /**
   * One session, one page: an edit carries on the planner's conversation, so it
   * files on the planner's transcript, and the thread gets no second link. A
   * build forks the conversation into a session of its own, with its own page.
   */
  it("files an edit on the plan's page, and a build on a page of its own", async () => {
    const place = worktree(3);
    const {
      edit,
      build: built,
      plan
    } = await onParent(async (agent) => {
      const plan = await planned(agent, place);
      await filedBy(place, plan.runId, "s-plan", plan);
      const edit = await preparePlanner(
        {
          ...planning(plan.id),
          input: { task: "smaller, please", plan: plan.id },
          parent: agent.pluginContext()
        },
        placingPool(place).pool
      );
      return {
        edit,
        build: (await build(agent, plan.id, place)).runtime,
        plan
      };
    });

    expect(carriedTranscript({ runtime: edit })).toBe(plan.runId);
    expect(carriedTranscript({ runtime: built })).toBeUndefined();
  });

  /** An edit of an edit is still the planner's session, so still its page. */
  it("keeps an edited plan on its first page, however many edits on", async () => {
    const place = worktree(3);
    const { runtime, plan } = await onParent(async (agent) => {
      const plan = await planned(agent, place);
      await filedBy(place, plan.runId, "s-plan", plan);
      // The first edit carried the planner's page, and recorded it with its
      // own session.
      const edit = planning(plan.id);
      await preparePlanner(
        { ...edit, parent: agent.pluginContext() },
        placingPool(place).pool
      );
      const version = await file(plan.id, "# The plan\n\nDo less.");
      await sandboxAt(place.workspaceName).noteSession(edit.runId, {
        sessionId: "s-plan",
        transcript: plan.runId,
        plan: plan.id,
        version
      });
      const runtime = await preparePlanner(
        { ...planning(plan.id), parent: agent.pluginContext() },
        placingPool(place).pool
      );
      return { runtime, plan };
    });

    expect(carriedTranscript({ runtime })).toBe(plan.runId);
  });

  /** A later edit wins over the version it revised, wherever it ran. */
  it("builds from the session that filed the latest version", async () => {
    const first = worktree(3);
    const second = worktree(5);
    const { asked, runtime } = await onParent(async (agent) => {
      const plan = await planned(agent, first);
      await filedBy(first, plan.runId, "s-first", plan);
      const edit = planning(plan.id);
      await preparePlanner(
        { ...edit, parent: agent.pluginContext() },
        placingPool(second).pool
      );
      const version = await file(plan.id, "# The plan\n\nDo less.");
      await filedBy(second, edit.runId, "s-second", { id: plan.id, version });
      return build(agent, plan.id, second);
    });

    expect(asked[0]).toMatchObject({ near: { repo: "acme/plan", slot: 5 } });
    expect(runtime).toMatchObject({ resume: { sessionId: "s-second" } });
  });

  /**
   * The conversation behind an older version would build a plan the person has
   * since seen changed, so it never stands in for the latest one's.
   */
  it("starts fresh rather than carry on from an older version's session", async () => {
    const first = worktree(3);
    const { asked, runtime } = await onParent(async (agent) => {
      const plan = await planned(agent, first);
      await filedBy(first, plan.runId, "s-first", plan);
      // An edit filed a newer version, and its workspace was since reclaimed:
      // nothing records its session.
      await preparePlanner(
        { ...planning(plan.id), parent: agent.pluginContext() },
        placingPool(worktree(5)).pool
      );
      await file(plan.id, "# The plan\n\nDo less.");
      return build(agent, plan.id, first);
    });

    expect(asked[0]).not.toHaveProperty("near");
    expect(runtime).not.toHaveProperty("resume");
  });

  /** A recovered turn reports the handle again, without the plan it filed. */
  it("keeps the plan a session filed, and forgets a session found gone", async () => {
    const stub = sandboxAt(`claude-coordinator-spec:${crypto.randomUUID()}`);
    await stub.noteSession("run-1", {
      sessionId: "s1",
      plan: "p1",
      version: 2
    });
    await stub.noteSession("run-1", { sessionId: "s1", transcript: "run-0" });
    expect(await stub.sessionOf("run-1")).toEqual({
      sessionId: "s1",
      transcript: "run-0",
      plan: "p1",
      version: 2
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

/** The repository a spec's worktrees are a pool of, unless one names another. */
const POOL_REPO = "acme/plan";

/** A worktree of a planning or writing session, in a workspace of its own. */
function worktree(slot = 3, repo = POOL_REPO): SessionPlace {
  return {
    workspaceName: `claude-coordinator-spec:${crypto.randomUUID()}`,
    dir: "/workspace/plan",
    branch: "claude-coordinator/p",
    slot: { repo, slot }
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

/** The sandbox a session ran in, where its handle is recorded. */
function sandboxAt(name: string) {
  return env.CLAUDE_COORDINATOR_SANDBOX.getByName(name);
}

/** A pool that records what a session's hooks asked of it. */
function recordingPool(
  resolve?: () => Promise<never>,
  kept: KeptWork = {
    note: "Its work up to that point is kept on `claude-coordinator/task-1/call_1`.",
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
        branch: "claude-coordinator/task-1/call_1"
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
    },
    working: () => false
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
      branch: "claude-coordinator/task-1/call_1"
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

  /**
   * A revision's worktree holds none of its work on the branch the worktree
   * is on: what it kept it pushed, and the rest is wherever it was when stopped.
   */
  it("frees a completed revision's worktree, and holds a stopped one's with a note saying where", async () => {
    const place = worktree();
    const runtime = {
      [SANDBOX_RUNTIME_KEY]: place.workspaceName,
      dir: place.dir,
      branch: place.branch,
      revisions: [{ branch: "feat/x", pulls: [] }]
    };
    const done = recordingPool();
    const stopped = recordingPool();
    const note = await onParent(async (agent) => {
      await settleReviser(
        {
          taskId: "task-1",
          runId: "detached:call_1",
          runtime,
          result: { status: "completed" } as AgentToolLifecycleResult
        },
        done.pool,
        agent.ctx.storage
      );
      await settleReviser(
        {
          taskId: "task-1",
          runId: "detached:call_2",
          runtime,
          result: { status: "aborted" } as AgentToolLifecycleResult
        },
        stopped.pool,
        agent.ctx.storage
      );
      return keptNote(agent.ctx.storage, "detached:call_2");
    });

    expect(done.calls).toEqual(["release, forgetting its branch"]);
    expect(stopped.calls).toEqual(["keep", "release, held"]);
    expect(note).toContain("What it pushed is on the pull requests.");
    expect(note).toContain("`repo_worktree` with `claude-coordinator/p`");
  });

  it("tells the parent where a failed run's work was kept, once, in its follow-up", async () => {
    const text = await onParent((agent) => {
      keepNote(agent.ctx.storage, "task-1", "detached:call_1", "kept on b");
      const run = {
        runId: "detached:call_1",
        agentType: "ClaudeCoordinatorWriterChild",
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

/** The pre-flight: see `admitSession` in `@/agents/claude-coordinator/plugins`. */
describe("the credential pool", () => {
  it("reports a fresh pool as usable", async () => {
    const workspace = freshWorkspace("fresh-pool");
    const lead = await workspace.claudeAdmit();

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

  /**
   * A stored reset is Anthropic's answer at the time, and a plan upgrade makes
   * it wrong. The session is admitted and asks again.
   */
  it("admits a session once every credential is spent, clearing the marks", async () => {
    const name = `admit-spent:${crypto.randomUUID()}`;
    const resetAt = Date.now() + 60 * 60_000;
    const binding = env.CLAUDE_COORDINATOR_SANDBOX;
    const poolIn = (storage: DurableObjectStorage) =>
      credentialPool({
        credentials: () => claudeCredentials(env),
        store: {
          read: async () =>
            (await storage.get<CredentialState[]>(CREDENTIALS_KEY)) ?? [],
          write: (states) => storage.put(CREDENTIALS_KEY, states)
        }
      });
    await runInDurableObject(
      binding.get(binding.idFromName(name)),
      async (_, state) => {
        const pool = poolIn(state.storage);
        let lead = await pool.lead();
        while (lead.ok) lead = await pool.spend(lead.id, resetAt);
      }
    );

    await expect(admitSession(env, name)).resolves.toBeUndefined();
    const lead = await runInDurableObject(
      binding.get(binding.idFromName(name)),
      async (_, state) => await poolIn(state.storage).lead()
    );
    expect(lead).toMatchObject({ ok: true, index: 0 });
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
    // Unconditional: a model reaches for `gh` unprompted, and should know it
    // works and that there is no token in reach.
    expect(brief).toContain("## GitHub");
    expect(brief).toContain("there is no token here to read or print");
    // The rules are a writer's, on a branch.
    expect(brief).not.toContain("Never merge");
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
      branch: "claude-coordinator/task-1/1",
      submodules: ["core", "starter"],
      continues: false
    });

    expect(brief).toContain("You are on `claude-coordinator/task-1/1`");
    expect(brief).toContain("- `core`\n- `starter`");
    expect(brief).toMatch(/Commit inside each one you\nchange/);
    // Whether a submodule is installed is the repository's install's to say. A
    // session that assumes not wipes a tree it was given; one that assumes so
    // runs a suite against no dependencies, or a broken or outdated tree.
    expect(brief).toMatch(/when its `node_modules` is empty/);
    expect(brief).toMatch(/when this workspace's install failed/);
    expect(brief).toMatch(/after you\nchange its lockfile/);
  });

  /** Only commits leave a session, and it has to hear that before it starts. */
  it("says uncommitted work is deleted, and what the branch's owner may not do", () => {
    const brief = sessionBrief(TASK, undefined, {
      branch: "claude-coordinator/task-1/1",
      submodules: [],
      continues: false
    });

    expect(brief).toContain("## Your branch");
    expect(brief).toMatch(
      /anything left\nuncommitted is deleted when you finish/
    );
    expect(brief).toContain("Push this branch and no other.");
    expect(brief).toContain("Never merge");
    expect(brief).toContain("Never request a reviewer");
    // What makes the coordinator worth having: a session that waits on a review
    // holds its container for nothing.
    expect(brief).toContain("**Never wait for a review or for CI**");
    expect(brief).not.toContain("Submodules");
    expect(brief).not.toContain("earlier work");
  });

  it("asks a build to open its pull request ready for review, and to stop for a decision", () => {
    const brief = sessionBrief(TASK, undefined, {
      branch: "claude-coordinator/task-1/1",
      submodules: [],
      continues: false
    });

    expect(brief).toContain("## Delivering it");
    expect(brief).toContain("**ready for review, not a draft**");
    expect(brief).toContain("`needs_input`");
    expect(brief).not.toContain("## Pull request #");
  });

  it("tells a revision to check its branches out itself, and how to answer what landed", () => {
    const brief = sessionBrief(
      "Work on these branches:\n\n- `feat/x`: Copilot has reviewed it.",
      undefined,
      {
        branch: "claude-coordinator/r",
        submodules: ["core"],
        continues: false,
        revising: true
      }
    );

    expect(brief.startsWith("Work on these branches:")).toBe(true);
    expect(brief).toContain("## Your branches");
    expect(brief).toMatch(
      /on `claude-coordinator\/r`: a place to\s+start from, not a branch to push/
    );
    expect(brief).toContain("gh pr list --head <branch>");
    expect(brief).toContain("stop and say so rather than switch over them");
    expect(brief).toContain("Push those branches and no others");
    expect(brief).toContain("### Submodules");
    expect(brief).toContain("## What brought you back");
    expect(brief).toContain("resolve it either way");
    expect(brief).toContain(
      "look once at each pull request's review and checks"
    );
    expect(brief).not.toContain("## Your branch\n");
    expect(brief).not.toContain("Do not switch or rename the branch");
    expect(brief).not.toContain("## Delivering it");
    // The stop channel comes from `DESIGN_NOTE`, as it does for a build.
    expect(brief).toContain("## The bar for this work");
    expect(brief).toContain("`needs_input`");
  });

  /**
   * The failure this note exists for is silent: a session that finds a better
   * shape mid-work, takes the smaller change it can finish now, and reports
   * success. Pinned with the threshold, which is what makes it actionable —
   * design, shape and scope are asked about, a mechanical difference is not.
   */
  it("tells a writing session the bar, and to ask rather than settle for a smaller shape", () => {
    const brief = sessionBrief(TASK, undefined, {
      branch: "claude-coordinator/task-1/1",
      submodules: [],
      continues: false
    });

    expect(brief).toContain("## The bar for this work");
    expect(brief).toContain(
      "**A deviation of design, shape or scope is a question, not a call you make quietly.**"
    );
    expect(brief).toMatch(
      /taking the smaller, safer change you can finish now/
    );
    expect(brief).toMatch(/Growing the task for a design worth having is/);
    expect(brief).toMatch(/Mechanical deviations are yours/);
    expect(brief).toContain("`needs_input`");
    // A session told to find something out and change nothing has no branch,
    // no pull request and nothing to deviate from.
    expect(sessionBrief(TASK)).not.toContain("## The bar for this work");
  });

  /**
   * The two halves of a revision that pull in opposite directions: a
   * self-review makes what is there better without going looking for work,
   * while a point answered by adding behaviour or redesigning is asked about.
   * The narrowing is pinned too — a correctness fix changes behaviour by
   * definition, and reading it as a deviation would stop the one pass.
   */
  it("aims a self-review at the diff, and asks about a review point that is not a fix", () => {
    const brief = sessionBrief("A self-review, please.", undefined, {
      branch: "claude-coordinator/r",
      submodules: [],
      continues: false,
      revising: true
    });

    expect(brief).toContain("**The diff is the subject**");
    expect(brief).toMatch(
      /does not go looking for work elsewhere or for behaviour to add/
    );
    expect(brief).toMatch(/A point you would answer by adding/);
    expect(brief).toMatch(/is not a fix: ask rather than/);
    expect(brief).toMatch(
      /Correcting what a point\n  shows is wrong is a fix, however visibly the behaviour changes/
    );
  });

  /** Each full run is minutes of the person's wait, and a baseline it was given is one. */
  it("says to check once, against the base the brief already gives", () => {
    const brief = sessionBrief(TASK, undefined, {
      branch: "claude-coordinator/task-1/1",
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
      branch: "claude-coordinator/task-1/1",
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
  const branch = "claude-coordinator/task-1/1";

  /**
   * Where a revising session was sent, and no count of what reached each pull
   * request: that count cost a GitHub call per pull request, and what it
   * pushed is in the session's own answer above this note.
   */
  it("names the branches a revision was sent back to", () => {
    const note = revisionNote(
      ["feat/x", "feat/y"],
      [{ path: ".", files: ["notes.md"] }]
    );

    expect(note).toContain("**Sent back to:** `feat/x`, `feat/y`.");
    expect(note).toContain(
      "**Deleted, uncommitted:** the repository: `notes.md`."
    );
  });

  it("names each repository with commits, and how to add to the branch", () => {
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
    expect(note).toContain("`continue`");
    expect(note).toContain("`claude_code_revise`");
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
      /No commits were made on `claude-coordinator\/task-1\/1`/
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
describe("claude-coordinator's credential pool", () => {
  it("hands over every configured credential, in declared order", () => {
    // A misspelled binding reads as `undefined` and is filtered out, so a
    // missing entry fails here rather than at the first 429.
    expect(claudeCredentials(env as never)).toEqual([
      env.CLAUDE_CODE_OAUTH_TOKEN_1,
      env.CLAUDE_CODE_OAUTH_TOKEN_2,
      env.CLAUDE_CODE_OAUTH_TOKEN_3
    ]);
  });

  it("drops an unset entry instead of offering an empty credential", () => {
    expect(
      claudeCredentials({
        CLAUDE_CODE_OAUTH_TOKEN_1: "sk-ant-oat01-one",
        CLAUDE_CODE_OAUTH_TOKEN_2: "",
        CLAUDE_CODE_OAUTH_TOKEN_3: "sk-ant-oat01-three"
      } as never)
    ).toEqual(["sk-ant-oat01-one", "sk-ant-oat01-three"]);
  });
});

/**
 * Who a session's commits belong to.
 *
 * What only this side can get wrong is answering it with a *different* identity
 * from the one `/repo` commits as, which is the disagreement
 * `@/workspace/git-identity` exists to prevent — so this pins that they are one
 * answer, not any particular name.
 */
describe("who a session commits as", () => {
  it("hands every sandbox command the deployment's git identity", () => {
    const author = gitIdentity(env as never);
    const vars = sandboxEnv(env as never);

    expect(vars.GIT_AUTHOR_NAME).toBe(author.name);
    expect(vars.GIT_COMMITTER_NAME).toBe(author.name);
    expect(vars.GIT_AUTHOR_EMAIL).toBe(author.email || undefined);
    expect(vars.GIT_COMMITTER_EMAIL).toBe(author.email || undefined);
  });
});

/**
 * GitHub as the deployment's account, for the sessions. What only this side
 * can get wrong is which secret backs it, and leaving a token where the
 * container could read it.
 */
describe("the sessions' GitHub token", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is the deployment's, swapped in by the egress and never in the container", async () => {
    const plan = egressPlan(CLAUDE_COORDINATOR_EGRESS, "SANDBOX/caller");
    const forwarded: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      forwarded.push(new Request(input as RequestInfo, init));
      return new Response("{}");
    });

    await sandboxEgress(
      new Request("https://api.github.com/user", {
        headers: { authorization: `Bearer ${GITHUB_TOKEN_PLACEHOLDER}` }
      }),
      [...plan.http, ...plan.https],
      { ...(env as object), GITHUB_TOKEN: "ghp_deployment" },
      CLAUDE_COORDINATOR_EGRESS
    );

    expect(forwarded[0]?.headers.get("authorization")).toBe(
      "Bearer ghp_deployment"
    );
    expect(plan.env.GH_TOKEN).toBe(GITHUB_TOKEN_PLACEHOLDER);
    expect(sandboxEnv(env as never)).not.toHaveProperty("GH_TOKEN");
  });
});

/**
 * A session sent back to a branch carries on the conversation that last worked
 * on it — see `./branches.ts` — so the one that answers a review is the one that
 * wrote the code.
 */
describe("going back to a branch", () => {
  const BRANCH = "claude-coordinator/abcde";

  /** A run placed in `place` on `BRANCH`, whose session its workspace recorded. */
  async function worked(agent: Parent, place: SessionPlace, sessionId: string) {
    const runId = `detached:${crypto.randomUUID()}`;
    recordBranchRun(agent.ctx.storage, {
      runId,
      branch: BRANCH,
      workspaceName: place.workspaceName,
      ...(place.slot ? { slot: place.slot } : {})
    });
    await sandboxAt(place.workspaceName).noteSession(runId, { sessionId });
    return runId;
  }

  /**
   * A session sent back to `BRANCH`, with the parent selecting what `place` is:
   * a worktree of a repository, or — with no worktree — its own workspace. That
   * selection is what scopes the ledger lookup; see `BranchScope`.
   */
  const continuing = (agent: Parent, place: SessionPlace) => {
    activeRepo(agent.ctx.storage).set(place.slot?.repo ?? SCRATCH_REPO);
    const placing = placingPool(place);
    return prepareWriter(
      {
        input: { task: "carry on, they chose JSON", continue: BRANCH },
        taskId: "task-1",
        runId: `detached:${crypto.randomUUID()}`,
        parent: agent.pluginContext()
      },
      placing.pool
    ).then((runtime) => ({ runtime, asked: placing.asked }));
  };

  it("carries on the branch's conversation, in its worktree, without a fork", async () => {
    const place = { ...worktree(3), branch: BRANCH };
    const { runtime, asked, runId } = await onParent(async (agent) => {
      const runId = await worked(agent, place, "s-build");
      return { ...(await continuing(agent, place)), runId };
    });

    expect(asked[0]).toMatchObject({
      continue: BRANCH,
      near: { repo: POOL_REPO, slot: 3 }
    });
    expect(runtime).toMatchObject({
      resume: { sessionId: "s-build", fromRun: runId }
    });
    expect(
      (runtime as { resume: Record<string, unknown> }).resume
    ).not.toHaveProperty("fork");
  });

  /** Going back to a branch is the session that wrote it, so its page too. */
  it("files on the transcript of the session it carries on", async () => {
    const place = { ...worktree(3), branch: BRANCH };
    const { runtime, runId } = await onParent(async (agent) => {
      const runId = await worked(agent, place, "s-build");
      return { ...(await continuing(agent, place)), runId };
    });

    expect(carriedTranscript({ runtime })).toBe(runId);
  });

  it("starts fresh on the branch when it lands in another worktree", async () => {
    const runtime = await onParent(async (agent) => {
      await worked(agent, { ...worktree(3), branch: BRANCH }, "s-build");
      return (await continuing(agent, { ...worktree(4), branch: BRANCH }))
        .runtime;
    });

    expect(runtime).toMatchObject({ branch: BRANCH });
    expect(runtime).not.toHaveProperty("resume");
  });

  it("passes over a run whose conversation its workspace no longer holds", async () => {
    const found = await onParent(async (agent) => {
      const kept = { ...worktree(3), branch: BRANCH };
      await worked(agent, kept, "s-kept");
      // A later run on the branch, in the same pool, whose workspace has no
      // record of it.
      recordBranchRun(agent.ctx.storage, {
        runId: "detached:gone",
        branch: BRANCH,
        workspaceName: worktree(5).workspaceName,
        slot: { repo: POOL_REPO, slot: 5 }
      });
      return branchSession(
        agent.ctx.storage,
        BRANCH,
        { repo: POOL_REPO },
        (name, runId) => sandboxAt(name).sessionOf(runId)
      );
    });

    expect(found).toMatchObject({ sessionId: "s-kept" });
  });

  /**
   * One caller's ledger holds every repository they have worked on, and a
   * branch name scopes nothing across them: a caller passes `continue` the name
   * an earlier report gave, or a pull request's head branch, and `fix-ci` is a
   * name two repositories both have.
   */
  it("passes over a newer run on the same branch name in another repository", async () => {
    const mine = { ...worktree(3), branch: BRANCH };
    const { runtime, asked, runId } = await onParent(async (agent) => {
      const runId = await worked(agent, mine, "s-mine");
      // Later, so it is the latest run on the name, and elsewhere.
      await worked(
        agent,
        { ...worktree(4, "acme/other"), branch: BRANCH },
        "s-theirs"
      );
      return { ...(await continuing(agent, mine)), runId };
    });

    expect(asked[0]).toMatchObject({ near: { repo: POOL_REPO, slot: 3 } });
    expect(runtime).toMatchObject({
      resume: { sessionId: "s-mine", fromRun: runId }
    });
  });

  /**
   * With no repository selected a session runs in the parent's own workspace —
   * a scratchpad — which holds one tree and no branch. Another repository's run
   * on the name is not its work, and not a worktree to ask for either.
   */
  it("asks for no worktree in a scratchpad, and starts fresh", async () => {
    const scratch = { workspaceName: "scratch", dir: "/workspace/s" };
    const { runtime, asked } = await onParent(async (agent) => {
      await worked(agent, { ...worktree(3), branch: BRANCH }, "s-repo");
      return continuing(agent, scratch);
    });

    expect(asked[0]).not.toHaveProperty("near");
    expect(runtime).not.toHaveProperty("resume");
  });

  it("refuses a branch to continue and a new one to name together", async () => {
    const refused = await onParent((agent) =>
      prepareWriter(
        {
          input: { task: TASK, continue: BRANCH, branch: "docs/x" },
          taskId: "task-1",
          runId: "detached:call_1",
          parent: agent.pluginContext()
        },
        placingPool(worktree()).pool
      ).then(
        () => "",
        (err: unknown) => String(err)
      )
    );
    expect(refused).toContain("not both");
  });
});

/**
 * A revision names branches, and the host checks only what it can answer from
 * its own state: a name git would take, named once, with nobody working on it.
 * The session checks the branches out itself, so nothing here places it on one.
 *
 * **Nothing asks GitHub whether a pull request is open.** That check cost a
 * call per branch per repository on the path of every revision, to prevent a
 * failure the session reports for itself in a sentence — so a branch whose pull
 * request is merged, closed or absent is dispatched and says so.
 */
describe("sending branches back to be revised", () => {
  /** `revisions` sent back, with the parent on `POOL_REPO`. */
  const revising = (
    agent: Parent,
    revisions: ReviseInput["revisions"],
    working: string[] = []
  ) => {
    const active = activeRepo(agent.ctx.storage);
    active.set(POOL_REPO);
    active.setCheckout(
      {
        url: `https://github.com/${POOL_REPO}`,
        dir: "/workspace/plan",
        branch: "main"
      },
      { repo: POOL_REPO, submodules: ["acme/core"] }
    );
    const placing = placingPool(worktree());
    const reached: string[] = [];
    const watch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL) => {
        reached.push(String(input));
        return new Response("{}", { status: 200 });
      });
    return prepareReviser(
      {
        input: { revisions },
        taskId: "task-1",
        runId: `detached:${crypto.randomUUID()}`,
        parent: agent.pluginContext()
      },
      { ...placing.pool, working: (branch) => working.includes(branch) }
    )
      .then(
        (runtime) => ({
          runtime,
          placed: placing.asked,
          reached,
          refused: ""
        }),
        (err: unknown) => ({
          runtime: undefined,
          placed: placing.asked,
          reached,
          refused: String(err)
        })
      )
      .finally(() => watch.mockRestore());
  };

  it("claims one fresh worktree for every branch, asking GitHub nothing", async () => {
    const { runtime, placed, reached } = await onParent((agent) =>
      revising(agent, [
        { branch: "feat/x", task: "Copilot has reviewed it." },
        { branch: "feat/y", task: "The test check failed." }
      ])
    );

    // The whole point of deleting the gate: dispatch costs no network at all.
    expect(reached).toEqual([]);
    expect(placed).toEqual([
      {
        taskId: "task-1",
        runId: expect.any(String),
        revising: ["feat/x", "feat/y"]
      }
    ]);
    expect(runtime).toMatchObject({
      revisions: [{ branch: "feat/x" }, { branch: "feat/y" }]
    });
    // A fresh session: its branches are not one conversation to carry on.
    expect(runtime).not.toHaveProperty("resume");
  });

  /**
   * A merged pull request is no longer a refusal. The session is started and
   * reports what it found, which is the trade the gate's deletion makes.
   */
  it("starts a session for a branch whose pull request is gone", async () => {
    const { runtime, placed, refused } = await onParent((agent) =>
      revising(agent, [{ branch: "feat/merged", task: "t" }])
    );

    expect(refused).toBe("");
    expect(placed).toHaveLength(1);
    expect(runtime).toMatchObject({ revisions: [{ branch: "feat/merged" }] });
  });

  it("refuses the whole call, saying why for each branch it cannot revise", async () => {
    const { refused, placed } = await onParent((agent) =>
      revising(
        agent,
        [
          { branch: "feat/ok", task: "t" },
          { branch: "not a branch", task: "t" },
          { branch: "feat/ok", task: "again" },
          { branch: "feat/busy", task: "t" }
        ],
        ["feat/busy"]
      )
    );

    expect(placed).toEqual([]);
    expect(refused).toContain("nothing was started");
    expect(refused).toContain("`not a branch`: not a branch name.");
    expect(refused).toContain("`feat/ok`: named more than once.");
    expect(refused).toContain("`feat/busy`: a session is working on it now");
  });

  it("refuses with nothing checked out", async () => {
    const refused = await onParent((agent) =>
      prepareReviser(
        {
          input: { revisions: [{ branch: "feat/x", task: "t" }] },
          taskId: "task-1",
          runId: "detached:call_1",
          parent: agent.pluginContext()
        },
        placingPool(worktree()).pool
      ).then(
        () => "",
        (err: unknown) => String(err)
      )
    );
    expect(refused).toContain("Clone the one the branches are in");
  });

  it("hands the session each branch and what brought it back", () => {
    expect(
      revisionsText({
        revisions: [
          { branch: "feat/x", task: "Copilot has reviewed it. " },
          { branch: "feat/y", task: "The test check failed." }
        ]
      })
    ).toBe(
      [
        "Work on these branches:",
        "",
        "- `feat/x`: Copilot has reviewed it.",
        "- `feat/y`: The test check failed."
      ].join("\n")
    );
  });
});

/** Where a session works is the checkout that carries the repository the parent reads. */
describe("the checkouts a caller has recorded", () => {
  it("roots a submodule at the superproject that carries it, keeping what it carries when a read fails", async () => {
    const roots = await onParent((agent) => {
      const active = activeRepo(agent.ctx.storage);
      const at = (repo: string) => ({
        url: `https://github.com/${repo}`,
        dir: `/workspace/${repo}`,
        branch: "main"
      });
      active.setCheckout(at("Acme/Super"), {
        repo: "Acme/Super",
        submodules: ["acme/Core"]
      });
      active.setCheckout(at("acme/core"), {
        repo: "acme/core",
        submodules: []
      });
      // A refresh whose `.gitmodules` could not be read.
      active.setCheckout(at("Acme/Super"), { repo: "Acme/Super" });
      return [
        active.rootOf("ACME/core"),
        active.rootOf("acme/other"),
        active.checkoutOf("acme/super")?.dir
      ];
    });

    // GitHub's names match whatever the case; the pool is keyed on the name as cloned.
    expect(roots).toEqual([
      "Acme/Super",
      "acme/other",
      "/workspace/Acme/Super"
    ]);
  });
});

/**
 * A superproject's submodules, read from the sandbox's files — `gitmodulesOf`
 * says why as a file, and why a failed read records nothing.
 */
describe("a checkout's .gitmodules", () => {
  /** A sandbox as the file read sees it: `null` is a file that is not there. */
  const sandboxHolding = (
    files: Record<string, string | { throws: unknown }>
  ) => ({
    readFile: async (path: string) => {
      const held = files[path];
      if (held === undefined) return null;
      if (typeof held !== "string") throw held.throws;
      return new TextEncoder().encode(held);
    }
  });

  const read = (files: Record<string, string | { throws: unknown }>) =>
    gitmodulesOf(sandboxHolding(files), "/workspace/super");

  it("is the file", async () => {
    expect(await read({ "/workspace/super/.gitmodules": "[submodule]" })).toBe(
      "[submodule]"
    );
  });

  /**
   * The two nothings, which must not collapse into one. "No submodules" is
   * recorded; "could not read" is not, or a transient fault would erase a
   * superproject's submodules from the selection and send the next session to
   * clone the root alone.
   */
  it("is empty when the repository has no submodules", async () => {
    expect(await read({})).toBe("");
  });

  it("is unknown when the file is there and will not read", async () => {
    expect(
      await read({
        "/workspace/super/.gitmodules": { throws: new Error("EIO") }
      })
    ).toBeUndefined();
  });

  it("is unknown when the sandbox cannot be reached at all", async () => {
    const text = await gitmodulesOf(
      {
        readFile: async () => {
          throw new Error("no such object");
        }
      },
      "/workspace/super"
    );
    expect(text).toBeUndefined();
  });

  /** The parse that turns the file into the repositories a session may work in. */
  it("names the repositories a superproject carries", () => {
    expect(
      submoduleRepos(
        [
          '[submodule "core"]',
          "\tpath = core",
          "\turl = https://github.com/acme/core.git",
          '[submodule "web"]',
          "\tpath = web",
          "\turl = ../web.git"
        ].join("\n"),
        "https://github.com/acme/super"
      )
    ).toEqual(["acme/core", "acme/web"]);
  });
});

/** A writing session answers as data, so the coordinator reads fields, not prose. */
describe("a writing session's answer", () => {
  const ended = (structured: unknown) =>
    ({
      session: {
        exitCode: 0,
        result: {
          subtype: "success",
          isError: false,
          text: JSON.stringify(structured),
          sessionId: "s1",
          numTurns: 3,
          durationMs: 12_000,
          apiErrorStatus: null,
          costUsd: 0.2,
          usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
          permissionDenials: 0,
          structured
        }
      }
    }) as never;

  it("asks for how it ended and what it did, and nothing more", () => {
    expect(WRITE_OUTPUT.required).toEqual(["status", "summary"]);
    expect(WRITE_OUTPUT.properties.status.enum).toEqual([
      "done",
      "needs_input",
      "blocked"
    ]);
  });

  /**
   * The fields are what the schema puts in front of the session, so the
   * threshold has to be in them too: a `needs_input` described as a product
   * decision alone is a session that builds a shape it was going to ask about.
   */
  it("describes a stop as a deviation too, and asks the summary for the rest", () => {
    const { status, summary, question } = WRITE_OUTPUT.properties;
    expect(status.description).toMatch(
      /a deviation of design, shape or scope that is theirs to approve/
    );
    expect(question.description).toMatch(
      /what you would do instead, and what each costs/
    );
    // What was too small to stop for still has to reach the person.
    expect(summary.description).toMatch(
      /where you departed from the brief or the plan/
    );
  });

  it("is reported with its pull request and the checks it ran", () => {
    const report = sessionReport(
      ended({
        status: "done",
        summary: "Added --json, with tests.",
        pullRequests: [
          { number: 12, url: "https://github.com/acme/api/pull/12" }
        ],
        checks: [
          { command: "npm test", passed: true },
          { command: "npm run lint", passed: false }
        ]
      })
    );

    expect(report).toContain(
      "**Done.** Pull request #12: https://github.com/acme/api/pull/12"
    );
    expect(report).toContain("Added --json, with tests.");
    expect(report).toContain("`npm test` passed; `npm run lint` FAILED");
  });

  it("is reported with every pull request, one per repository it changed", () => {
    const report = sessionReport(
      ended({
        status: "done",
        summary: "Moved the hook into core, and starter onto it.",
        pullRequests: [
          { number: 81, url: "https://github.com/acme/core/pull/81" },
          { number: 110, url: "https://github.com/acme/starter/pull/110" }
        ]
      })
    );

    expect(report).toContain(
      "**Done.** Pull requests #81: https://github.com/acme/core/pull/81, #110: https://github.com/acme/starter/pull/110"
    );
  });

  it("carries the question a session stopped on", () => {
    const report = sessionReport(
      ended({
        status: "needs_input",
        summary: "Two output shapes would work.",
        question: "Nested or flat JSON?"
      })
    );

    expect(report).toContain("**Stopped for the person's decision.**");
    expect(report).toContain(
      "**Question for the person:** Nested or flat JSON?"
    );
  });

  it("says so when a session stopped for a decision and named none", () => {
    const report = sessionReport(
      ended({ status: "needs_input", summary: "Unsure which shape." })
    );

    expect(report).toContain("**It named no question.**");
  });
});

/**
 * The relay, which is the half a session cannot enforce: it stops with a
 * question, and what reaches the person is whatever the parent does next.
 * Matched on short fragments, because this soul is prose that gets rewritten:
 * what is pinned is the rule, not the sentence carrying it.
 */
describe("what the coordinator does with a session's question", () => {
  it("relays it rather than settling it, and does not re-brief the simpler path", () => {
    expect(SOUL).toContain("nothing softened and nothing dropped");
    expect(SOUL).toContain("re-briefing the session to take the simpler path");
  });

  /**
   * Against the line above it, which tells it to hold the scope it was asked
   * for: a session saying the scope has to grow is not scope creep to refuse.
   */
  it("treats a scope that has to grow as the person's call", () => {
    expect(SOUL).toContain("the person's to decide and not yours to refuse");
  });

  /**
   * A planner cannot stop to ask, so its account is the only place its
   * question exists — and the approval opt-out is the one path that would
   * otherwise drop it on the way past.
   */
  it("still asks a caller who does not approve plans what only they can decide", () => {
    expect(SOUL).toContain("what they opted out of is reading a plan");
  });
});

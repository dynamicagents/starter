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
import type { ClaudeCoderWorkspaceDO } from "@/index";
import {
  ClaudeCoderReader,
  ClaudeCoderSession,
  claimSession,
  forgetKept,
  keepNote,
  settleSession
} from "@/agents/claude-coder/children";
import {
  sessionBrief,
  sessionFooter,
  warningPrompt,
  writingNote
} from "@/agents/claude-coder/session-report";
import { CLAUDE_CODE_SESSION } from "@/config";
import {
  claudeCodeConfig,
  CREDENTIALS_KEY,
  GH_TOKEN_PLACEHOLDER
} from "@/agents/claude-coder/claude-code";
import { admitSession } from "@/agents/claude-coder/plugins";
import { activeRepo } from "@/workspace/active-repo";
import { gitIdentity } from "@/workspace/git-identity";
import type {
  KeptWork,
  SubtaskWorkspaces
} from "@/workspace/subtask-workspace";

/**
 * The claude-coder's wiring, pinned.
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
  key = `claude-coder-spec:${crypto.randomUUID()}`
) =>
  runInDurableObject(
    (env.ClaudeCoder as unknown as DurableObjectNamespace).get(
      env.ClaudeCoder.idFromName(key)
    ),
    (instance) => read(instance as unknown as Parent)
  );

const { freshStub: freshWorkspace } = makeDoHelpers<ClaudeCoderWorkspaceDO>(
  env.CLAUDE_CODER_WORKSPACE
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
      "claude_code_read",
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

  it("offers the writing session first, then the reading one", async () => {
    const names = await onParent((agent) =>
      agent.getSubAgents().map((Cls) => Cls.name)
    );
    expect(names).toEqual(["ClaudeCoderSession", "ClaudeCoderReader"]);
  });
});

describe("the sessions", () => {
  it("run in the background, because a session outlasts a turn", () => {
    expect(ClaudeCoderSession.spec.detached).toBe(true);
    expect(ClaudeCoderReader.spec.detached).toBe(true);
  });

  it.each([["CLAUDE_CODER_SESSION"], ["CLAUDE_CODER_READER"]])(
    "install no tools on %s: the session brings its own",
    async (binding) => {
      const ns = (env as unknown as Record<string, DurableObjectNamespace>)[
        binding
      ]!;
      const tools = await runInDurableObject(
        ns.get(ns.idFromName(`claude-coder-spec:${crypto.randomUUID()}`)),
        (instance) =>
          Object.keys(
            (instance as unknown as { getTools(): object }).getTools()
          )
      );
      expect(tools).toEqual([]);
    }
  );
});

/**
 * Where a session works, resolved on the parent before anything is dispatched.
 * A refusal here reaches the parent's model as the tool's error, at the cost
 * of one RPC rather than a container.
 */
describe("preparing a session", () => {
  it.each([
    ["writing", ClaudeCoderSession],
    ["reading", ClaudeCoderReader]
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
    const dir = "/workspace/spike";
    const key = `claude-coder-spec:${crypto.randomUUID()}`;
    const name = workspaceName(key, "acme/spike");
    const workspace = env.CLAUDE_CODER_WORKSPACE.get(
      env.CLAUDE_CODER_WORKSPACE.idFromName(name)
    );

    // A repository with git in it and no lockfile: cloned, recorded, and skipped
    // by the resolver.
    using ws = await openWorkspace(workspace);
    await ws.fs.mkdir(`${dir}/.git`, { recursive: true });
    await ws.fs.writeFile(`${dir}/.git/HEAD`, "ref: refs/heads/main\n");
    await workspace.noteCheckout({ dir, kind: "repo", repo: "acme/spike" });
    expect((await workspace.startInstall({ dir })).state).toBe("skipped");

    const runtime = await onParent((agent) => {
      activeRepo(agent.ctx.storage).set("acme/spike");
      return ClaudeCoderReader.spec.prepare!({
        input: { task: TASK } as never,
        taskId: "task-1",
        runId: "detached:call_1",
        parent: agent.pluginContext() as never
      });
    }, key);
    expect(runtime).toEqual({ workspaceName: name, dir });
  });
});

/** A pool that records what a session's hooks asked of it. */
function recordingPool(
  resolve?: () => Promise<never>,
  kept: KeptWork = {
    note: "Its work up to that point is kept on `claude-coder/task-1/call_1`.",
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
        branch: "claude-coder/task-1/call_1"
      })),
    reading: async () => ({ workspaceName: "w", dir: "/workspace/w" }),
    release: async (_ctx, options) => {
      calls.push(options?.hold ? "release, held" : "release");
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
      branch: "claude-coder/task-1/call_1"
    });
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
        agentType: "ClaudeCoderSession",
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

/** The pre-flight: see `admitSession` in `@/agents/claude-coder/plugins`. */
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
    const binding = env.CLAUDE_CODER_WORKSPACE;
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
      branch: "claude-coder/task-1/1",
      submodules: ["core", "starter"],
      continues: false
    });

    expect(brief).toContain("You are on `claude-coder/task-1/1`");
    expect(brief).toContain("- `core`\n- `starter`");
    expect(brief).toMatch(/Commit inside each one you\nchange/);
    // The install is the root's alone, and a session that does not know that
    // runs a submodule's suite against no dependencies.
    expect(brief).toMatch(/Run `npm ci` in a\nsubmodule/);
  });

  /** Only commits leave a session, and it has to hear that before it starts. */
  it("says uncommitted work is deleted, and that the parent pushes", () => {
    const brief = sessionBrief(TASK, undefined, {
      branch: "claude-coder/task-1/1",
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

  it("tells a continuing session the branch already holds work", () => {
    const brief = sessionBrief(TASK, undefined, {
      branch: "claude-coder/task-1/1",
      submodules: [],
      continues: true
    });

    expect(brief).toMatch(/already holds earlier work:/);
  });

  /** A reading session's copy is deleted, so asking it to commit wastes it. */
  it("says nothing about a branch to a reading session", () => {
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
  const branch = "claude-coder/task-1/1";

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

    expect(note).toMatch(/No commits were made on `claude-coder\/task-1\/1`/);
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
describe("claude-coder's credential pool", () => {
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
 * `@/agents/claude-coder/claude-code.ts`. What only this side can get wrong is
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
 * the image it would also reach cf-coder's container, whose egress is `direct`,
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

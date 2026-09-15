import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createAgentRuntime } from "@dynamicagents/core";
import type { PluginHost } from "@dynamicagents/core/host";
import type { RecipeExecutionRequest } from "@dynamicagents/core/subtasks";
import { makeDoHelpers } from "@dynamicagents/core/testing";
import type { ClaudeCoderWorkspaceDO } from "@/index";
import { openWorkspace } from "@/workspace/open";
import {
  CLAUDE_CODE_TYPE,
  WORKSPACE_RUNTIME_KEY
} from "@dynamicagents/plugins/claude-code";
import { SANDBOX_FAMILY } from "@dynamicagents/plugins/computer";
import { BROWSER_FAMILY } from "@dynamicagents/plugins/browser";
import { REPO_FAMILY } from "@dynamicagents/plugins/repo";
import { parentPlugins, subagentPlugins } from "@/agents/claude-coder/plugins";
import {
  sessionBrief,
  sessionFooter,
  settleDrain,
  type ClaudeCoderSubagent
} from "@/agents/claude-coder/subagent";
import { CLAUDE_CODER_CONFIG, CLAUDE_CODE_SESSION } from "@/config";

/**
 * The claude-coder's wiring, pinned.
 *
 * The division of labour between this file and `@dynamicagents/plugins` is worth
 * stating, because it is what keeps both suites small. The *machine* — the
 * drain, the cursor, the credential pool, the rotation — is specified in the
 * package, against fakes, with no container in sight. What is asserted here is
 * the **seam**: that this agent hands that machine the right things, and that
 * the paths where it cannot are the ones that fail with a sentence instead of a
 * stack trace.
 *
 * Every test below runs **without a container**, which the pool cannot start.
 * That is not a limitation here — the guards under test are exactly the ones
 * that must fire before a container is ever needed.
 */

/** A host in the shape the plugin lists take, over the test Worker's env. */
const host = (): PluginHost<Env> =>
  ({
    env,
    storage: undefined as unknown as DurableObjectStorage,
    callerKey: () => "test-caller",
    aiGatewayId: CLAUDE_CODER_CONFIG.model?.aiGatewayId ?? "default"
  }) as PluginHost<Env>;

const parent = () =>
  createAgentRuntime({
    config: CLAUDE_CODER_CONFIG,
    plugins: parentPlugins(host())
  });

const toolNames = async () =>
  Object.keys(
    await parent().mainAgentTools({
      session: { getCompactions: async () => [] } as never
    })
  ).sort();

/**
 * The tool split, which no typechecker can see.
 *
 * Two things enforce it and both fail quietly: an allowlist of tool *names*
 * passed to `restrictMainAgentTools`, and the fact that `validateRecipe` runs on
 * the **parent** and silently drops any family the parent did not register.
 */
describe("the parent's surface", () => {
  it("has git, a browser and read-only eyes on the checkout", async () => {
    const names = await toolNames();

    expect(names).toContain("sb_read");
    expect(names).toContain("sb_ls");
    expect(names).toContain("sb_exists");
    expect(names).toContain("repo_clone");
    expect(names).toContain("repo_open_pr");
  });

  /**
   * The whole point of the agent. A parent that could edit would edit, and the
   * session it exists to delegate to would never run.
   */
  it("has no shell, no writer and no editor", async () => {
    const names = await toolNames();

    expect(names).not.toContain("sb_exec");
    expect(names).not.toContain("sb_write");
    expect(names).not.toContain("sb_edit");
  });

  /**
   * `computer` is installed on the parent even though the parent barely uses
   * it, because `validateRecipe` runs here: a family the parent did not register
   * is dropped from every recipe its subagents run. Registering it is not
   * optional, and "tidying away" a plugin the parent does not call is how that
   * breaks.
   */
  it("registers the families a recipe may name, whether or not it calls them", () => {
    const families = [...parent().toolFamilies.keys()];

    expect(families).toContain(SANDBOX_FAMILY);
    expect(families).toContain(BROWSER_FAMILY);
    expect(families).toContain(REPO_FAMILY);
  });

  it("offers exactly one subtask type, and it is the Claude Code one", () => {
    expect(parent().types.keys).toEqual([CLAUDE_CODE_TYPE]);
  });
});

describe("what the main agent asks a person before doing", () => {
  it("holds opening a pull request, and nothing else", async () => {
    // The rule `test/coder-surface.spec.ts` pins for the coder, over this agent's
    // own `parentPlugins`: a separate list, so a rename there that dropped the
    // rule would let a pull request through unasked and the coder's spec would
    // still pass.
    const surface = await parent().mainAgentSurface({
      session: { getCompactions: async () => [] } as never
    });

    expect(Object.keys(surface.toolApproval)).toEqual(["repo_open_pr"]);
  });
});

/**
 * One entry, and the reason is not economy.
 *
 * A `claude-code` subtask does not run core's tool loop at all — the session
 * brings its own tools. So there is genuinely nothing for the facet's plugins to
 * build, and the single entry is there to register the *type*: `RecipeSubagentBase`
 * re-checks `validateParams(request.type, …)` on its inbound request, and an
 * empty registry throws `unknown subtask type` before `executeChunk` runs.
 */
describe("the subagent's surface", () => {
  it("registers the type and contributes no tool families", () => {
    const runtime = createAgentRuntime({
      config: CLAUDE_CODER_CONFIG,
      plugins: subagentPlugins(host())
    });

    expect(runtime.types.keys).toEqual([CLAUDE_CODE_TYPE]);
    expect(runtime.toolFamilies.size).toBe(0);
  });

  /**
   * The facet's workspace name comes from `ctx.runtime`, put there by the
   * parent's copy of this plugin. Its own thunk must never be reachable — if it
   * ever is, something is resolving a workspace from a caller identity that does
   * not exist on a facet, and a silent fallback there would send a session into
   * the wrong container.
   */
  it("refuses to resolve a workspace name from the facet side", async () => {
    const plugin = subagentPlugins(host())[0]!;
    // `rejects`, not `toThrow`: `resolveRuntime` is async, so the throw arrives
    // as a rejection and a synchronous assertion would pass the test while
    // leaving an unhandled rejection behind it.
    await expect(
      plugin.resolveRuntime?.({
        taskId: "t",
        subtaskId: 1,
        type: CLAUDE_CODE_TYPE,
        params: {},
        toolFamilies: []
      })
    ).rejects.toThrow(/from ctx.runtime/);
  });
});

/**
 * The facet's namespace exists **only under the test pool**.
 *
 * In production a subagent facet needs no binding and no `new_sqlite_classes`
 * entry — its storage is created beneath the bound parent agent, and
 * `ctx.exports` resolves it by class name. But the Vitest pool only marks
 * *bound* classes as facet-compatible, so `vitest.config.ts` adds one, and it is
 * therefore absent from the generated `Env`. The cast is that fact, written
 * down, in the one file that needs it.
 */
const { freshStub: freshSubagent } = makeDoHelpers(
  (
    env as unknown as {
      CLAUDE_CODER_SUBAGENT: DurableObjectNamespace<ClaudeCoderSubagent>;
    }
  ).CLAUDE_CODER_SUBAGENT
);
const { freshStub: freshWorkspace } = makeDoHelpers<ClaudeCoderWorkspaceDO>(
  env.CLAUDE_CODER_WORKSPACE
);

const request = (): RecipeExecutionRequest => ({
  taskId: "task-1",
  subtaskId: 1,
  type: CLAUDE_CODE_TYPE,
  recipe: {
    key: CLAUDE_CODE_TYPE,
    version: 1,
    soul: "unused",
    toolFamilies: [],
    enabled: true,
    limits: {},
    historyWindow: 1,
    reportMetrics: false
  },
  prompt: "add a --json flag",
  references: [],
  params: {}
});

/**
 * The two ways a chunk can be unable to start, and both must fail *as results*.
 *
 * Neither is transient, so neither may throw: a thrown chunk is retried by the
 * Workflow three times and then abandons the task, and retrying will not
 * conjure a checkout or a plugin registration. A failed subtask with a sentence
 * on it reaches the parent, which can tell the user.
 */
describe("executeChunk refuses to guess", () => {
  it("fails with a wiring sentence when no workspace reached it", async () => {
    const stub = freshSubagent("no-workspace");
    const outcome = await runInDurableObject(
      stub,
      (instance: ClaudeCoderSubagent) => instance.executeChunk(request(), 0)
    );

    expect(outcome.done).toBe(true);
    expect(outcome).toMatchObject({
      result: { status: "failed", modelId: null }
    });
    if (outcome.done && outcome.result.status === "failed") {
      // Names the actual fault — the plugin belongs on the parent, where
      // `resolveRuntime` runs — rather than reporting a missing container.
      expect(outcome.result.error).toMatch(/must be installed on the parent/);
    }
  });

  it("fails with an ordering sentence when nothing has been cloned", async () => {
    // A real workspace, reachable and empty: `checkoutDir()` has nothing to
    // report because nothing has been opened in it. The refusal is correct here
    // and wrong for the case below, which is why the two are specified together.
    const workspace = freshWorkspace("no-checkout");
    const name = await runInDurableObject(workspace, (_i, state) =>
      state.id.toString()
    );

    const stub = freshSubagent("no-checkout");
    const outcome = await runInDurableObject(
      stub,
      (instance: ClaudeCoderSubagent) =>
        instance.executeChunk(request(), 0, { [WORKSPACE_RUNTIME_KEY]: name })
    );

    expect(outcome.done).toBe(true);
    if (outcome.done && outcome.result.status === "failed") {
      expect(outcome.result.error).toMatch(/Clone a repository with/);
    } else {
      expect.unreachable("a subtask with no checkout must fail");
    }
  });
});

/**
 * The other side of the refusal above: a checkout the install resolver had
 * nothing to do in is still a checkout, and this gate must not confuse the two.
 *
 * The pair is the specification. An empty workspace and a checkout without a
 * lockfile are indistinguishable to a gate reading a path that only an install
 * writes, and one of those two answers is wrong in a way that costs a whole
 * delegation every time.
 *
 * The assertion is negative on purpose: there is no container in this pool, so a
 * chunk that gets past the gate cannot go on to run a session. What is specified
 * is that the gate is not what stops it.
 */
describe("a checkout with nothing to install", () => {
  it("is not mistaken for an empty workspace", async () => {
    const dir = "/workspace/spike";
    /**
     * Addressed by **name**, not by id, because this is the one test in the file
     * where the subagent has to reach the very object the test seeded.
     * `freshStub` names its object with a UUID it does not hand back, and the
     * facet resolves its workspace with `idFromName(runtime[…])` — so passing an
     * id string there names a *different*, empty object. Which is harmless for
     * the empty-workspace test above and would quietly gut this one.
     */
    const name = `test:skipped-install:${crypto.randomUUID()}`;
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

    const stub = freshSubagent("skipped-install");
    const outcome = await runInDurableObject(
      stub,
      (instance: ClaudeCoderSubagent) =>
        instance.executeChunk(request(), 0, { [WORKSPACE_RUNTIME_KEY]: name })
    ).catch((err: unknown) => ({ thrown: String(err) }));

    // However this chunk ends without a container, it must not end by claiming
    // there is nothing to work on.
    const said =
      "thrown" in outcome
        ? outcome.thrown
        : outcome.done && outcome.result.status === "failed"
          ? outcome.result.error
          : "";
    expect(said).not.toMatch(/Clone a repository with/);
  });
});

/**
 * The pre-flight, and why it is worth an RPC.
 *
 * An invocation carries an 18.7-27k-token cached prefix before it does
 * anything, so starting a session the egress gateway will refuse pays a container start
 * and that prefix to learn what this answers for free — and reports it as a
 * failed run rather than as a limit with a time on it.
 */
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
});

/**
 * Cancellation ordering, and the one thing a signal does not buy.
 *
 * `stop` is `killExec(id, { signal: "SIGTERM" })` — it delivers a signal and
 * returns. SIGTERM is chosen *because* Claude Code does more work after it:
 * aborts the turn, kills its Bash process tree, runs its `SessionEnd` hooks,
 * exits 143. Meanwhile the parent's `onTaskCanceled` awaits `abortRun` and then
 * runs `git reset --hard && git clean -fdx` in the same container — and the
 * session's writes reach the workspace on the pull its own drain triggers when
 * it reaches `done`, so a reset that goes first can be followed by a sync
 * carrying files the session wrote after it. The cleanup that exists to guarantee a clean tree would leave
 * an arbitrary half-reset one.
 *
 * The ordering itself needs a real container and belongs to the deploy-time
 * cancel test. What is coverable here is the wait that establishes it, which is
 * why its bound is injectable.
 */
describe("waiting for an interrupted session to unwind", () => {
  it("returns as soon as the drain settles", async () => {
    let drained: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      drained = resolve;
    });
    // A window far longer than this test could take, so a pass means it
    // observed the drain rather than outliving the bound.
    const waiting = settleDrain(settled, 30_000);
    drained();

    await expect(waiting).resolves.toBe(true);
  });

  it("gives up on a drain that never settles, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();

    // Never resolved: an isolate holding a stream a dead container will not
    // close. A cancellation still has to finish.
    const settled = new Promise<void>(() => {});

    await expect(settleDrain(settled, 10)).resolves.toBe(false);
    // Reported, because the ordering this exists for was not established and a
    // silent pass would hide a working-tree reset racing a filesystem sync.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("did not unwind within the settle window")
    );
  });

  /**
   * The no-session path must not pay the window. `abortRun` defers to the base
   * class when it is holding nothing, and a settle wait applied unconditionally
   * would stall every such cancellation for a full minute.
   */
  it("does not wait when the facet is holding no session", async () => {
    const stub = freshSubagent("abort-idle");
    const started = Date.now();
    const interrupted = await runInDurableObject(
      stub,
      (instance: ClaudeCoderSubagent) => instance.abortRun()
    );

    expect(interrupted).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
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
  const withPrompt = (
    over: Partial<RecipeExecutionRequest> = {}
  ): RecipeExecutionRequest => ({ ...request(), ...over });

  it("is the bare prompt when there is nothing to add", () => {
    expect(sessionBrief(withPrompt())).toBe("add a --json flag");
  });

  it("carries the workspace note where the session will read it", () => {
    const brief = sessionBrief(withPrompt(), "the install failed: ERESOLVE");
    expect(brief).toContain("add a --json flag");
    expect(brief).toContain("## The state of this workspace");
    expect(brief).toContain("the install failed: ERESOLVE");
  });

  /**
   * Order is not cosmetic. The prompt is the task; everything after it is
   * context for the task, and a note that preceded the instruction would read as
   * part of it.
   */
  it("keeps the task first and its context after", () => {
    const brief = sessionBrief(
      withPrompt({
        references: [{ role: "user", text: "the flag should be --json" }]
      }),
      "the workspace is full"
    );

    expect(brief.indexOf("add a --json flag")).toBe(0);
    expect(brief.indexOf("the workspace is full")).toBeLessThan(
      brief.indexOf("the flag should be --json")
    );
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

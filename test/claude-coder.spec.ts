import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createAgentRuntime } from "@dynamicagents/core";
import type { PluginHost } from "@dynamicagents/core/host";
import type { RecipeExecutionRequest } from "@dynamicagents/core/subtasks";
import { makeDoHelpers } from "@dynamicagents/core/testing";
import {
  ARTIFACTS_OBJECT_NAME,
  SESSION_TRANSCRIPT_KIND
} from "@dynamicagents/core/artifacts";
import type { ClaudeCoderWorkspaceDO } from "@/index";
import { openWorkspace } from "@dynamicagents/plugins/computer";
import {
  CLAUDE_CODE_READ_TYPE,
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
  warningPrompt,
  writingNote,
  type ClaudeCoderSubagent
} from "@/agents/claude-coder/subagent";
import { CLAUDE_CODER_CONFIG, CLAUDE_CODE_SESSION } from "@/config";
import {
  claudeCodeConfig,
  noWorkspaceRouting,
  GH_TOKEN_PLACEHOLDER
} from "@/agents/claude-coder/claude-code";
import { gitIdentity } from "@/workspace/git-identity";

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
   * Asserted here as well as in `cf-coder-surface.spec.ts`, because this agent's
   * `parentPlugins` is its own list: a review tool dropped from it would leave
   * this agent unable to answer a review while cf-coder's spec still passed.
   */
  it("can find out whether a review has landed, read it, and answer it", async () => {
    const names = await toolNames();

    expect(names).toContain("repo_pr_review_status");
    expect(names).toContain("repo_pr_threads");
    expect(names).toContain("repo_pr_thread_reply");
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

  /**
   * Both Claude Code types and nothing else, **in this order**: the delegating
   * model is shown them in the order the plugin list declares, and writing is the
   * one this agent is for. A third entry here would mean a plugin arrived with a
   * subtask type nobody meant to offer.
   */
  it("offers the two Claude Code subtask types, writing first", () => {
    expect(parent().types.keys).toEqual([
      CLAUDE_CODE_TYPE,
      CLAUDE_CODE_READ_TYPE
    ]);
  });
});

describe("what the main agent asks a person before doing", () => {
  it("holds nothing at all", async () => {
    // Over this agent's own `parentPlugins`, which is a separate list from
    // cf-coder's — so a rule added on one side is caught whichever side it lands on.
    // Nothing here is gated; `test/cf-coder-surface.spec.ts` says why.
    const surface = await parent().mainAgentSurface({
      session: { getCompactions: async () => [] } as never
    });

    expect(Object.keys(surface.toolApproval)).toEqual([]);
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
  /**
   * **Both types, and that is not symmetry for its own sake.** This registry is
   * what `RecipeSubagentBase` validates an inbound `request.type` against, so a
   * reading subtask reaching a facet that knows only the writing type is refused
   * with `unknown subtask type` before `executeChunk` runs.
   */
  it("registers both types and contributes no tool families", () => {
    const runtime = createAgentRuntime({
      config: CLAUDE_CODER_CONFIG,
      plugins: subagentPlugins(host())
    });

    expect(runtime.types.keys).toEqual([
      CLAUDE_CODE_TYPE,
      CLAUDE_CODE_READ_TYPE
    ]);
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

const request = (type: string = CLAUDE_CODE_TYPE): RecipeExecutionRequest => ({
  taskId: "task-1",
  subtaskId: 1,
  type,
  recipe: {
    key: type,
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
/**
 * Both types: one that misses this path runs core's own loop over its inert
 * recipe — one turn on the subagent model, no tools, and a report that is the
 * script it would have run. Failing with the sentences below is what proves it
 * took the session path.
 */
describe.each([
  ["writing", CLAUDE_CODE_TYPE],
  ["reading", CLAUDE_CODE_READ_TYPE]
])("executeChunk refuses to guess — %s", (_label, type) => {
  it("fails with a wiring sentence when no workspace reached it", async () => {
    const stub = freshSubagent(`no-workspace-${type}`);
    const outcome = await runInDurableObject(
      stub,
      (instance: ClaudeCoderSubagent) => instance.executeChunk(request(type), 0)
    );

    expect(outcome.done).toBe(true);
    expect(outcome).toMatchObject({
      result: { status: "failed", modelId: null }
    });
    if (outcome.done && outcome.result.status === "failed") {
      // Names the actual fault — the plugin belongs on the parent, where
      // `resolveRuntime` runs — rather than reporting a missing container.
      expect(outcome.result.error).toMatch(/must be installed on the parent/);
    } else {
      expect.unreachable("a subtask with no workspace must fail");
    }
  });

  it("fails with an ordering sentence when nothing has been cloned", async () => {
    // A real workspace, reachable and empty: `checkoutDir()` has nothing to
    // report because nothing has been opened in it. The refusal is correct here
    // and wrong for the case below, which is why the two are specified together.
    const workspace = freshWorkspace(`no-checkout-${type}`);
    const name = await runInDurableObject(workspace, (_i, state) =>
      state.id.toString()
    );

    const stub = freshSubagent(`no-checkout-${type}`);
    const outcome = await runInDurableObject(
      stub,
      (instance: ClaudeCoderSubagent) =>
        instance.executeChunk(request(type), 0, {
          [WORKSPACE_RUNTIME_KEY]: name
        })
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
 * The wiring that makes a session audible while it is still working.
 *
 * Core does the posting and has its own specs for it; the drain has its own for
 * the sink. What belongs here is the seam between them — the one line that can
 * silently undo both.
 *
 * `executeChunk` is overridden outright and never reaches `super`, which is
 * where the base normally arms the channel, so this class has to arm it itself.
 * Delete that line and nothing fails: the session runs, the work lands, and the
 * notes go nowhere. `abortRun` is overridden for the same reason and carries the
 * same obligation. There is no container in this pool, so both are observed
 * directly rather than through a drain.
 */
describe("a session's notes reach the gatekeeper while it works", () => {
  /** Drive one facet with its callback channel captured instead of posted. */
  const withCapturedChannel = async (
    fn: (
      instance: ClaudeCoderSubagent,
      posted: { text: string; key: string }[]
    ) => Promise<void>
  ) => {
    const stub = freshSubagent("live-progress");
    await runInDurableObject(stub, async (instance: ClaudeCoderSubagent) => {
      const posted: { text: string; key: string }[] = [];
      (instance as unknown as { pushChannel: () => unknown }).pushChannel =
        () => ({
          working: async (text: string, key: string) => {
            posted.push({ text, key });
          }
        });
      await fn(instance, posted);
    });
  };

  const push = {
    taskId: "task-1",
    contextId: "ctx-1",
    pushUrl: "https://gatekeeper.example/a2a/notifications",
    pushToken: "token",
    jku: "https://agent.example/.well-known/jwks.json"
  };

  it("arms the channel on a chunk that never reaches the base class", async () => {
    await withCapturedChannel(async (instance, posted) => {
      // A task of its own, because this spec settles its transcript.
      const taskId = crypto.randomUUID();
      // Fails on the wiring guard, which is fine: arming happens before every
      // early return, because a chunk that refuses still must not leave a
      // previous turn's channel behind it.
      await instance.executeChunk({ ...request(), taskId }, 0, {}, undefined, {
        push,
        ordinal: 3
      });

      await (
        instance as unknown as {
          postProgress: (e: { key: string; text: string }) => Promise<void>;
        }
      ).postProgress({ key: "claude:0", text: "reading the tree" });

      // The link, not the note. This chunk never reaches the base, where the
      // `selfOrigin` argument is read, so the origin has to come from arming.
      const artifacts = env.ARTIFACTS.get(
        env.ARTIFACTS.idFromName(ARTIFACTS_OBJECT_NAME)
      );
      const token = await artifacts.tokenFor(SESSION_TRANSCRIPT_KIND, taskId);
      const link = `${new URL(push.jku).origin}/a/${token}`;
      expect(posted).toEqual([{ text: link, key: "claude:0" }]);

      // The label is what tells a reader which branch is talking — the ordinal
      // comes from the parent's row, not from here. Settled first so the event
      // stream ends and the body can be read.
      await artifacts.settle(token!, "completed");
      const body = await (
        await artifacts.fetch(new Request(`${link}/events`))
      ).text();
      expect(body).toContain('"label":"claude-code 3"');
      expect(body).toContain('"text":"reading the tree"');
    });
  });

  it("stops posting when the session is canceled", async () => {
    await withCapturedChannel(async (instance, posted) => {
      await instance.executeChunk(request(), 0, {}, undefined, {
        push,
        ordinal: 0
      });
      await (
        instance as unknown as {
          postProgress: (e: { key: string; text: string }) => Promise<void>;
        }
      ).postProgress({ key: "claude:0", text: "before" });

      /**
       * The abort path this class overrides, holding no model call for the base
       * signal to stand in for.
       *
       * `onTaskCanceled` calls this and then waits for the drain to unwind,
       * which is up to a minute of a session taking its `SIGTERM`, running its
       * hooks and syncing its filesystem — and every note parsed in that minute
       * would be posted to a Task the user already canceled.
       */
      expect(await instance.abortRun()).toBe(false);
      await (
        instance as unknown as {
          postProgress: (e: { key: string; text: string }) => Promise<void>;
        }
      ).postProgress({ key: "claude:1", text: "after the cancel" });

      expect(posted.map((p) => p.key)).toEqual(["claude:0"]);
    });
  });

  it("clears it when a later chunk arrives without one", async () => {
    await withCapturedChannel(async (instance, posted) => {
      await instance.executeChunk(request(), 0, {}, undefined, {
        push,
        ordinal: 3
      });
      await instance.executeChunk(request(), 1, {}, undefined, undefined);

      await (
        instance as unknown as {
          postProgress: (e: { key: string; text: string }) => Promise<void>;
        }
      ).postProgress({ key: "claude:0", text: "leaked" });

      expect(posted).toEqual([]);
    });
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
 * A chunk step retried while the attempt it replaces is still draining. Core asks
 * that attempt to yield, and what it yields is the drain's window — the session
 * goes on. The drain itself needs a container, which this pool has none of; the
 * window ending on the signal is covered where the drain lives, in
 * `@dynamicagents/plugins/claude-code`.
 */
describe("a chunk replaced by a retry of itself", () => {
  it("has nothing to give back when no session is draining", async () => {
    const stub = freshSubagent("yield-idle");
    await expect(
      runInDurableObject(stub, (instance: ClaudeCoderSubagent) =>
        instance.yieldRun()
      )
    ).resolves.toBeUndefined();
  });
});

/**
 * A branch that failed at its step, or a cancel that found no drain in hand,
 * still has to stop the session: core calls `abortExecution` for both, and the
 * session it started is what is left running.
 */
describe("stopping a session nothing is draining", () => {
  it("does nothing for a facet that never started one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();
    const stub = freshSubagent("teardown-idle");

    await runInDurableObject(stub, (instance: ClaudeCoderSubagent) =>
      instance.abortExecution([])
    );

    expect(warn).not.toHaveBeenCalled();
  });

  it("reaches for the session it recorded, and never throws for it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();
    const stub = freshSubagent("teardown-recorded");

    await runInDurableObject(
      stub,
      async (instance: ClaudeCoderSubagent, state) => {
        await state.storage.put("claude-session", {
          name: "teardown-recorded",
          subtaskId: 1
        });
        // The suite reaches no container, so the stop fails exactly where a
        // dead one would — and a teardown still has to finish.
        await instance.abortExecution([]);
      }
    );

    expect(warn).toHaveBeenCalledWith(
      "[claude-coder] could not stop the session on teardown",
      expect.anything()
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
  const withPrompt = (
    over: Partial<RecipeExecutionRequest> = {}
  ): RecipeExecutionRequest => ({ ...request(), ...over });

  it("carries what the container holds, when there is nothing else to add", () => {
    const brief = sessionBrief(withPrompt());

    expect(brief.startsWith("add a --json flag")).toBe(true);
    // Unconditional, because it is true of every session: a model reaches for
    // `gh` unprompted, this one is authenticated as nobody, and neither "it is
    // missing" nor "it is signed in" is what it will assume. Discovering the
    // difference by failing costs a turn each time.
    expect(brief).toContain("`gh` in this container");
    expect(brief).toContain("authenticated as nobody");
    // …and who does hold the credential, or the session tries to route around
    // the boundary rather than reporting back through it.
    expect(brief).toContain("belong to the agent");
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

describe("the branch a writing session is told about", () => {
  it("names the submodules, and says to commit inside each one", () => {
    const brief = sessionBrief(request(), undefined, {
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
    const brief = sessionBrief(request(), undefined, {
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
    const brief = sessionBrief(request(), undefined, {
      branch: "claude-coder/task-1/1",
      submodules: [],
      continues: true
    });

    expect(brief).toMatch(/already holds earlier work:/);
  });

  /** A reading session's copy is deleted, so asking it to commit wastes it. */
  it("says nothing about a branch to a reading session", () => {
    expect(sessionBrief(request(CLAUDE_CODE_READ_TYPE))).not.toContain(
      "## Your branch"
    );
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

  it("calls a lone checkout the repository, and bounds a long list", () => {
    const files = Array.from({ length: 15 }, (_, i) => `f${i}`);
    const prompt = warningPrompt([{ path: ".", files }]);

    expect(prompt).toContain("- the repository: `f0`");
    expect(prompt).toContain("and 3 more");
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
    const config = claudeCodeConfig(
      env as never,
      noWorkspaceRouting("a credential spec routes nothing")
    );

    // A misspelled binding reads as `undefined` and is filtered out, so a
    // missing entry fails here rather than at the first 429.
    expect(config.credentials()).toEqual([
      env.CLAUDE_CODE_OAUTH_TOKEN_1,
      env.CLAUDE_CODE_OAUTH_TOKEN_2,
      env.CLAUDE_CODE_OAUTH_TOKEN_3
    ]);
  });

  it("drops an unset entry instead of offering an empty credential", () => {
    const config = claudeCodeConfig(
      {
        CLAUDE_CODE_OAUTH_TOKEN_1: "sk-ant-oat01-one",
        CLAUDE_CODE_OAUTH_TOKEN_2: "",
        CLAUDE_CODE_OAUTH_TOKEN_3: "sk-ant-oat01-three"
      } as never,
      noWorkspaceRouting("a credential spec routes nothing")
    );

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
    const config = claudeCodeConfig(
      env as never,
      noWorkspaceRouting("a credential spec routes nothing")
    );

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
    const config = claudeCodeConfig(
      env as never,
      noWorkspaceRouting("a credential spec routes nothing")
    );

    expect(config.env?.GH_TOKEN).toBe(GH_TOKEN_PLACEHOLDER);
  });

  it("tells the session which gh commands can work at all", () => {
    const brief = sessionBrief({
      prompt: "look at the issue",
      references: []
    } as never);

    // GitHub gives anonymous callers a GraphQL quota of zero, so the high-level
    // commands a model reaches for first are the ones that cannot work.
    expect(brief).toContain("gh api repos/");
    expect(brief).toContain("GraphQL");
  });
});

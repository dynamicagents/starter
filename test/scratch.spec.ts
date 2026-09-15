import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { makeDoHelpers } from "@dynamicagents/core/testing";
import type { CoderWorkspaceDO } from "@/index";
import { openWorkspace } from "@/workspace/open";
import { createAgentRuntime } from "@dynamicagents/core";
import { SCRATCH_OPEN_TOOL } from "@dynamicagents/plugins/scratch";
import { CODER_CONFIG } from "@/config";
import type { ActiveRepo } from "@/workspace/active-repo";
import { workspaceName } from "@/workspace/object";
import { hostScratch, SCRATCH_DIR, SCRATCH_REPO } from "@/workspace/scratch";

/**
 * The scratchpad's **host half**, and only that.
 *
 * What a scratchpad is — the `git init`, the empty initial commit, the reset,
 * the unreachable-container seam, the words the model reads — belongs to
 * `@dynamicagents/plugins/scratch` and is specified there, against a fake shell.
 * Re-asserting it here would be testing somebody else's package through two
 * layers of ours.
 *
 * What is left is the part the plugin cannot know and this file exists for:
 * **which Durable Object a scratchpad lands in, and what records that it
 * exists.** Both are answered by hooks, so both are testable without a
 * container — which is just as well, since the pool cannot start one.
 */

const { freshStub: freshWorkspace } = makeDoHelpers<CoderWorkspaceDO>(
  env.CODER_WORKSPACE
);

/** `ActiveRepo` over two variables — the same contract, without the SQLite. */
function fakeActive(): ActiveRepo {
  let current: string | undefined;
  const seen: string[] = [];
  return {
    get: () => current,
    set: (repo) => {
      current = repo;
      if (!seen.includes(repo)) seen.push(repo);
    },
    seen: () => [...seen],
    forget: (repo) => {
      const at = seen.indexOf(repo);
      if (at >= 0) seen.splice(at, 1);
    }
  };
}

/** A shell that records what it was asked and reports success. */
function fakeExec() {
  const commands: string[] = [];
  const exec = async (command: string) => {
    commands.push(command);
    return { success: true, stdout: "", stderr: "", exitCode: 0 };
  };
  return { exec, commands };
}

const AUTHOR = { name: "da-coder", email: "coder@example.test" };

/** Build the plugin and call its one tool, as the runtime would. */
async function open(
  config: Parameters<typeof hostScratch>[0]
): Promise<string> {
  const runtime = createAgentRuntime({
    config: CODER_CONFIG,
    plugins: [hostScratch(config)]
  });
  const tools = await runtime.mainAgentTools({
    session: { getCompactions: async () => [] } as never
  });
  const execute = tools[SCRATCH_OPEN_TOOL]!.execute as (
    input: unknown,
    options: unknown
  ) => Promise<string>;
  return String(await execute({}, {}));
}

/** A workspace with a scratchpad on disk, as `git init` would leave it. */
async function seedScratch(stub: DurableObjectStub<CoderWorkspaceDO>) {
  using ws = await openWorkspace(stub);
  await ws.fs.mkdir(`${SCRATCH_DIR}/.git`, { recursive: true });
  await ws.fs.writeFile(`${SCRATCH_DIR}/.git/HEAD`, "ref: refs/heads/main\n");
}

describe("where a scratchpad lands", () => {
  /**
   * The selection is the routing decision, and it has to land before any command
   * runs — `exec` and the workspace stub both resolve through it, so a command
   * issued first would run in whichever workspace the last task left open. The
   * same ordering `repo_clone` gets from `beforeCheckout`.
   *
   * The enrolment is the lifecycle half, and it is why this goes through
   * `active.set()` rather than naming a workspace some other way.
   * `sweepIdleWorkspaces` walks `seen()`, so a workspace that never passes
   * through here has no backstop at all — which is the state the accidental
   * `<unassigned>` workspace is in. Going through the same door as a clone gives
   * a scratchpad the seven-day reclaim every checkout already has, with no second
   * mechanism to maintain.
   */
  it("selects the scratchpad workspace and enrols it for reclaim", async () => {
    const stub = freshWorkspace("scratch-select");
    await seedScratch(stub);
    const active = fakeActive();
    const { exec } = fakeExec();

    await open({ exec, workspace: () => stub, active, author: AUTHOR });

    expect(active.get()).toBe(SCRATCH_REPO);
    // What the weekly sweep will walk, and the name it resolves to.
    expect(active.seen()).toContain(SCRATCH_REPO);
    expect(workspaceName("caller", SCRATCH_REPO)).toBe("caller|<scratch>");
  });

  /**
   * The test that cannot exist in the plugin: it is the *workspace object* that
   * has to end up holding the record, and only this side knows which object that
   * is.
   *
   * It is also the reason the scratchpad could not have shipped before the
   * checkout record. `checkoutDir()` answers from that record, and a scratchpad
   * has no install to write one as a side effect — a directory with no
   * `package.json` is precisely what the install resolver skips. The feature is a
   * live assertion of that fix.
   */
  it("records the scratchpad where a delegation will look for it", async () => {
    const stub = freshWorkspace("scratch-record");
    await seedScratch(stub);
    const { exec } = fakeExec();

    const said = await open({
      exec,
      workspace: () => stub,
      active: fakeActive(),
      author: AUTHOR
    });

    expect(await stub.checkoutDir()).toBe(SCRATCH_DIR);
    expect(said).toContain("scratchpad");
    expect(said).not.toContain("not usable yet");
  });

  /**
   * The failure mode this whole change is about: a tool reporting success and a
   * delegation then refusing, in two different places, with nothing connecting
   * them. The hook runs the same probe the delegation will, so the disagreement
   * surfaces in a result the model can act on — or not at all.
   */
  it("reports a scratchpad the workspace cannot see", async () => {
    // No `.git` seeded, so the workspace's probe finds nothing.
    const stub = freshWorkspace("scratch-invisible");
    const { exec } = fakeExec();

    const said = await open({
      exec,
      workspace: () => stub,
      active: fakeActive(),
      author: AUTHOR
    });

    expect(said).toContain("not usable yet");
    expect(said).toContain("the workspace cannot see it yet");
    expect(said).toContain(`Call ${SCRATCH_OPEN_TOOL} again`);
  });
});

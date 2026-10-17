import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { PluginContext } from "@dynamicagents/core";
import { sandboxName } from "@dynamicagents/plugins/sandbox";
import { SCRATCH_OPEN_TOOL } from "@dynamicagents/plugins/scratch";
import type { ActiveCheckout, ActiveRepo } from "@/workspace/active-repo";
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

/** `ActiveRepo` over two variables — the same contract, without the SQLite. */
function fakeActive(): ActiveRepo {
  let current: string | undefined;
  const seen: string[] = [];
  let checkout: ActiveCheckout | undefined;
  const note = (repo: string) => {
    if (!seen.includes(repo)) seen.push(repo);
  };
  return {
    get: () => current,
    set: (repo) => {
      current = repo;
      note(repo);
    },
    checkout: () => checkout,
    setCheckout: (next) => {
      checkout = next;
    },
    checkoutOf: () => undefined,
    submodulesOf: () => [],
    rootOf: (repo) => repo,
    note,
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

/** What an agent hands its plugins, enough of it for this one. */
const CONTEXT = {
  env,
  storage: undefined as unknown as DurableObjectStorage,
  agentName: "caller",
  callerKey: () => "caller",
  workspace: () => {
    throw new Error("the scratch plugin reads no Think workspace");
  },
  runtime: () => undefined
} as unknown as PluginContext<Env>;

/** Build the plugin and call its one tool, as a turn would. */
async function open(
  config: Parameters<typeof hostScratch>[0]
): Promise<string> {
  const tools = hostScratch(config).tools!(CONTEXT);
  const execute = tools[SCRATCH_OPEN_TOOL]!.execute as (
    input: unknown,
    options: unknown
  ) => Promise<string>;
  return String(await execute({}, { toolCallId: "call-1", messages: [] }));
}

/**
 * A sandbox as the hook sees it: `present` is what its probe of the recorded
 * directory answers, and `records` every checkout it was asked to note.
 */
function fakeSandbox(present: boolean) {
  const records: { dir: string; kind: "scratch" }[] = [];
  return {
    records,
    noteCheckout: async (record: { dir: string; kind: "scratch" }) => {
      records.push(record);
      return { present };
    }
  };
}

describe("where a scratchpad lands", () => {
  /**
   * The selection is the routing decision, and it has to land before any command
   * runs — `exec` and the sandbox stub both resolve through it, so a command
   * issued first would run in whichever sandbox the last task left open. The
   * same ordering `repo_clone` gets from `beforeCheckout`.
   *
   * The enrolment is the lifecycle half, and it is why this goes through
   * `active.set()` rather than naming a sandbox some other way.
   * `sweepIdleWorkspaces` walks `seen()`, so a sandbox that never passes
   * through here has no backstop at all — which is the state the accidental
   * `<unassigned>` sandbox is in. Going through the same door as a clone gives
   * a scratchpad the seven-day reclaim every checkout already has, with no second
   * mechanism to maintain.
   */
  it("selects the scratchpad's sandbox and enrols it for reclaim", async () => {
    const sandbox = fakeSandbox(true);
    const active = fakeActive();
    const { exec } = fakeExec();

    await open({ exec, workspace: () => sandbox, active, author: AUTHOR });

    expect(active.get()).toBe(SCRATCH_REPO);
    // What the weekly sweep will walk, and the name it resolves to.
    expect(active.seen()).toContain(SCRATCH_REPO);
    expect(sandboxName("caller", SCRATCH_REPO)).toBe("caller|<scratch>");
  });

  /**
   * The test that cannot exist in the plugin: it is the *sandbox* that
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
    const sandbox = fakeSandbox(true);
    const { exec } = fakeExec();

    const said = await open({
      exec,
      workspace: () => sandbox,
      active: fakeActive(),
      author: AUTHOR
    });

    expect(sandbox.records).toEqual([{ dir: SCRATCH_DIR, kind: "scratch" }]);
    expect(said).toContain("scratchpad");
    expect(said).not.toContain("not usable yet");
  });

  /**
   * The failure mode this whole change is about: a tool reporting success and a
   * delegation then refusing, in two different places, with nothing connecting
   * them. The hook runs the same probe the delegation will, so the disagreement
   * surfaces in a result the model can act on — or not at all.
   */
  it("reports a scratchpad the sandbox cannot see", async () => {
    const sandbox = fakeSandbox(false);
    const { exec } = fakeExec();

    const said = await open({
      exec,
      workspace: () => sandbox,
      active: fakeActive(),
      author: AUTHOR
    });

    expect(said).toContain("not usable yet");
    expect(said).toContain("the sandbox cannot see it yet");
    expect(said).toContain(`Call ${SCRATCH_OPEN_TOOL} again`);
  });
});

import { describe, expect, it } from "vitest";
import type { Workspace } from "@cloudflare/computer";
import type { Deadline } from "@dynamicagents/core/alarm";
import {
  SYNC_DRAIN_MAX_BACKOFF_MS,
  SYNC_DRAIN_RESUME_MS,
  WorkspaceSync,
  syncRetryDelayMs,
  type SyncDrainIntent
} from "@/workspace/sync";

/**
 * The host's half of syncing, against a pull it controls.
 *
 * A unit test rather than a workspace one, and that is what the seam is for: the
 * outcomes that matter here are a pull that throws and a pull that runs long,
 * neither of which a real container produces on demand. `WorkspaceSync` takes
 * its workspace as a thunk, so both are three lines of fake.
 */

/** A block, shaped as the library yields them. Only two fields are read. */
const block = (complete: boolean, entries = 0) =>
  ({ complete, entries }) as never;

function fakeWorkspace(pull: () => AsyncIterable<never>): () => Workspace {
  return () => ({ pull }) as unknown as Workspace;
}

/** Records what was scheduled, so a backoff can be asserted as a delay. */
function recordingDeadline() {
  const set: Array<{ when: Date; payload?: SyncDrainIntent }> = [];
  const deadline = {
    set: async (when: Date, payload?: SyncDrainIntent) => {
      set.push({ when, payload });
      return undefined as never;
    },
    get: async () => undefined,
    clear: async () => {}
  } as unknown as Deadline<SyncDrainIntent | undefined>;
  return { deadline, set };
}

function sync(
  pull: () => AsyncIterable<never>,
  options: { running?: boolean } = {}
) {
  const { deadline, set } = recordingDeadline();
  const ws = new WorkspaceSync({
    workspace: fakeWorkspace(pull),
    containerRunning: () => options.running ?? true,
    deadline: () => deadline,
    tag: () => "test-workspace",
    id: () => "test-id"
  });
  return { ws, set };
}

async function* oneBlock(): AsyncIterable<never> {
  yield block(true, 3);
}

describe("draining an outstanding pull", () => {
  it("reports a pull that reached the end as complete", async () => {
    const { ws } = sync(() => oneBlock());
    expect(await ws.drain(60_000)).toBe("complete");
  });

  /**
   * A container that is not running is not a failure: there is nothing to pull
   * from, and nothing that could still be recovered from it. Opening a handle
   * would *start* one, which on the idle path restarts the container the
   * deadline just decided to stop.
   */
  it("reports nothing reachable without touching the workspace", async () => {
    let opened = false;
    const { ws } = sync(
      () => {
        opened = true;
        return oneBlock();
      },
      { running: false }
    );

    expect(await ws.drain(60_000)).toBe("unavailable");
    expect(opened).toBe(false);
  });

  /**
   * The distinction the retry policy rests on. A drain that ran out of budget
   * has moved its cursor and should come straight back; one that threw has
   * nothing to show and must not.
   */
  it("tells a budget that ran out apart from a pull that threw", async () => {
    async function* forever(): AsyncIterable<never> {
      for (;;) yield block(false, 1);
    }
    const { ws: budgeted } = sync(() => forever());
    expect(await budgeted.drain(0)).toBe("incomplete");

    async function* throws(): AsyncIterable<never> {
      yield block(false, 1);
      throw new Error("the container stopped answering");
    }
    const { ws: broken } = sync(() => throws());
    expect(await broken.drain(60_000)).toBe("failed");
  });
});

/**
 * Backing off after a failure, because the alternative is an alarm and an error
 * line every second for as long as the workspace stays up — whatever broke is
 * usually still broken a second later.
 */
describe("the retry delay", () => {
  it("starts at the resume interval and doubles", () => {
    expect(syncRetryDelayMs(0)).toBe(SYNC_DRAIN_RESUME_MS);
    expect(syncRetryDelayMs(1)).toBe(SYNC_DRAIN_RESUME_MS * 2);
    expect(syncRetryDelayMs(4)).toBe(SYNC_DRAIN_RESUME_MS * 16);
  });

  it("stops growing at the ceiling rather than running away", () => {
    expect(syncRetryDelayMs(100)).toBe(SYNC_DRAIN_MAX_BACKOFF_MS);
  });

  /**
   * The count rides on the schedule rather than in memory: the object does not
   * survive between wake-ups, so a counter held here would reset every time and
   * the backoff would never leave its first step.
   */
  it("carries the attempt on the schedule it arms", async () => {
    const { ws, set } = sync(() => oneBlock());

    await ws.arm(3);

    expect(set).toHaveLength(1);
    expect(set[0]!.payload).toEqual({ attempt: 3 });
    expect(set[0]!.when.getTime()).toBeGreaterThan(
      Date.now() + syncRetryDelayMs(3) - 1_000
    );
  });
});

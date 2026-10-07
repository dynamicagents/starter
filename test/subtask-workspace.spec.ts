import { describe, it, expect, vi } from "vitest";
import {
  parseGitmodules,
  readSubmodules,
  submoduleCloneUrl,
  subtaskWorkspaces,
  type SessionPlace
} from "@/workspace/subtask-workspace";
import { SCRATCH_REPO } from "@/workspace/scratch";
import {
  isFree,
  runBranch,
  worktreeRepo,
  type Worktree
} from "@/workspace/worktree-pool";
import type { ActiveCheckout, ActiveRepo } from "@/workspace/active-repo";
import { memoryPoolStore } from "./support/memory-pool";

/** `ActiveRepo` over three variables — the same contract, without the SQLite. */
function fakeActive(
  selected?: string,
  checkout?: ActiveCheckout
): ActiveRepo & { noted: string[]; forgotten: string[] } {
  const noted: string[] = [];
  const forgotten: string[] = [];
  return {
    noted,
    forgotten,
    get: () => selected,
    set: (repo) => {
      selected = repo;
    },
    checkout: () => checkout,
    setCheckout: (next) => {
      checkout = next;
    },
    note: (repo) => noted.push(repo),
    seen: () => [...noted],
    forget: (repo) => forgotten.push(repo)
  };
}

const CHECKOUT: ActiveCheckout = {
  url: "https://github.com/acme/api.git",
  dir: "/workspace/api",
  branch: "main"
};

/** A commit id a spec can read: what the branch script resolved `ref` to. */
const sha = (ref: string) => `sha(${ref})`;

/** `.gitmodules` as `git config --null --get-regexp` prints it. */
const gitmodules = (entries: Record<string, string>) =>
  Object.entries(entries)
    .map(([key, value]) => `${key}\n${value}\0`)
    .join("");

/**
 * Enough of the workspace RPC surface and a container for the pool to run
 * against. Every workspace shares one fake: which one a call reached is in the
 * name `exec` was handed, and the RPCs do not need to know.
 */
function harness(opts: {
  selected?: string;
  checkout?: ActiveCheckout;
  /** Where a worktree already has a checkout, by workspace name. */
  dirs?: Record<string, string>;
  /** What `.gitmodules` declares, in `--null` form. */
  submodules?: string;
  /** Submodule paths a previous attempt already cloned. */
  populated?: string[];
  /** Fail every clone whose target ends with this. */
  cloneFails?: { dir: string; message: string };
  /** Each repository's HEAD when release reads it. */
  tips?: Record<string, string>;
  /** Throw when release reads the tips. */
  tipsThrow?: boolean;
  /** Each repository's remote-tracking branch when release reads it: a session's own push. */
  pushed?: Record<string, string>;
  /** Repositories whose remote has the branch being placed. */
  remote?: string[];
  /** Refuse every session at admission. */
  refuse?: boolean;
  /** What keeping a failed run's work leaves each repository's HEAD at. */
  kept?: Record<string, { head: string; wip?: boolean }>;
  /**
   * Fail the commit that keeps it. Every repository's HEAD is still reported,
   * as the script reports them: it carries on past a repository that failed and
   * exits non-zero at the end.
   */
  keepFails?: boolean;
  /** Throw from the command that keeps it: the container is unreachable. */
  keepThrows?: boolean;
  /** Throw from stopping the session. */
  stopThrows?: boolean;
  /**
   * The parent has a dependency snapshot, and whether a worktree takes it — per
   * offer, in order, the last answer repeating.
   */
  snapshot?: { seeded: boolean[] };
  /** Refuse to release a container, as one with an install running does. */
  releaseRefused?: boolean;
}) {
  const calls: string[] = [];
  let cloneFails = opts.cloneFails;
  const dirs = { ...(opts.dirs ?? {}) };
  const pool = memoryPoolStore();
  const active = fakeActive(opts.selected, opts.checkout);
  const placed: Record<string, string>[] = [];
  const keeps: { cwd: string; env: Record<string, string> }[] = [];
  const stopped: string[] = [];
  const admitted: string[] = [];
  const released: string[] = [];
  /** Seeding, releasing and installing, in the order they reached a workspace. */
  const events: string[] = [];
  let current = "";
  const stub = {
    releaseContainer: async () => {
      released.push(current);
      events.push(`release ${current}`);
      return { released: !opts.releaseRefused };
    },
    depsSnapshot: async () =>
      opts.snapshot ? { id: "snap-1", from: current } : undefined,
    seedDepsSnapshot: async (record: { from: string }) => {
      events.push(`seed ${current} from ${record.from}`);
      const answers = opts.snapshot?.seeded ?? [];
      return { seeded: answers.shift() ?? false };
    },
    checkoutDir: async () => dirs[current],
    advisories: async () => [],
    gitClone: async (req: { dir: string; branch?: string }) => {
      calls.push(`clone ${req.dir}@${req.branch ?? ""}`);
      if (cloneFails && req.dir.endsWith(cloneFails.dir)) {
        return { ok: false as const, message: cloneFails.message };
      }
      if (req.dir === (opts.checkout ?? CHECKOUT).dir) dirs[current] = req.dir;
      return { ok: true as const, detail: "cloned" };
    },
    gitFetch: async (req: { dir: string }) => {
      calls.push(`fetch ${req.dir}`);
      events.push(`fetch ${current}`);
      return { ok: true as const, detail: "fetched" };
    },
    noteCheckout: async () => {
      calls.push("noteCheckout");
      return { present: true };
    },
    startInstall: async () => {
      calls.push("startInstall");
      events.push(`install ${current}`);
      return {};
    }
  };
  const binding = {
    idFromName: (name: string) => name,
    get: (name: string) => {
      current = name;
      return stub;
    }
  } as unknown as Parameters<typeof subtaskWorkspaces>[0]["binding"];

  const subtasks = subtaskWorkspaces({
    binding,
    callerKey: () => "caller",
    exec: async (command, options, workspace) => {
      current = workspace;
      const env = options.env ?? {};
      // In the same list as the clones, because its place relative to them is
      // the point: cleared before a clone, never after one.
      if (command.includes('rm -rf "$CHECKOUT_DIR"')) {
        calls.push(`clear ${env.CHECKOUT_DIR}`);
      }
      if (command.includes(".gitmodules")) {
        // No match exits 1 with nothing said, which is how git reports a
        // checkout without submodules.
        return opts.submodules
          ? { success: true, stdout: opts.submodules, stderr: "" }
          : { success: false, stdout: "", stderr: "" };
      }
      if (command.includes("SUBMODULE_PATHS")) {
        return {
          success: true,
          stdout: (opts.populated ?? []).map((p) => `${p}\n`).join(""),
          stderr: ""
        };
      }
      if (command.includes("WORKTREE_MODE")) {
        placed.push(env);
        calls.push(`place ${env.WORKTREE_MODE}`);
        const rows = (env.WORKTREE_REPOS ?? "")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [path, base] = line.split("\t");
            const pushed = opts.remote?.includes(path!)
              ? sha(`origin/${env.WORKTREE_BRANCH}`)
              : "";
            return `${path}\t${sha(base!)}\t${sha(base!)}\t${pushed}`;
          });
        return { success: true, stdout: rows.join("\n"), stderr: "" };
      }
      if (command.includes("WORKTREE_KEEP_PATHS")) {
        if (opts.keepThrows) throw new Error("container unreachable");
        keeps.push({ cwd: options.cwd, env });
        const paths = (env.WORKTREE_KEEP_PATHS ?? "").split("\n");
        calls.push(`keep ${paths.join(",")}`);
        const rows = paths.map((path) => {
          const kept = opts.kept?.[path];
          return `${path}\t${kept?.head ?? ""}\t${kept?.wip ? "wip" : ""}`;
        });
        return {
          success: !opts.keepFails,
          stdout: rows.join("\n"),
          stderr: opts.keepFails ? "index.lock" : ""
        };
      }
      if (command.includes("WORKTREE_PATHS")) {
        if (opts.tipsThrow) throw new Error("container unreachable");
        const rows = (env.WORKTREE_PATHS ?? "")
          .split("\n")
          .map(
            (path) =>
              `${path}\t${opts.tips?.[path] ?? ""}\t${opts.pushed?.[path] ?? ""}`
          );
        return { success: true, stdout: rows.join("\n"), stderr: "" };
      }
      return { success: true, stdout: "", stderr: "" };
    },
    stopSession: async (workspace, runId) => {
      stopped.push(`${workspace}#${runId}`);
      if (opts.stopThrows) throw new Error("session unreachable");
    },
    admit: async (workspace) => {
      admitted.push(workspace);
      if (opts.refuse) throw new Error("no credential can pay for it");
    },
    active,
    pool,
    label: "test",
    now: () => 1000
  });
  /** Let clones succeed again, as a retry after a network failure would. */
  const heal = () => {
    cloneFails = undefined;
  };
  return {
    subtasks,
    calls,
    pool,
    active,
    placed,
    keeps,
    stopped,
    admitted,
    released,
    events,
    heal
  };
}

const ctx = { taskId: "task-a", runId: "detached:1" };
/** The branches `ctx`'s run and the task's second run start. */
const BRANCH_1 = runBranch(ctx);
const BRANCH_2 = runBranch({ ...ctx, runId: "detached:2" });

/** The workspace a session is handed, which is what most specs are about. */
const nameOf = async (place: Promise<SessionPlace>) =>
  (await place).workspaceName;
const SLOT0 = `caller|${worktreeRepo("acme/api", 0)}`;
const SLOT1 = `caller|${worktreeRepo("acme/api", 1)}`;

describe("preparing a worktree for a writing session", () => {
  it("starts from the parent's dependency snapshot when the worktree takes it", async () => {
    const { subtasks, events } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      snapshot: { seeded: [true] }
    });

    await subtasks.resolve(ctx);

    // Offered once the checkout is there to check it against, and released
    // before the install, whose start is the cold one a snapshot restores into.
    expect(events).toEqual([
      `fetch ${SLOT0}`,
      `seed ${SLOT0} from caller|acme/api`,
      `release ${SLOT0}`,
      `install ${SLOT0}`
    ]);
  });

  it("offers a reused worktree the snapshot before its fetch starts the container", async () => {
    const { subtasks, events } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      dirs: { [SLOT0]: CHECKOUT.dir },
      // Taken before the fetch; the later offer finds its own snapshot fits.
      snapshot: { seeded: [true, false] }
    });

    await subtasks.resolve(ctx);

    expect(events).toEqual([
      `seed ${SLOT0} from caller|acme/api`,
      `fetch ${SLOT0}`,
      `seed ${SLOT0} from caller|acme/api`,
      `install ${SLOT0}`
    ]);
  });

  it("installs in the container it has when the release is refused", async () => {
    const { subtasks, events } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      snapshot: { seeded: [true] },
      releaseRefused: true
    });

    await subtasks.resolve(ctx);

    expect(events).toEqual([
      `fetch ${SLOT0}`,
      `seed ${SLOT0} from caller|acme/api`,
      `release ${SLOT0}`,
      `install ${SLOT0}`
    ]);
  });

  it("keeps the container it started when the worktree does not take it", async () => {
    const { subtasks, events } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      snapshot: { seeded: [false] }
    });

    await subtasks.resolve(ctx);

    expect(events).toEqual([
      `fetch ${SLOT0}`,
      `seed ${SLOT0} from caller|acme/api`,
      `install ${SLOT0}`
    ]);
  });

  it("clones, fetches, puts it on the branch and installs", async () => {
    const { subtasks, calls, pool, active, placed } = harness({
      selected: "acme/api",
      checkout: CHECKOUT
    });

    expect(await nameOf(subtasks.resolve(ctx))).toBe(SLOT0);
    expect(calls).toEqual([
      `clear ${CHECKOUT.dir}`,
      `clone ${CHECKOUT.dir}@main`,
      // Recorded straight after the clone, so a retry that fails later does not
      // clone over it.
      "noteCheckout",
      `fetch ${CHECKOUT.dir}`,
      "place new",
      "startInstall"
    ]);
    // The branch and the base reach git as values, never as command text.
    expect(placed[0]).toMatchObject({
      WORKTREE_BRANCH: BRANCH_1,
      WORKTREE_MODE: "new",
      WORKTREE_REPOS: ".\torigin/main"
    });
    expect(pool.rows()).toEqual([
      {
        repo: "acme/api",
        slot: 0,
        branch: BRANCH_1,
        live: ctx,
        mode: "new",
        ready: true,
        dir: CHECKOUT.dir,
        usedAt: 1000,
        repos: [
          {
            path: ".",
            url: CHECKOUT.url,
            baseRef: "origin/main",
            base: sha("origin/main"),
            start: sha("origin/main"),
            tip: sha("origin/main")
          }
        ]
      } satisfies Worktree
    ]);
    // Enrolled for the weekly sweep without routing the parent's tools to it.
    expect(active.noted).toEqual([worktreeRepo("acme/api", 0)]);
    expect(active.get()).toBe("acme/api");
  });

  it("asks the worktree it claimed before cloning into it", async () => {
    const { subtasks, calls, admitted } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      refuse: true
    });

    await expect(subtasks.resolve(ctx)).rejects.toThrow(/no credential/);
    expect(admitted).toEqual([SLOT0]);
    expect(calls).toEqual([]);
  });

  /** A repeated `prepare` for one run must not redo anything. */
  it("answers the same worktree every time for one run, preparing it once", async () => {
    const { subtasks, calls } = harness({
      selected: "acme/api",
      checkout: CHECKOUT
    });

    await subtasks.resolve(ctx);
    const before = calls.length;
    expect(await nameOf(subtasks.resolve(ctx))).toBe(SLOT0);
    expect(calls).toHaveLength(before);
  });

  it("gives concurrent sessions separate worktrees", async () => {
    const { subtasks } = harness({ selected: "acme/api", checkout: CHECKOUT });

    await subtasks.resolve(ctx);
    expect(
      await nameOf(subtasks.resolve({ ...ctx, runId: "detached:2" }))
    ).toBe(SLOT1);
  });

  /** The retry case: `ready` is only set once every step has finished. */
  it("finishes a preparation a previous attempt left half-done", async () => {
    const first = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      submodules: gitmodules({
        "submodule.core.path": "core",
        "submodule.core.url": "../core.git"
      }),
      cloneFails: { dir: "/core", message: "network" }
    });
    await expect(first.subtasks.resolve(ctx)).rejects.toThrow(
      /could not clone the submodule at core: network/
    );
    expect(first.pool.rows()[0]?.ready).toBe(false);

    first.heal();
    first.calls.length = 0;
    expect(await nameOf(first.subtasks.resolve(ctx))).toBe(SLOT0);
    // The superproject is there, so only what failed is cloned.
    expect(first.calls.filter((call) => call.startsWith("clone "))).toEqual([
      `clone ${CHECKOUT.dir}/core@`
    ]);
    expect(first.pool.rows()[0]?.ready).toBe(true);
  });

  it("names the branch it could not clone", async () => {
    const { subtasks } = harness({
      selected: "acme/api",
      checkout: { ...CHECKOUT, branch: "pins/local-only" },
      cloneFails: {
        dir: CHECKOUT.dir,
        message: "git fetch failed: Could not find pins/local-only."
      }
    });

    await expect(subtasks.resolve(ctx)).rejects.toThrow(
      /could not clone https:\/\/github\.com\/acme\/api\.git at pins\/local-only into a worktree: git fetch failed/
    );
  });

  /**
   * A scratchpad has no remote, so there is nothing to clone and no isolation to
   * provide. What must not happen is cloning the repository that was selected
   * *before* `scratch_open` ran, which `checkout()` still remembers.
   */
  it("hands a scratchpad session the parent's own workspace", async () => {
    const { subtasks, calls } = harness({
      selected: SCRATCH_REPO,
      checkout: CHECKOUT,
      dirs: { [`caller|${SCRATCH_REPO}`]: "/workspace/scratch" }
    });

    expect(await subtasks.resolve(ctx)).toEqual({
      workspaceName: `caller|${SCRATCH_REPO}`,
      dir: "/workspace/scratch"
    });
    expect(calls).toEqual([]);
  });

  it("refuses a scratchpad the workspace cannot see, before claiming anything", async () => {
    const { subtasks, pool } = harness({
      selected: SCRATCH_REPO,
      checkout: CHECKOUT
    });

    await expect(subtasks.resolve(ctx)).rejects.toThrow(
      /Clone a repository with `repo_clone`, or open a scratchpad/
    );
    expect(pool.every()).toEqual([]);
  });

  it("delegates from the repository's pool while the parent is in one of its worktrees", async () => {
    const { subtasks } = harness({
      selected: worktreeRepo("acme/api", 4),
      checkout: CHECKOUT
    });

    expect(await nameOf(subtasks.resolve(ctx))).toBe(SLOT0);
  });

  /**
   * Better than cloning a guess — and the sentence names the refusal that leaves
   * a checkout on disk unrecorded, because an agent looking at that checkout
   * will not believe "nothing was cloned".
   */
  it("refuses when no checkout was recorded, and says how one is", async () => {
    const { subtasks } = harness({ selected: "acme/api" });

    await expect(subtasks.resolve(ctx)).rejects.toThrow(
      /no recorded checkout.*records one only when it leaves a clean tree/s
    );
  });
});

describe("handing a worktree to the next session", () => {
  it("resets a free worktree onto the new branch, without cloning", async () => {
    const { subtasks, calls, placed } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      // Released with nothing past its base.
      tips: { ".": sha("origin/main") }
    });
    await subtasks.resolve(ctx);
    await subtasks.release(ctx);
    calls.length = 0;

    expect(
      await nameOf(subtasks.resolve({ ...ctx, runId: "detached:2" }))
    ).toBe(SLOT0);
    expect(calls).not.toContain(`clone ${CHECKOUT.dir}@main`);
    expect(calls).toEqual([
      "noteCheckout",
      `fetch ${CHECKOUT.dir}`,
      "place new",
      "startInstall"
    ]);
    // The branch it held is deleted as it moves on.
    expect(placed[1]).toMatchObject({
      WORKTREE_BRANCH: BRANCH_2,
      WORKTREE_PREVIOUS: BRANCH_1
    });
  });

  it("keeps a worktree with unpushed commits for its branch", async () => {
    const { subtasks, pool } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      tips: { ".": "c1" }
    });
    await subtasks.resolve(ctx);
    await subtasks.release(ctx);

    expect(pool.rows()[0]).toMatchObject({
      branch: BRANCH_1,
      repos: [{ path: ".", tip: "c1" }]
    });
    expect(pool.rows()[0]?.live).toBeUndefined();
    expect(
      await nameOf(subtasks.resolve({ ...ctx, runId: "detached:2" }))
    ).toBe(SLOT1);
  });

  /** A session pushes its own branch; git's record of that frees the worktree. */
  it("frees a worktree whose commits the session pushed itself", async () => {
    const { subtasks, pool } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      tips: { ".": "c1" },
      pushed: { ".": "c1" }
    });
    await subtasks.resolve(ctx);
    await subtasks.release(ctx);

    expect(pool.rows()[0]?.repos[0]).toMatchObject({ tip: "c1", pushed: "c1" });
    expect(
      await nameOf(subtasks.resolve({ ...ctx, runId: "detached:2" }))
    ).toBe(SLOT0);
  });

  it("holds one whose last commit is past what it pushed", async () => {
    const { subtasks } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      tips: { ".": "c2" },
      pushed: { ".": "c1" }
    });
    await subtasks.resolve(ctx);
    await subtasks.release(ctx);

    expect(
      await nameOf(subtasks.resolve({ ...ctx, runId: "detached:2" }))
    ).toBe(SLOT1);
  });

  /** Nobody works in a worktree between sessions, so nothing keeps it running. */
  it("stops the container of a worktree it releases", async () => {
    const { subtasks, released } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      tips: { ".": sha("origin/main") }
    });
    await subtasks.resolve(ctx);
    await subtasks.release(ctx);

    expect(released).toEqual([SLOT0]);
  });

  /** Unknown tips hold the worktree rather than risk resetting commits. */
  it("holds a worktree whose commits it could not read", async () => {
    const { subtasks, pool } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      tipsThrow: true
    });
    await subtasks.resolve(ctx);
    await subtasks.release(ctx);

    expect(pool.rows()[0]?.repos[0]?.tip).toBe("");
  });

  it("continues a branch in the worktree that holds it, from the base it was given", async () => {
    const { subtasks, calls, placed } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      tips: { ".": "c1" }
    });
    await subtasks.resolve(ctx);
    await subtasks.release(ctx);
    calls.length = 0;

    expect(
      await nameOf(
        subtasks.resolve({
          ...ctx,
          runId: "detached:2",
          continue: BRANCH_1
        })
      )
    ).toBe(SLOT0);
    expect(calls).toContain("place continue");
    // Measured against where the branch started, not where the remote is now.
    expect(placed[1]).toMatchObject({
      WORKTREE_BRANCH: BRANCH_1,
      WORKTREE_MODE: "continue",
      WORKTREE_PREVIOUS: "",
      WORKTREE_REPOS: `.\t${sha("origin/main")}`
    });
  });

  it("adopts the branch from the remote when the worktree holding it lost its storage", async () => {
    const held = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      tips: { ".": "c1" }
    });
    await held.subtasks.resolve(ctx);
    await held.subtasks.release(ctx);
    // The same row over a workspace with no checkout — reclaimed after a week —
    // and a remote the branch was pushed to.
    const reclaimed = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      remote: ["."]
    });
    reclaimed.pool.put(held.pool.rows()[0]!);

    await reclaimed.subtasks.resolve({
      ...ctx,
      runId: "detached:2",
      continue: BRANCH_1
    });
    expect(reclaimed.calls).toContain(`clone ${CHECKOUT.dir}@main`);
    expect(reclaimed.placed[0]?.WORKTREE_MODE).toBe("adopt");
  });

  /** Starting it from the base would report the lost work as there. */
  it("refuses to adopt a branch that is on the remote nowhere", async () => {
    const { subtasks, pool } = harness({
      selected: "acme/api",
      checkout: CHECKOUT
    });

    await expect(
      subtasks.resolve({ ...ctx, continue: "claude-coordinator/task-0/4" })
    ).rejects.toThrow(/on the remote in no repository.*commits are gone/s);
    // Never ready, so releasing it frees the worktree rather than holding a
    // branch that has nothing on it.
    await subtasks.release(ctx);
    expect(pool.rows()[0]?.branch).toBeUndefined();
  });

  it("adopts a pull request's branch no session made", async () => {
    const { subtasks, placed } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      remote: ["."]
    });

    await subtasks.resolve({ ...ctx, continue: "feature/artifacts" });
    expect(placed[0]).toMatchObject({
      WORKTREE_BRANCH: "feature/artifacts",
      WORKTREE_MODE: "adopt"
    });
  });

  it("refuses a `continue` that is not a branch name, before claiming a worktree", async () => {
    const { subtasks, calls, pool } = harness({
      selected: "acme/api",
      checkout: CHECKOUT
    });

    await expect(
      subtasks.resolve({ ...ctx, continue: "main..next" })
    ).rejects.toThrow(/not a branch name/);
    expect(calls).toEqual([]);
    expect(pool.rows()).toEqual([]);
  });

  it("starts new work on the branch the caller named", async () => {
    const { subtasks, placed } = harness({
      selected: "acme/api",
      checkout: CHECKOUT
    });

    const place = await subtasks.resolve({ ...ctx, branch: "docs/readme" });
    expect(place).toMatchObject({ branch: "docs/readme", continues: false });
    // The placing script refuses it there if the remote already has it.
    expect(placed[0]).toMatchObject({
      WORKTREE_BRANCH: "docs/readme",
      WORKTREE_MODE: "new"
    });
  });

  it.each([
    [{ branch: "docs/readme", continue: "feature/artifacts" }, /not both/],
    [{ branch: "main..next" }, /git would not take as a branch name/]
  ])(
    "refuses a `branch` it cannot use, before claiming a worktree: %j",
    async (input, message) => {
      const { subtasks, calls, pool } = harness({
        selected: "acme/api",
        checkout: CHECKOUT
      });

      await expect(subtasks.resolve({ ...ctx, ...input })).rejects.toThrow(
        message
      );
      expect(calls).toEqual([]);
      expect(pool.rows()).toEqual([]);
    }
  );

  /**
   * A run carrying on from a conversation asks for the worktree that holds it —
   * a planning session's transcript is in the workspace that ran it.
   */
  it("places a run in the worktree it asks for by `near`, when that one is free", async () => {
    const { subtasks } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      tips: { ".": sha("origin/main") }
    });
    // Two worktrees, both free once released: the older would be taken.
    const second = { ...ctx, runId: "detached:2" };
    await subtasks.resolve(ctx);
    await subtasks.resolve(second);
    await subtasks.release(ctx);
    await subtasks.release(second);

    const place = await subtasks.resolve({
      ...ctx,
      runId: "detached:3",
      near: { repo: "acme/api", slot: 1 }
    });
    expect(place.workspaceName).toBe(SLOT1);
    expect(place.slot).toEqual({ repo: "acme/api", slot: 1 });
  });

  it("ignores a `near` in another repository's pool", async () => {
    const { subtasks } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      tips: { ".": sha("origin/main") }
    });
    const second = { ...ctx, runId: "detached:2" };
    await subtasks.resolve(ctx);
    await subtasks.resolve(second);
    await subtasks.release(ctx);
    await subtasks.release(second);

    expect(
      await nameOf(
        subtasks.resolve({
          ...ctx,
          runId: "detached:3",
          near: { repo: "acme/other", slot: 1 }
        })
      )
    ).toBe(SLOT0);
  });

  /** A planning session commits nothing, so its branch is no work to review. */
  it("frees a worktree without its branch when asked to forget it", async () => {
    const { subtasks, pool } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      tips: { ".": sha("origin/main") }
    });
    await subtasks.resolve(ctx);
    await subtasks.release(ctx, { forgetBranch: true });

    expect(pool.rows()[0]?.branch).toBeUndefined();
    expect(pool.rows()[0]).toMatchObject({ previous: BRANCH_1 });
    expect(isFree(pool.all("acme/api")[0]!)).toBe(true);
  });

  /**
   * Without a branch a worktree is free whatever its tips read, so forgetting
   * one must not take the hold on a tip it could not read, or on a commit.
   */
  it.each([
    ["could not be read", { tipsThrow: true }],
    ["holds a commit", { tips: { ".": "c1" } }]
  ] as const)(
    "keeps the branch it was asked to forget when a tip %s",
    async (_label, over) => {
      const { subtasks, pool } = harness({
        selected: "acme/api",
        checkout: CHECKOUT,
        ...over
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await subtasks.resolve(ctx);
        await subtasks.release(ctx, { forgetBranch: true });
      } finally {
        warn.mockRestore();
      }

      expect(pool.rows()[0]?.branch).toBe(BRANCH_1);
      expect(isFree(pool.all("acme/api")[0]!)).toBe(false);
    }
  );

  it("frees a worktree that never got onto its new branch", async () => {
    const { subtasks, pool } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      cloneFails: { dir: CHECKOUT.dir, message: "network" }
    });
    await expect(subtasks.resolve(ctx)).rejects.toThrow();
    await subtasks.release(ctx);

    expect(pool.rows()[0]).toMatchObject({
      slot: 0,
      previous: BRANCH_1
    });
    expect(pool.rows()[0]?.branch).toBeUndefined();
    expect(pool.rows()[0]?.live).toBeUndefined();
  });
});

/**
 * A run that did not complete — it failed, or its task was canceled — which
 * says nothing about the session's work, so it is kept where a `continue` will
 * find it. Why a cancel resets nothing is on `keep`.
 */
describe("the parent's reads, after a writing session", () => {
  const pushedRun = () =>
    harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      tips: { ".": "c1" },
      pushed: { ".": "c1" }
    });

  it("follow the session into the worktree it left on its branch", async () => {
    const { subtasks, active } = pushedRun();
    await subtasks.resolve(ctx);
    await subtasks.release(ctx, { follow: true });
    expect(active.get()).toBe(worktreeRepo("acme/api", 0));
  });

  it("stay where they are unless asked to follow", async () => {
    const { subtasks, active } = pushedRun();
    await subtasks.resolve(ctx);
    await subtasks.release(ctx);
    expect(active.get()).toBe("acme/api");
  });

  it("stay on another repository the parent moved to meanwhile", async () => {
    const { subtasks, active } = pushedRun();
    await subtasks.resolve(ctx);
    active.set("acme/web");
    await subtasks.release(ctx, { follow: true });
    expect(active.get()).toBe("acme/web");
  });

  it("stay where they are when the branch is forgotten", async () => {
    const { subtasks, active } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      tips: { ".": sha("origin/main") }
    });
    await subtasks.resolve(ctx);
    await subtasks.release(ctx, { forgetBranch: true, follow: true });
    expect(active.get()).toBe("acme/api");
  });

  /** Free, since its work is pushed — but the parent is reading it. */
  it("keep their worktree from the next session's new branch", async () => {
    const { subtasks } = pushedRun();
    await subtasks.resolve(ctx);
    await subtasks.release(ctx, { follow: true });
    expect(
      await nameOf(subtasks.resolve({ ...ctx, runId: "detached:2" }))
    ).toBe(SLOT1);
  });
});

describe("keeping what a session that did not complete did", () => {
  const BRANCH = BRANCH_1;

  it("stops the session and commits what it left, resetting nothing", async () => {
    const { subtasks, calls, stopped, keeps } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      kept: { ".": { head: "wip-commit", wip: true } }
    });
    await subtasks.resolve(ctx);
    calls.length = 0;

    const { note, settled } = await subtasks.keep(ctx);

    expect(settled).toBe(true);
    expect(stopped).toEqual([`${SLOT0}#detached:1`]);
    expect(calls).toEqual(["keep ."]);
    // From `/`, so the command's own shell is not a process it waits to leave
    // the worktree.
    expect(keeps[0]?.cwd).toBe("/");
    expect(keeps[0]?.env.WORKTREE_DIR).toBe(CHECKOUT.dir);
    expect(note).toContain(`\`${BRANCH}\``);
    expect(note).toContain("WIP commit");
    expect(note).toContain("`continue`");
  });

  it("holds the worktree on its branch, for a `continue` to find", async () => {
    const { subtasks, pool, calls } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      kept: { ".": { head: "wip-commit", wip: true } },
      tips: { ".": "wip-commit" }
    });
    await subtasks.resolve(ctx);

    await subtasks.keep(ctx);
    // Core runs this next on the same path.
    await subtasks.release(ctx);

    const [row] = pool.all("acme/api");
    expect(row?.branch).toBe(BRANCH);
    expect(isFree(row!)).toBe(false);
    calls.length = 0;
    expect(
      await nameOf(
        subtasks.resolve({ ...ctx, runId: "detached:2", continue: BRANCH })
      )
    ).toBe(SLOT0);
    expect(calls).toContain("place continue");
  });

  it("names the branch alone when everything was already committed", async () => {
    const { subtasks } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      kept: { ".": { head: "session-commit" } }
    });
    await subtasks.resolve(ctx);

    const { note } = await subtasks.keep(ctx);

    expect(note).toContain(`\`${BRANCH}\``);
    expect(note).not.toContain("WIP");
  });

  it("says nothing when the session did nothing", async () => {
    const { subtasks } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      kept: { ".": { head: sha("origin/main") } }
    });
    await subtasks.resolve(ctx);

    // A branch with nothing on it is not worth continuing, and saying it is would
    // send the model to an empty branch.
    expect(await subtasks.keep(ctx)).toEqual({ settled: true });
  });

  it("stops a session whose worktree never got ready, and keeps nothing", async () => {
    const { subtasks, calls, stopped } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      cloneFails: { dir: CHECKOUT.dir, message: "network" }
    });
    await expect(subtasks.resolve(ctx)).rejects.toThrow();
    calls.length = 0;

    expect(await subtasks.keep(ctx)).toEqual({ settled: true });
    expect(stopped).toEqual([`${SLOT0}#detached:1`]);
    expect(calls).toEqual([]);
  });

  it("still names what was committed when the WIP commit failed", async () => {
    // Nothing was reset, so the session's own commits are there either way.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { subtasks } = harness({
        selected: "acme/api",
        checkout: CHECKOUT,
        keepFails: true,
        kept: { ".": { head: "session-commit" } }
      });
      await subtasks.resolve(ctx);

      const kept = await subtasks.keep(ctx);
      expect(kept.note).toContain(`\`${BRANCH}\``);
      expect(kept.settled).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "could not commit what an interrupted session left"
        ),
        expect.anything()
      );
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * A run whose work was not secured — its session would not stop, or what it
   * left could not be committed — never goes back to the pool on tips that
   * read as its base: the next claim's `clean` would take the edit.
   */
  it.each([
    ["the WIP commit failed", { keepFails: true }],
    ["the session would not stop", { stopThrows: true }],
    ["the worktree could not be reached", { keepThrows: true }]
  ] as const)(
    "holds a worktree whose work it could not secure: %s",
    async (_why, failure) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { subtasks, pool } = harness({
          selected: "acme/api",
          checkout: CHECKOUT,
          ...failure,
          // Nothing committed: the tips read as the base.
          kept: { ".": { head: sha("origin/main") } },
          tips: { ".": sha("origin/main") }
        });
        await subtasks.resolve(ctx);

        const kept = await subtasks.keep(ctx);
        expect(kept.settled).toBe(false);
        await subtasks.release(ctx, { hold: !kept.settled });

        const [row] = pool.all("acme/api");
        expect(row?.live).toBeUndefined();
        expect(isFree(row!)).toBe(false);
      } finally {
        warn.mockRestore();
      }
    }
  );

  it("frees a worktree whose session did nothing, once it is secured", async () => {
    const { subtasks, pool } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      kept: { ".": { head: sha("origin/main") } },
      tips: { ".": sha("origin/main") }
    });
    await subtasks.resolve(ctx);

    const kept = await subtasks.keep(ctx);
    await subtasks.release(ctx, { hold: !kept.settled });

    expect(isFree(pool.all("acme/api")[0]!)).toBe(true);
  });
});

/**
 * A superproject: the clone is the superproject alone, so each submodule is
 * cloned into the worktree with objects of its own, and every repository the
 * session could commit in is put on the branch.
 */
describe("a worktree of a superproject", () => {
  const SUPER: ActiveCheckout = {
    url: "https://github.com/acme/super",
    dir: "/workspace/super",
    branch: "main"
  };
  const DECLARED = gitmodules({
    "submodule.core.path": "core",
    "submodule.core.url": "https://github.com/acme/core.git",
    "submodule.core.branch": "main",
    "submodule.starter.path": "starter",
    "submodule.starter.url": "../starter.git",
    "submodule.starter.branch": "next",
    "submodule.pinned.path": "vendor/pinned",
    "submodule.pinned.url": "https://github.com/acme/pinned"
  });

  function superHarness(over: Parameters<typeof harness>[0] = {}) {
    return harness({
      selected: "acme/super",
      checkout: SUPER,
      submodules: DECLARED,
      ...over
    });
  }

  it("keeps a failed session's work in every repository, leaving pins out of the superproject's", async () => {
    const { subtasks, keeps } = superHarness({
      kept: { core: { head: "core-wip", wip: true } }
    });
    await subtasks.resolve(ctx);

    expect((await subtasks.keep(ctx)).note).toContain("WIP commit");
    expect(keeps[0]?.env.WORKTREE_KEEP_PATHS?.split("\n")).toEqual([
      ".",
      "core",
      "starter",
      "vendor/pinned"
    ]);
    // Moving a pin is a decision, and the continuing session places each
    // submodule on the branch by itself.
    expect(keeps[0]?.env.WORKTREE_KEEP_SUBMODULES?.split("\n")).toEqual([
      "core",
      "starter",
      "vendor/pinned"
    ]);
  });

  it("clones and fetches every submodule, on its declared branch", async () => {
    const { subtasks, calls } = superHarness();

    await subtasks.resolve(ctx);

    expect(calls).toEqual([
      `clear ${SUPER.dir}`,
      `clone ${SUPER.dir}@main`,
      "noteCheckout",
      `fetch ${SUPER.dir}`,
      // The superproject first: which submodules there are is what its branch says.
      "place new",
      `clone ${SUPER.dir}/core@main`,
      `fetch ${SUPER.dir}/core`,
      `clone ${SUPER.dir}/starter@next`,
      `fetch ${SUPER.dir}/starter`,
      // No declared branch: the default one, fetched in full so its pin is there.
      `clone ${SUPER.dir}/vendor/pinned@`,
      `fetch ${SUPER.dir}/vendor/pinned`,
      "place new",
      "startInstall"
    ]);
  });

  it("starts each submodule from its declared branch, or its pin", async () => {
    const { subtasks, placed, pool } = superHarness();

    await subtasks.resolve(ctx);

    expect(placed[1]?.WORKTREE_REPOS).toBe(
      [
        "core\torigin/main",
        "starter\torigin/next",
        "vendor/pinned\t@pinned"
      ].join("\n")
    );
    // Each remembered with the origin it was cloned from, for the push guard.
    expect(
      pool.rows()[0]?.repos.map((repo) => [repo.path, repo.url, repo.baseRef])
    ).toEqual([
      [".", SUPER.url, "origin/main"],
      ["core", "https://github.com/acme/core.git", "origin/main"],
      ["starter", "https://github.com/acme/starter.git", "origin/next"],
      // A pin is a commit, and a reviewer passes it as one.
      ["vendor/pinned", "https://github.com/acme/pinned", sha("@pinned")]
    ]);
  });

  it("does not clone a submodule a previous attempt already cloned", async () => {
    const { subtasks, calls } = superHarness({
      populated: ["core", "starter"]
    });

    await subtasks.resolve(ctx);

    expect(calls.filter((call) => call.startsWith("clone "))).toEqual([
      `clone ${SUPER.dir}@main`,
      `clone ${SUPER.dir}/vendor/pinned@`
    ]);
  });

  /** `.gitmodules` is repository content, so a url in it has passed nothing. */
  it("refuses a submodule hosted anywhere but the parent's host", async () => {
    const { subtasks } = superHarness({
      submodules: gitmodules({
        "submodule.x.path": "x",
        "submodule.x.url": "https://evil.example/acme/x"
      })
    });

    await expect(subtasks.resolve(ctx)).rejects.toThrow(
      /only over https from github\.com/
    );
  });
});

describe("reading .gitmodules", () => {
  it("groups each submodule's fields, including names with dots in them", () => {
    expect(
      parseGitmodules(
        gitmodules({
          "submodule.a.b.path": "libs/a.b",
          "submodule.a.b.url": "../a.b.git",
          "submodule.a.b.branch": "main",
          "submodule.c.path": "c",
          "submodule.c.url": "https://github.com/acme/c"
        })
      )
    ).toEqual([
      { path: "libs/a.b", url: "../a.b.git", branch: "main" },
      { path: "c", url: "https://github.com/acme/c" }
    ]);
  });

  it("drops an entry git could not check out either", () => {
    expect(parseGitmodules(gitmodules({ "submodule.a.path": "a" }))).toEqual(
      []
    );
  });
});

describe("where a submodule is cloned from", () => {
  const parent = "https://github.com/acme/super.git";

  it("resolves a relative url the way git does, against the superproject's", () => {
    expect(
      submoduleCloneUrl({ path: "core", url: "../core.git" }, parent)
    ).toBe("https://github.com/acme/core.git");
    expect(submoduleCloneUrl({ path: "x", url: "./x" }, parent)).toBe(
      "https://github.com/acme/super.git/x"
    );
  });

  it("refuses ssh, which a container with no key cannot reach anyway", () => {
    expect(() =>
      submoduleCloneUrl(
        { path: "core", url: "git@github.com:acme/core.git" },
        parent
      )
    ).toThrow(/only over https/);
  });
});

/**
 * A `.gitmodules` path becomes a clone target, a cwd, and a row of the lists the
 * branch script reads — so it is refused before any of those, not at each.
 */
describe("which submodule paths are accepted", () => {
  const read = (path: string) =>
    readSubmodules(
      async () => ({
        success: true,
        stdout: gitmodules({
          "submodule.x.path": path,
          "submodule.x.url": "https://github.com/acme/x"
        }),
        stderr: ""
      }),
      "/workspace/super"
    );

  it("accepts an ordinary nested path", async () => {
    await expect(read("libs/core")).resolves.toEqual([
      { path: "libs/core", url: "https://github.com/acme/x" }
    ]);
  });

  it.each([
    ["one that walks out", "../elsewhere"],
    ["an absolute one", "/etc"],
    // One path read as two rows, the second outside the checkout.
    ["one with a newline", "safe\n../outside"],
    ["one with a tab", "safe\tpinned"],
    ["one with an empty segment", "a//b"]
  ])("refuses %s", async (_label, path) => {
    await expect(read(path)).rejects.toThrow(/could leave the checkout/);
  });
});

/**
 * A task that has ended owes nothing a claim still holds. A claim whose run
 * never started — the turn was cut between the claim and the dispatch — has no
 * `settle` coming, and a claim left live is passed over for good.
 */
describe("releasing what an ended task still holds", () => {
  it("frees every worktree the task claimed, and no other task's", async () => {
    const { subtasks, pool } = harness({
      selected: "acme/api",
      checkout: CHECKOUT
    });

    await subtasks.resolve(ctx);
    await subtasks.resolve({ taskId: "task-b", runId: "detached:9" });
    await subtasks.releaseTask("task-a");

    const live = pool
      .all("acme/api")
      .filter((row) => row.live)
      .map((row) => row.live);
    expect(live).toEqual([{ taskId: "task-b", runId: "detached:9" }]);
  });
});

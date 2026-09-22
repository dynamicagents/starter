import { describe, it, expect } from "vitest";
import {
  parseGitmodules,
  readSubmodules,
  submoduleCloneUrl,
  subtaskWorkspaces
} from "@/workspace/subtask-workspace";
import { SCRATCH_REPO } from "@/workspace/scratch";
import { isFree, worktreeRepo, type Worktree } from "@/workspace/worktree-pool";
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
  /** Repositories whose remote has the branch being placed. */
  remote?: string[];
  /** Fail the reset an abort runs. */
  resetFails?: boolean;
}) {
  const calls: string[] = [];
  let cloneFails = opts.cloneFails;
  const dirs = { ...(opts.dirs ?? {}) };
  const pool = memoryPoolStore();
  const active = fakeActive(opts.selected, opts.checkout);
  const placed: Record<string, string>[] = [];
  const stopped: string[] = [];
  let current = "";
  const stub = {
    checkoutDir: async () => dirs[current],
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
      return { ok: true as const, detail: "fetched" };
    },
    noteCheckout: async () => {
      calls.push("noteCheckout");
      return { present: true };
    },
    startInstall: async () => {
      calls.push("startInstall");
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
      if (command.includes("WORKTREE_PATHS")) {
        if (opts.tipsThrow) throw new Error("container unreachable");
        const rows = (env.WORKTREE_PATHS ?? "")
          .split("\n")
          .map((path) => `${path}\t${opts.tips?.[path] ?? ""}`);
        return { success: true, stdout: rows.join("\n"), stderr: "" };
      }
      if (
        command.includes(
          'git -C "$path" checkout -f -q -B "$WORKTREE_BRANCH" "$start"'
        )
      ) {
        calls.push(`reset ${env.WORKTREE_REPOS?.replaceAll("\t", "@")}`);
        if (opts.resetFails) {
          return { success: false, stdout: "", stderr: "index.lock" };
        }
      }
      return { success: true, stdout: "", stderr: "" };
    },
    stopSession: async (workspace, subtaskId) => {
      stopped.push(`${workspace}#${subtaskId}`);
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
  return { subtasks, calls, pool, active, placed, stopped, heal };
}

const ctx = { taskId: "task-a", subtaskId: 1 };
const SLOT0 = `caller|${worktreeRepo("acme/api", 0)}`;
const SLOT1 = `caller|${worktreeRepo("acme/api", 1)}`;

describe("preparing a worktree for a writing subtask", () => {
  it("clones, fetches, puts it on the branch and installs", async () => {
    const { subtasks, calls, pool, active, placed } = harness({
      selected: "acme/api",
      checkout: CHECKOUT
    });

    expect(await subtasks.resolve(ctx)).toBe(SLOT0);
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
      WORKTREE_BRANCH: "claude-coder/task-a/1",
      WORKTREE_MODE: "new",
      WORKTREE_REPOS: ".\torigin/main"
    });
    expect(pool.rows()).toEqual([
      {
        repo: "acme/api",
        slot: 0,
        branch: "claude-coder/task-a/1",
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

  /** Core resolves runtime per chunk; the second chunk must not redo anything. */
  it("answers the same worktree on every chunk, preparing it once", async () => {
    const { subtasks, calls } = harness({
      selected: "acme/api",
      checkout: CHECKOUT
    });

    await subtasks.resolve(ctx);
    const before = calls.length;
    expect(await subtasks.resolve(ctx)).toBe(SLOT0);
    expect(calls).toHaveLength(before);
  });

  it("gives concurrent subtasks separate worktrees", async () => {
    const { subtasks } = harness({ selected: "acme/api", checkout: CHECKOUT });

    await subtasks.resolve(ctx);
    expect(await subtasks.resolve({ ...ctx, subtaskId: 2 })).toBe(SLOT1);
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
    expect(await first.subtasks.resolve(ctx)).toBe(SLOT0);
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
  it("hands a scratchpad subtask the parent's own workspace", async () => {
    const { subtasks, calls } = harness({
      selected: SCRATCH_REPO,
      checkout: CHECKOUT
    });

    expect(await subtasks.resolve(ctx)).toBe(`caller|${SCRATCH_REPO}`);
    expect(calls).toEqual([]);
  });

  it("delegates from the repository's pool while the parent is in one of its worktrees", async () => {
    const { subtasks } = harness({
      selected: worktreeRepo("acme/api", 4),
      checkout: CHECKOUT
    });

    expect(await subtasks.resolve(ctx)).toBe(SLOT0);
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

describe("handing a worktree to the next subtask", () => {
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

    expect(await subtasks.resolve({ ...ctx, subtaskId: 2 })).toBe(SLOT0);
    expect(calls).not.toContain(`clone ${CHECKOUT.dir}@main`);
    expect(calls).toEqual([
      "noteCheckout",
      `fetch ${CHECKOUT.dir}`,
      "place new",
      "startInstall"
    ]);
    // The branch it held is deleted as it moves on.
    expect(placed[1]).toMatchObject({
      WORKTREE_BRANCH: "claude-coder/task-a/2",
      WORKTREE_PREVIOUS: "claude-coder/task-a/1"
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
      branch: "claude-coder/task-a/1",
      repos: [{ path: ".", tip: "c1" }]
    });
    expect(pool.rows()[0]?.live).toBeUndefined();
    expect(await subtasks.resolve({ ...ctx, subtaskId: 2 })).toBe(SLOT1);
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
      await subtasks.resolve({
        ...ctx,
        subtaskId: 2,
        continue: "claude-coder/task-a/1"
      })
    ).toBe(SLOT0);
    expect(calls).toContain("place continue");
    // Measured against where the branch started, not where the remote is now.
    expect(placed[1]).toMatchObject({
      WORKTREE_BRANCH: "claude-coder/task-a/1",
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
      subtaskId: 2,
      continue: "claude-coder/task-a/1"
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
      subtasks.resolve({ ...ctx, continue: "claude-coder/task-0/4" })
    ).rejects.toThrow(/on the remote in no repository.*commits are gone/s);
    // Never ready, so releasing it frees the worktree rather than holding a
    // branch that has nothing on it.
    await subtasks.release(ctx);
    expect(pool.rows()[0]?.branch).toBeUndefined();
  });

  it("refuses a `continue` that is not a branch a subtask made", async () => {
    const { subtasks } = harness({ selected: "acme/api", checkout: CHECKOUT });

    await expect(
      subtasks.resolve({ ...ctx, continue: "main" })
    ).rejects.toThrow(/not a branch a writing subtask made/);
  });

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
      previous: "claude-coder/task-a/1"
    });
    expect(pool.rows()[0]?.branch).toBeUndefined();
    expect(pool.rows()[0]?.live).toBeUndefined();
  });
});

describe("aborting a writing subtask", () => {
  it("stops the session, then puts each repository back where it started", async () => {
    const { subtasks, calls, stopped } = harness({
      selected: "acme/api",
      checkout: CHECKOUT
    });
    await subtasks.resolve(ctx);
    calls.length = 0;

    await subtasks.abort(ctx);

    expect(stopped).toEqual([`${SLOT0}#1`]);
    expect(calls).toEqual([`reset .@${sha("origin/main")}`]);
  });

  it("stops a session whose worktree never got ready, and resets nothing", async () => {
    const { subtasks, calls, stopped } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      cloneFails: { dir: CHECKOUT.dir, message: "network" }
    });
    await expect(subtasks.resolve(ctx)).rejects.toThrow();
    calls.length = 0;

    await subtasks.abort(ctx);

    expect(stopped).toEqual([`${SLOT0}#1`]);
    expect(calls).toEqual([]);
  });

  it("does nothing for a subtask that holds no worktree", async () => {
    const { subtasks, stopped } = harness({
      selected: "acme/api",
      checkout: CHECKOUT
    });
    await subtasks.abort(ctx);
    await subtasks.release(ctx);
    expect(stopped).toEqual([]);
  });

  /**
   * `stopSession` delivers `SIGTERM` and returns, so a session can still commit
   * while the reset runs — this path is reached with no drain left to wait on.
   * The tips here are what such a commit would leave, and none of it may be
   * recorded as the branch's: the row says where the reset put it.
   */
  it("records where the reset left it, not what a session committed after", async () => {
    const { subtasks, calls, pool } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      tips: { ".": "committed-after-the-reset" }
    });
    await subtasks.resolve(ctx);
    calls.length = 0;

    await subtasks.abort(ctx);
    // Core runs this next on the same path, and it must find nothing to do.
    await subtasks.release(ctx);

    const [row] = pool.all("acme/api");
    expect(row?.live).toBeUndefined();
    expect(row?.repos.map((repo) => repo.tip)).toEqual([sha("origin/main")]);
    expect(isFree(row!)).toBe(true);
    // Only the reset — `release` read no tips, because it found no live row.
    expect(calls).toEqual([`reset .@${sha("origin/main")}`]);
  });

  /** A reset that failed proves nothing about the tree, so the row is not freed. */
  it("leaves the worktree held when the reset failed", async () => {
    const { subtasks, pool } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      resetFails: true,
      tips: { ".": "unpushed" }
    });
    await subtasks.resolve(ctx);

    await subtasks.abort(ctx);
    await subtasks.release(ctx);

    const [row] = pool.all("acme/api");
    expect(row?.repos.map((repo) => repo.tip)).toEqual(["unpushed"]);
    expect(isFree(row!)).toBe(false);
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

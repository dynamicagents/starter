import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { workspaceName } from "@dynamicagents/plugins/computer";
import { SCRATCH_REPO } from "@/workspace/scratch";
import {
  claim,
  isFree,
  isSubtaskBranch,
  parseWorktreeRepo,
  sqlPoolStore,
  subtaskBranch,
  worktreeRepo,
  type PoolRepo,
  type Worktree
} from "@/workspace/worktree-pool";
import { memoryPoolStore } from "./support/memory-pool";

const REPO = "acme/api";

/** One repository at a base, a start and a tip. */
const repo = (over: Partial<PoolRepo> = {}): PoolRepo => ({
  path: ".",
  url: "https://github.com/acme/api",
  baseRef: "origin/main",
  base: "b0",
  start: "b0",
  tip: "b0",
  ...over
});

describe("addressing a worktree", () => {
  /**
   * The sentinel shares a namespace with the `owner/repo` strings a model can
   * cause to be cloned, so it has to be one no repository name can collide with,
   * and never carry the separator `workspaceName` joins on.
   */
  it("cannot collide with a repository anyone could clone, or forge a caller", () => {
    const sentinel = worktreeRepo(REPO, 0);
    expect(sentinel).toBe("<worktree:acme/api:0>");
    expect(sentinel).not.toContain("|");
    expect(sentinel).not.toBe(SCRATCH_REPO);
    expect(workspaceName("caller", sentinel)).not.toBe(
      workspaceName("caller", REPO)
    );
  });

  it("reads its own sentinels back, and nothing else", () => {
    expect(parseWorktreeRepo(worktreeRepo(REPO, 12))).toEqual({
      repo: REPO,
      slot: 12
    });
    expect(parseWorktreeRepo(REPO)).toBeUndefined();
    expect(parseWorktreeRepo(SCRATCH_REPO)).toBeUndefined();
  });

  /**
   * `/repo` refuses a branch that is not a plain name, and `continue` may name
   * nothing but these — the default branch above all.
   */
  it("derives branches `/repo` accepts, and lets `continue` name only those", () => {
    const branch = subtaskBranch({ taskId: "task-a", subtaskId: 3 });
    expect(branch).toBe("claude-coder/task-a/3");
    expect(isSubtaskBranch(branch)).toBe(true);
    for (const other of [
      "main",
      "next",
      "claude-coder/task-a",
      "claude-coder/../main/1",
      "claude-coder/t/1.lock",
      "feature/claude-coder/t/1"
    ]) {
      expect(isSubtaskBranch(other)).toBe(false);
    }
  });
});

describe("whether a worktree can go to the next subtask", () => {
  const worktree = (over: Partial<Worktree> = {}): Worktree => ({
    repo: REPO,
    slot: 0,
    branch: "claude-coder/t/1",
    repos: [repo()],
    usedAt: 0,
    ...over
  });

  it("is free with no commits past its base, or with every one pushed", () => {
    expect(isFree(worktree())).toBe(true);
    expect(
      isFree(worktree({ repos: [repo({ tip: "c1", pushed: "c1" })] }))
    ).toBe(true);
    expect(
      isFree(worktree({ branch: undefined, repos: [repo({ tip: "c1" })] }))
    ).toBe(true);
  });

  it("is held by unpushed commits, a live session, or a tip nobody saw", () => {
    expect(isFree(worktree({ repos: [repo({ tip: "c1" })] }))).toBe(false);
    expect(
      isFree(worktree({ repos: [repo({ tip: "c2", pushed: "c1" })] }))
    ).toBe(false);
    expect(isFree(worktree({ live: { taskId: "t", subtaskId: 2 } }))).toBe(
      false
    );
    expect(isFree(worktree({ repos: [repo({ tip: "" })] }))).toBe(false);
  });
});

describe("claiming a worktree", () => {
  const ctx = { taskId: "task-a", subtaskId: 1 };

  it("makes the first one, on the subtask's own branch", () => {
    const pool = memoryPoolStore();
    const claimed = claim(pool, REPO, ctx, 10);

    expect(claimed).toMatchObject({
      repo: REPO,
      slot: 0,
      branch: "claude-coder/task-a/1",
      live: ctx,
      mode: "new",
      ready: false,
      usedAt: 10
    });
    expect(pool.rows()).toEqual([claimed]);
  });

  /** Core resolves runtime per chunk; a second answer strands the work. */
  it("answers the same worktree on every chunk of one subtask", () => {
    const pool = memoryPoolStore();
    const first = claim(pool, REPO, ctx, 10);
    expect(claim(pool, REPO, ctx, 20)).toEqual(first);
  });

  it("gives concurrent subtasks separate worktrees", () => {
    const pool = memoryPoolStore();
    claim(pool, REPO, ctx, 10);
    expect(claim(pool, REPO, { ...ctx, subtaskId: 2 }, 11).slot).toBe(1);
  });

  it("reuses the free worktree used longest ago, and names what it held", () => {
    const pool = memoryPoolStore();
    pool.put({
      repo: REPO,
      slot: 0,
      branch: "claude-coder/t/1",
      repos: [repo()],
      usedAt: 5
    });
    pool.put({
      repo: REPO,
      slot: 1,
      branch: "claude-coder/t/2",
      repos: [repo()],
      usedAt: 3
    });
    pool.put({
      repo: REPO,
      slot: 2,
      branch: "claude-coder/t/3",
      repos: [repo({ tip: "c1" })],
      usedAt: 1
    });

    const claimed = claim(pool, REPO, ctx, 10);

    expect(claimed.slot).toBe(1);
    expect(claimed.previous).toBe("claude-coder/t/2");
    expect(claimed.mode).toBe("new");
  });

  it("keeps pools apart by repository", () => {
    const pool = memoryPoolStore();
    claim(pool, REPO, ctx, 10);
    expect(claim(pool, "acme/cli", { ...ctx, subtaskId: 2 }, 11).slot).toBe(0);
  });

  it("continues a branch in the worktree that holds it", () => {
    const pool = memoryPoolStore();
    pool.put({
      repo: REPO,
      slot: 0,
      branch: "claude-coder/t/1",
      repos: [repo({ tip: "c1" })],
      usedAt: 5
    });

    const claimed = claim(
      pool,
      REPO,
      { ...ctx, continue: "claude-coder/t/1" },
      10
    );

    expect(claimed).toMatchObject({
      slot: 0,
      branch: "claude-coder/t/1",
      mode: "continue"
    });
    expect(claimed.previous).toBeUndefined();
    expect(claimed.repos).toEqual([repo({ tip: "c1" })]);
  });

  it("refuses to continue a branch a session is still working on", () => {
    const pool = memoryPoolStore();
    pool.put({
      repo: REPO,
      slot: 0,
      branch: "claude-coder/t/1",
      live: { taskId: "t", subtaskId: 1 },
      repos: [],
      usedAt: 5
    });

    expect(() =>
      claim(pool, REPO, { ...ctx, continue: "claude-coder/t/1" }, 10)
    ).toThrow(/claude-coder\/t\/1 is being worked on by subtask 1/);
  });

  it("adopts a branch no worktree holds into a free one", () => {
    const pool = memoryPoolStore();
    const claimed = claim(
      pool,
      REPO,
      { ...ctx, continue: "claude-coder/t/1" },
      10
    );
    expect(claimed).toMatchObject({
      slot: 0,
      branch: "claude-coder/t/1",
      mode: "adopt"
    });
  });
});

describe("the pool in the parent's SQLite", () => {
  it("keeps rows per repository and slot, and finds them across repositories", async () => {
    const stub = env.CLAUDE_CODER_WORKSPACE.get(
      env.CLAUDE_CODER_WORKSPACE.idFromName("pool-spec")
    );
    await runInDurableObject(stub, (_instance, state) => {
      const pool = sqlPoolStore(state.storage);
      const row: Worktree = {
        repo: REPO,
        slot: 0,
        branch: "claude-coder/t/1",
        repos: [repo()],
        usedAt: 1
      };
      pool.put(row);
      pool.put({ ...row, slot: 1 });
      pool.put({ ...row, repo: "acme/cli" });
      pool.put({ ...row, usedAt: 2 });

      expect(pool.all(REPO).map((r) => [r.slot, r.usedAt])).toEqual([
        [0, 2],
        [1, 1]
      ]);
      expect(pool.every()).toHaveLength(3);
      pool.delete(REPO, 1);
      expect(pool.all(REPO)).toEqual([{ ...row, usedAt: 2 }]);
    });
  });
});

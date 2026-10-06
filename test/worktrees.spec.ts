import { describe, it, expect } from "vitest";
import type { ActiveCheckout, ActiveRepo } from "@/workspace/active-repo";
import { SCRATCH_REPO } from "@/workspace/scratch";
import { worktreeRepo, type Worktree } from "@/workspace/worktree-pool";
import { worktreeSwitch } from "@/workspace/worktrees";
import { memoryPoolStore } from "./support/memory-pool";

const CHECKOUT: ActiveCheckout = {
  url: "https://github.com/acme/super",
  dir: "/workspace/super",
  branch: "main"
};
const BRANCH = "claude-coordinator/task-a/1";

/** A worktree holding {@link BRANCH}: commits in `core`, none in the superproject. */
const HELD: Worktree = {
  repo: "acme/super",
  slot: 2,
  branch: BRANCH,
  dir: CHECKOUT.dir,
  usedAt: 1,
  repos: [
    {
      path: ".",
      url: CHECKOUT.url,
      baseRef: "origin/main",
      base: "s0",
      start: "s0",
      tip: "s0"
    },
    {
      path: "core",
      url: "https://github.com/acme/core.git",
      baseRef: "origin/main",
      base: "c0",
      start: "c0",
      tip: "c2"
    }
  ]
};

function setup(opts: { selected?: string | null; checkoutDir?: string } = {}) {
  let selected =
    opts.selected === null ? undefined : (opts.selected ?? "acme/super");
  const active = {
    get: () => selected,
    set: (repo: string) => {
      selected = repo;
    },
    checkout: () => CHECKOUT
  } as unknown as ActiveRepo;
  const pool = memoryPoolStore();
  pool.put(HELD);
  const worktrees = worktreeSwitch({
    active,
    pool,
    binding: {
      idFromName: (name: string) => name,
      get: () => ({
        checkoutDir: async () =>
          "checkoutDir" in opts ? opts.checkoutDir : CHECKOUT.dir
      })
    } as unknown as Parameters<typeof worktreeSwitch>[0]["binding"],
    callerKey: () => "caller"
  });
  return { worktrees, pool, selected: () => selected };
}

describe("the parent's way into a worktree", () => {
  it("lists each branch with what it holds", async () => {
    const { worktrees } = setup();
    const listed = await worktrees.list();
    expect(listed).toContain(
      `\`${BRANCH}\` — \`core\` has commits, not pushed`
    );
    expect(listed).toMatch(/nothing touches for 7 days is deleted/);
  });

  it("switches the reads into the worktree holding a branch, and back", async () => {
    const { worktrees, selected } = setup();

    const into = await worktrees.use(BRANCH);
    expect(selected()).toBe(worktreeRepo("acme/super", 2));
    expect(into).toContain(
      "`/workspace/super/core` — has commits, not pushed, since `origin/main`"
    );
    expect(into).toContain("`/workspace/super` — no commits");
    expect(into).toContain("stay there until you move them");
    // The parent reads here; the sessions write and push.
    expect(into).not.toMatch(/repo_diff|repo_push|repo_open_pr/);

    expect(await worktrees.use()).toContain(
      "back on your own checkout, at /workspace/super"
    );
    expect(selected()).toBe("acme/super");
  });

  it("says where to look for a branch no worktree holds", async () => {
    const { worktrees, selected } = setup();
    const answer = await worktrees.use("claude-coordinator/task-a/9");
    expect(answer).toMatch(/No worktree holds.*repo_pr_view.*continue/s);
    expect(selected()).toBe("acme/super");
  });

  it("does not switch into a worktree that is still being prepared", async () => {
    const { worktrees, pool, selected } = setup();
    const { dir: _dir, ...unprepared } = HELD;
    pool.put({
      ...unprepared,
      live: { taskId: "task-a", runId: "detached:3" }
    });
    expect(await worktrees.use(BRANCH)).toMatch(
      /still being prepared; try again once its session has started/
    );
    expect(selected()).toBe("acme/super");
  });

  it("frees the slot of a worktree whose storage went, and says what was lost", async () => {
    const { worktrees, pool, selected } = setup({ checkoutDir: undefined });
    const answer = await worktrees.use(BRANCH);
    expect(answer).toMatch(/deleted after 7 days untouched/);
    expect(pool.all("acme/super")).toEqual([
      { repo: "acme/super", slot: 2, repos: [], usedAt: 1 }
    ]);
    expect(selected()).toBe("acme/super");
  });

  it("releases a worktree, warning of unpushed commits, and brings the tools back", async () => {
    const { worktrees, pool, selected } = setup({
      selected: worktreeRepo("acme/super", 2)
    });
    const answer = await worktrees.release(BRANCH);
    expect(answer).toMatch(/never pushed are gone/);
    expect(answer).toMatch(/back on your own checkout/);
    expect(pool.all("acme/super")[0]?.branch).toBeUndefined();
    expect(pool.all("acme/super")[0]?.previous).toBe(BRANCH);
    expect(selected()).toBe("acme/super");
  });

  it("will not release a worktree a session is working in", async () => {
    const { worktrees, pool } = setup();
    pool.put({ ...HELD, live: { taskId: "task-a", runId: "detached:3" } });
    expect(await worktrees.release(BRANCH)).toMatch(
      /A session is working in that worktree/
    );
  });
});

describe("where the parent's reads are", () => {
  it("names its own checkout", () => {
    expect(setup().worktrees.where()).toBe(
      "Your file reads and repo tools run in your own checkout of acme/super, at /workspace/super."
    );
  });

  it("names the branch of the worktree they are in", () => {
    const { worktrees } = setup({ selected: worktreeRepo("acme/super", 2) });
    expect(worktrees.where()).toMatch(
      /run in the worktree holding `claude-coordinator\/task-a\/1`, at the same paths as your own checkout of acme\/super/
    );
  });

  it("says when their worktree no longer holds a branch", () => {
    const { worktrees, pool } = setup({
      selected: worktreeRepo("acme/super", 2)
    });
    pool.put({ repo: "acme/super", slot: 2, repos: [], usedAt: 1 });
    expect(worktrees.where()).toMatch(
      /no longer holds a branch.*back to your own checkout/
    );
  });

  it("names a scratchpad, and nothing yet", () => {
    expect(setup({ selected: SCRATCH_REPO }).worktrees.where()).toMatch(
      /scratchpad/
    );
    expect(setup({ selected: null }).worktrees.where()).toMatch(
      /nowhere to run yet.*repo_clone.*scratch_open/
    );
  });
});

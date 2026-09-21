import { describe, it, expect } from "vitest";
import type { ActiveCheckout, ActiveRepo } from "@/workspace/active-repo";
import { worktreeRepo, type Worktree } from "@/workspace/worktree-pool";
import { worktreeSwitch } from "@/workspace/worktrees";
import { memoryPoolStore } from "./support/memory-pool";

const CHECKOUT: ActiveCheckout = {
  url: "https://github.com/acme/super",
  dir: "/workspace/super",
  branch: "main"
};
const BRANCH = "claude-coder/task-a/1";

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

function setup(opts: { selected?: string; checkoutDir?: string } = {}) {
  let selected = opts.selected ?? "acme/super";
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

  it("switches every tool into the worktree holding a branch, and back", async () => {
    const { worktrees, selected } = setup();

    const into = await worktrees.use(BRANCH);
    expect(selected()).toBe(worktreeRepo("acme/super", 2));
    expect(into).toContain(
      "`/workspace/super/core` — has commits, not pushed, since `origin/main`"
    );
    expect(into).toContain("`/workspace/super` — no commits");
    expect(into).toContain("`base`");

    expect(await worktrees.use()).toContain(
      "back on your own checkout, at /workspace/super"
    );
    expect(selected()).toBe("acme/super");
  });

  it("says where to look for a branch no worktree holds", async () => {
    const { worktrees, selected } = setup();
    const answer = await worktrees.use("claude-coder/task-a/9");
    expect(answer).toMatch(/No worktree holds.*repo_fetch.*continue/s);
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
    pool.put({ ...HELD, live: { taskId: "task-a", subtaskId: 3 } });
    expect(await worktrees.release(BRANCH)).toMatch(/Subtask 3 is working/);
  });
});

describe("writing from inside a worktree", () => {
  const inside = () => setup({ selected: worktreeRepo("acme/super", 2) });

  it("has no opinion about the parent's own checkout", async () => {
    const { worktrees } = setup();
    await expect(
      worktrees.beforeWrite({
        tool: "repo_push",
        dir: "/workspace/super",
        branch: "x"
      })
    ).resolves.toBeUndefined();
  });

  it("refuses a commit or a push while a session is still working there", async () => {
    const { worktrees, pool } = inside();
    pool.put({ ...HELD, live: { taskId: "task-a", subtaskId: 3 } });
    for (const tool of ["repo_commit", "repo_push"] as const) {
      expect(
        await worktrees.beforeWrite({
          tool,
          dir: "/workspace/super/core",
          branch: BRANCH
        })
      ).toMatch(/Subtask 3 is still working/);
    }
  });

  it("pushes only the worktree's branch, to the origin it was cloned from", async () => {
    const { worktrees } = inside();
    expect(
      await worktrees.beforeWrite({
        tool: "repo_push",
        dir: "/workspace/super/core",
        branch: "other"
      })
    ).toMatch(/holds `claude-coder\/task-a\/1`/);
    expect(
      await worktrees.beforeWrite({
        tool: "repo_push",
        dir: "/workspace/super/core",
        branch: BRANCH,
        url: "https://github.com/evil/core"
      })
    ).toMatch(
      /cloned it from https:\/\/github\.com\/acme\/core\.git.*Nothing was pushed/s
    );
    // The same remote, spelled without `.git` and with a trailing slash.
    await expect(
      worktrees.beforeWrite({
        tool: "repo_push",
        dir: "/workspace/super/core/",
        branch: BRANCH,
        url: "https://github.com/acme/core/"
      })
    ).resolves.toBeUndefined();
  });

  it("refuses a push from a directory that is none of its repositories", async () => {
    const { worktrees } = inside();
    expect(
      await worktrees.beforeWrite({
        tool: "repo_push",
        dir: "/workspace/elsewhere",
        branch: BRANCH,
        url: CHECKOUT.url
      })
    ).toMatch(/not one of this worktree's repositories/);
  });

  it("holds the worktree after a commit it cannot see, until a push lands", async () => {
    const { worktrees, pool } = inside();
    await worktrees.beforeWrite({
      tool: "repo_commit",
      dir: "/workspace/super"
    });
    expect(pool.all("acme/super")[0]?.repos[0]?.tip).toBe("");

    await worktrees.afterPush({
      dir: "/workspace/super",
      branch: BRANCH,
      commit: "s1"
    });
    expect(pool.all("acme/super")[0]?.repos[0]).toMatchObject({
      tip: "s1",
      pushed: "s1"
    });
  });
});

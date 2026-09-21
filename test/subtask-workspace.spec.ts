import { describe, it, expect } from "vitest";
import { workspaceName } from "@dynamicagents/plugins/computer";
import {
  isSubtaskRepo,
  subtaskBranch,
  subtaskRepo
} from "@/workspace/subtask-workspace";
import { SCRATCH_REPO } from "@/workspace/scratch";
import { subtaskWorkspaces } from "@/workspace/subtask-workspace";
import type { ActiveCheckout, ActiveRepo } from "@/workspace/active-repo";

/**
 * How a writing subtask is addressed.
 *
 * Two names have to be agreed by parties that never speak: the parent resolves a
 * workspace once per *chunk* and a facet works in whichever it is handed, and the
 * parent later fetches a branch a subtask pushed without being told its name. Both
 * are therefore derived from the same two ids rather than chosen anywhere, and
 * these are the properties that makes true.
 */
describe("addressing a writing subtask", () => {
  it("gives one subtask the same name however often it is asked", () => {
    // Core resolves runtime once per chunk, not once per run. A name that moved
    // between two chunks of one execution would hand the second a different
    // container and abandon the work in the first.
    const ctx = { taskId: "task-a", subtaskId: 2 };
    expect(subtaskRepo(ctx)).toBe(subtaskRepo({ ...ctx }));
    expect(subtaskBranch(ctx)).toBe(subtaskBranch({ ...ctx }));
  });

  it("separates two subtasks of one task, and two tasks", () => {
    const one = subtaskRepo({ taskId: "task-a", subtaskId: 1 });
    const two = subtaskRepo({ taskId: "task-a", subtaskId: 2 });
    const other = subtaskRepo({ taskId: "task-b", subtaskId: 1 });

    // A shared workspace is a shared working tree, which is the whole thing the
    // per-subtask container exists to prevent.
    expect(new Set([one, two, other]).size).toBe(3);
  });

  /**
   * The sentinel shares a namespace with the `owner/repo` strings a model can
   * cause to be cloned, so it has to be one no repository name can collide with.
   * `FORGE_NAME` in the repo plugin permits only `[A-Za-z0-9._-]`, which is why
   * the angle brackets are the guarantee and not decoration.
   */
  it("cannot collide with a repository anyone could clone", () => {
    const repo = subtaskRepo({ taskId: "task-a", subtaskId: 1 });

    expect(repo.startsWith("<")).toBe(true);
    expect(repo.endsWith(">")).toBe(true);
    // Nor with the other sentinel sharing this namespace.
    expect(repo).not.toBe(SCRATCH_REPO);
    // And never the separator `workspaceName` joins on: a sentinel carrying one
    // could forge a caller boundary.
    expect(repo).not.toContain("|");
  });

  it("resolves to a workspace name of its own", () => {
    const repo = subtaskRepo({ taskId: "task-a", subtaskId: 1 });

    expect(workspaceName("caller", repo)).toBe(`caller|${repo}`);
    // The parent's own workspace, which holds the checkout its tools read, is a
    // different object and therefore a different container.
    expect(workspaceName("caller", repo)).not.toBe(
      workspaceName("caller", "acme/api")
    );
  });

  it("recognises its own sentinels and nothing else", () => {
    // `discardWorkingTree` asks this before deriving a directory to clean, so a
    // false negative points `git clean -fdx` somewhere it should not go.
    expect(isSubtaskRepo(subtaskRepo({ taskId: "t", subtaskId: 0 }))).toBe(
      true
    );
    expect(isSubtaskRepo(SCRATCH_REPO)).toBe(false);
    expect(isSubtaskRepo("acme/api")).toBe(false);
  });

  /**
   * `/repo` refuses a branch that is not a plain name, and the push is the other
   * end of that promise — a derived name that tripped those guards would fail
   * every write subtask at the last step.
   */
  it("derives a branch git and the repo plugin will both accept", () => {
    const branch = subtaskBranch({ taskId: "task-a", subtaskId: 3 });

    expect(branch).toBe("claude-coder/task-a/3");
    // The shapes `UNSAFE_BRANCH` exists to refuse.
    expect(branch).not.toMatch(/^[+-]/);
    expect(branch).not.toMatch(/[:^~?*[\\]/);
    expect(branch).not.toMatch(/\.\.|@\{|\.lock$|\/$/);
  });
});

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

/** Enough of the workspace RPC surface for `resolve` to run against. */
function fakeBinding(state: { dir?: string }) {
  const calls: string[] = [];
  const stub = {
    checkoutDir: async () => state.dir,
    gitClone: async () => {
      calls.push("clone");
      state.dir = CHECKOUT.dir;
      return { ok: true as const, detail: "cloned" };
    },
    noteCheckout: async () => {
      calls.push("noteCheckout");
      return { present: true };
    },
    startInstall: async () => {
      calls.push("startInstall");
      return {};
    },
    reclaimIfIdle: async () => {
      calls.push("reclaim");
      return { reclaimed: true, idleMs: 0, bytes: 0 };
    }
  };
  return {
    calls,
    binding: {
      idFromName: (name: string) => name,
      get: () => stub
    } as unknown as Parameters<typeof subtaskWorkspaces>[0]["binding"]
  };
}

function harness(opts: {
  selected?: string;
  checkout?: ActiveCheckout;
  dir?: string;
  execFails?: boolean;
}) {
  const state = { dir: opts.dir };
  const { calls, binding } = fakeBinding(state);
  const commands: string[] = [];
  const envs: Record<string, string>[] = [];
  const active = fakeActive(opts.selected, opts.checkout);
  const subtasks = subtaskWorkspaces({
    binding,
    callerKey: () => "caller",
    exec: async (command, options) => {
      commands.push(command);
      envs.push(options.env ?? {});
      return opts.execFails
        ? { success: false, stdout: "", stderr: "no such ref" }
        : { success: true, stdout: "", stderr: "" };
    },
    active,
    label: "test"
  });
  return { subtasks, calls, commands, envs, active };
}

describe("preparing a writing subtask's workspace", () => {
  const ctx = { taskId: "task-a", subtaskId: 1 };

  it("clones, records, installs and starts the branch", async () => {
    const { subtasks, calls, commands, envs, active } = harness({
      selected: "acme/api",
      checkout: CHECKOUT
    });

    const name = await subtasks.resolve(ctx);

    expect(name).toBe(`caller|${subtaskRepo(ctx)}`);
    expect(calls).toEqual(["clone", "noteCheckout", "startInstall"]);
    expect(commands[0]).toContain("checkout");
    expect(envs[0]).toEqual({ SUBTASK_BRANCH: subtaskBranch(ctx) });
    // Enrolled for the weekly sweep without routing the parent's tools to it: a
    // workspace the sweep cannot see has no backstop but its own alarm.
    expect(active.noted).toEqual([subtaskRepo(ctx)]);
    expect(active.get()).toBe("acme/api");
  });

  /**
   * The retry case, and the reason the early return had to go.
   *
   * A first attempt that clones and then fails — at the install, or at the branch
   * — leaves a tree behind. Returning as soon as one exists would skip everything
   * after the clone, so the branch the parent fetches would never be created and
   * the session would run on the source branch with nowhere to publish.
   */
  it("finishes a setup that a previous attempt left half-done", async () => {
    const { subtasks, calls, envs } = harness({
      selected: "acme/api",
      checkout: CHECKOUT,
      dir: CHECKOUT.dir
    });

    await subtasks.resolve(ctx);

    // Not cloned again — the tree is there.
    expect(calls).not.toContain("clone");
    // But everything after it still ran.
    expect(calls).toEqual(["noteCheckout", "startInstall"]);
    // The branch reaches git as a value, never as command text, so this is where
    // it has to be asserted.
    expect(envs[0]).toEqual({ SUBTASK_BRANCH: subtaskBranch(ctx) });
  });

  /** `checkout -B` would reset the branch and discard a retry's own commits. */
  it("switches to the branch if it exists rather than resetting it", async () => {
    const { subtasks, commands } = harness({
      selected: "acme/api",
      checkout: CHECKOUT
    });

    await subtasks.resolve(ctx);

    expect(commands[0]).not.toContain("checkout -B");
    expect(commands[0]).toContain("|| git checkout -b");
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

  it("refuses when nothing has been cloned at all", async () => {
    const { subtasks } = harness({ selected: "acme/api" });

    // Better than cloning a guess: the parent's soul is told to open a directory
    // before delegating, and this is the sentence that says it did not.
    await expect(subtasks.resolve(ctx)).rejects.toThrow(/nothing for it/);
  });

  it("reclaims the workspace and drops it from the sweep list", async () => {
    const { subtasks, calls, active } = harness({
      selected: "acme/api",
      checkout: CHECKOUT
    });

    await subtasks.reclaim(ctx);

    expect(calls).toEqual(["reclaim"]);
    expect(active.forgotten).toEqual([subtaskRepo(ctx)]);
  });
});

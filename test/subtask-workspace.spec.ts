import { describe, it, expect } from "vitest";
import { workspaceName } from "@dynamicagents/plugins/computer";
import {
  isSubtaskRepo,
  subtaskBranch,
  subtaskRepo
} from "@/workspace/subtask-workspace";
import { SCRATCH_REPO } from "@/workspace/scratch";

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

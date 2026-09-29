import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { TurnConfig, TurnContext } from "@cloudflare/think";
import type { ComputerConfig } from "@dynamicagents/plugins/computer";
import type { ContextConfig } from "agents/context";
import { CODE } from "@/agents/coding/code";
import { container } from "@/agents/coding/plugins";

/**
 * `coding`'s tool surface, pinned.
 *
 * This agent's parent and its sub-agent install **different** plugin lists: the
 * parent orchestrates and reviews with git, a browser and read-only eyes on the
 * container, and every edit is delegated to a sub-agent that holds the shell.
 * That split is held by things a typechecker cannot see — an allowlist of tool
 * *names* passed to `restrictTools`, the `activeTools` a turn runs with, and
 * Think's own `bash` switched off — and each fails quietly: a renamed tool
 * leaves the parent missing one it thinks it has, or holding one it must not.
 * So they are asserted here, on the real classes.
 */

interface Surface {
  getTools(): Record<string, unknown>;
  getActions(): Record<string, unknown>;
  configureContext(): ContextConfig[];
  beforeTurn(ctx: TurnContext): Promise<TurnConfig | void>;
  workspaceBash: boolean;
}

const onParent = <T>(read: (agent: Surface) => T | Promise<T>) => {
  const ns = env.CodingAgent as unknown as DurableObjectNamespace;
  return runInDurableObject(
    ns.get(ns.idFromName(`coding-surface:${crypto.randomUUID()}`)),
    (instance) => read(instance as unknown as Surface)
  );
};

const onChild = <T>(read: (agent: Surface) => T | Promise<T>) => {
  const ns = (env as unknown as Record<string, DurableObjectNamespace>)
    .CODING_CHILD!;
  return runInDurableObject(
    ns.get(ns.idFromName(`coding-surface:${crypto.randomUUID()}`)),
    (instance) => read(instance as unknown as Surface)
  );
};

describe("the parent's tools", () => {
  /**
   * The exact list, not a subset check. A `toContain` here would pass just as
   * happily if `bash` reappeared, which is the single thing this split exists
   * to prevent.
   */
  it("is git, a scratchpad, a browser, grep, and its sub-agent", async () => {
    const tools = await onParent((agent) =>
      Object.keys(agent.getTools()).sort()
    );
    expect(tools).toEqual([
      "ask_user",
      "browser_extract",
      "browser_links",
      "browser_markdown",
      "browser_scrape",
      "check_back",
      "code",
      "grep",
      "repo_clone",
      "repo_commit",
      "repo_diff",
      "repo_fetch",
      // The ones that read the forge's own state. They are the parent's for the
      // same reason the rest of git is: the sub-agent holds the shell and must
      // not also speak for this agent in public.
      "repo_issue_view",
      "repo_open_pr",
      "repo_pr_review_status",
      "repo_pr_threads",
      "repo_pr_view",
      "repo_push",
      "repo_status",
      // A workspace *selection*: a sub-agent holding it could re-point the
      // workspace mid-run. It brings no shell with it.
      "scratch_open",
      "search_history"
    ]);
  });

  it("answers a review through actions, which a recovered turn never repeats", async () => {
    const actions = await onParent((agent) =>
      Object.keys(agent.getActions()).sort()
    );
    expect(actions).toEqual(["repo_pr_comment", "repo_pr_thread_reply"]);
  });

  it("has no way to run a command, write a file, or edit one", async () => {
    const { bash, active } = await onParent(async (agent) => {
      const think = ["read", "write", "edit", "delete", "list", "find", "grep"];
      const tools = Object.fromEntries(
        [...think, ...Object.keys(agent.getTools())].map((name) => [name, {}])
      );
      const turn = await agent.beforeTurn({ tools } as unknown as TurnContext);
      return { bash: agent.workspaceBash, active: turn?.activeTools ?? [] };
    });

    expect(bash).toBe(false);
    for (const forbidden of ["bash", "write", "edit", "delete"]) {
      expect(active).not.toContain(forbidden);
    }
    for (const kept of ["read", "list", "find", "grep", "code"]) {
      expect(active).toContain(kept);
    }
  });

  /**
   * The computer plugin's own block advertises its whole surface. Left in place
   * it would tell the parent it has a shell, and a model told that spends a
   * step discovering otherwise — then reaches for the obvious workaround, which
   * is doing the work itself.
   */
  it("is told it can read the workspace, and not that it has a shell", async () => {
    const text = await onParent(async (agent) => {
      const blocks = agent.configureContext();
      const texts = await Promise.all(
        blocks.map(
          async (block) =>
            (await (
              block.provider as { get?: () => Promise<unknown> }
            )?.get?.()) ?? ""
        )
      );
      return texts.join("\n");
    });
    expect(text).toContain(
      "You can read the workspace the `code` sub-agents work in"
    );
    expect(text).not.toMatch(/`bash`/);
  });
});

describe("the sub-agent's tools", () => {
  it("is the shell, the editor and the browser, and no git", async () => {
    const tools = await onChild((agent) =>
      Object.keys(agent.getTools()).sort()
    );
    expect(tools).toEqual([
      "bash",
      "browser_extract",
      "browser_links",
      "browser_markdown",
      "browser_scrape",
      "edit",
      "grep"
    ]);
  });
});

describe("the verification rule the sub-agent runs under", () => {
  /**
   * A production run edited a README, ran `prettier --check` on that one file,
   * and reported the change verified — nothing was installed and the project's
   * own gate never ran. The old wording asked for "the project's own tests and
   * linters", a standard with no command attached.
   */
  it("names the gate as commands, not as a goal", () => {
    expect(CODE.soul).toContain("Dependencies are installed for you");
    expect(CODE.soul).toContain("npm run check");
    expect(CODE.soul).toContain("npm test");
    expect(CODE.soul).not.toContain("sb_exec");
  });
});

/**
 * The container settings, which every call site has to agree on.
 *
 * A path that builds its own `ComputerConfig` with only `binding` and
 * `workspaceName` runs its commands under a different shell than every other
 * command in the same container — a cancellation's `git reset` once did. It is
 * one exported function, and this is what stops it being two.
 */
describe("the container config", () => {
  it("carries the settings every path depends on", () => {
    const config = container(env, () => "caller|owner/repo");

    // `bash`, not the image's dash: a model writing shell writes bash, and a
    // sub-agent once lost two minutes to `${PIPESTATUS[0]}` failing under dash.
    expect(config.shell).toBe("bash");
    expect(config.cwd).toBe("/workspace");
    expect(config.workspaceName()).toBe("caller|owner/repo");
    expect(config.installGateMs).toBeGreaterThan(0);
    // The plugin's command timeout, which its container-idle window is sized
    // against.
    expect(config.timeoutMs).toBeUndefined();
  });

  it("is the same shape whichever name it is given", () => {
    const a = container(env, () => "one");
    const b = container(env, () => "two");

    // Everything but the two that legitimately differ per workspace.
    const shape = ({
      workspaceName: _name,
      binding: _binding,
      ...rest
    }: ComputerConfig) => rest;
    expect(shape(a)).toEqual(shape(b));
  });
});

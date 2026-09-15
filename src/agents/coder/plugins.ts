import { restrictMainAgentTools, type AgentPlugin } from "@dynamicagents/core";
import type { PluginHost } from "@dynamicagents/core/host";
import { computer, computerExec } from "@dynamicagents/plugins/computer";
import { repo } from "@dynamicagents/plugins/repo";
import { browser } from "@dynamicagents/plugins/browser";
import { activeRepo } from "@/workspace/active-repo";
import {
  DEPENDENCY_TREE_NOTE,
  workspaceContainer
} from "@/workspace/container";
import { workspaceGit } from "@/workspace/git";
import { workspaceName } from "@/workspace/object";
import { hostScratch } from "@/workspace/scratch";
import { code } from "./code";

/**
 * The one file you edit to add or remove a capability for this agent.
 *
 * Delete a line and that module leaves the bundle entirely. Nothing in core
 * imports a plugin, and `@dynamicagents/plugins` has no root barrel — the bare
 * specifier does not resolve — so the guarantee is structural rather than a
 * tree-shaker's opinion. `npm run verify:isolation` asserts it on the built graph.
 *
 * ## Two lists, because the parent and its subagents are not the same agent
 *
 * This agent **always delegates**, and the reason is context. A parent that reads
 * files, runs builds and reads their output accumulates the one session that has
 * to survive the *whole* task, across every round. Pushing the expensive,
 * disposable half into subagents leaves the parent holding a short transcript of
 * decisions.
 *
 * So the parent gets git, a browser, and read-only access to the checkout — enough
 * to check a claim rather than take it on trust. No shell, no writer, no editor.
 *
 * ## Why there is no `workspace()` here
 *
 * `@dynamicagents/plugins/workspace` is a virtual filesystem over this Durable
 * Object's own SQLite; the computer plugin's is a *different* object's SQLite,
 * mounted into a container. Installing both would hand the model two unrelated
 * filesystems and no way to tell from a path which one it is addressing. This
 * agent has exactly one, and it is the one with a compiler in it.
 */

/** The sandbox tools the *parent* keeps: enough to verify, not enough to edit. */
const PARENT_SANDBOX_TOOLS = ["sb_read", "sb_ls", "sb_exists"] as const;

/**
 * What the parent is told about the workspace, replacing the plugin's own block.
 *
 * The plugin's version advertises `sb_exec`, `sb_write` and `sb_edit`, which the
 * parent no longer has. Leaving it in place is not a cosmetic problem: a model
 * told it has a shell spends a turn discovering it does not, and the natural
 * next move — doing the work itself — is the one thing this split exists to
 * prevent.
 */
const PARENT_SANDBOX_CAPABILITY = [
  "You can read the workspace the subagents work in, but not change it:",
  "- `sb_read` reads a file, `sb_ls` lists a directory, `sb_exists` checks a path.",
  "Use these to check a subagent's report against what is actually on disk — read the file it says it changed. You cannot run commands, write, or edit; that is what delegation is for.",
  DEPENDENCY_TREE_NOTE
].join("\n");

/**
 * This agent's container settings.
 *
 * The settings themselves are shared — see `@/workspace/container.ts`, which
 * carries the reason a second copy is not an option. All this adds is which
 * namespace they apply to.
 *
 * Exported because the cancel path in `agent.ts` needs the *same* settings.
 */
export function container(env: Env, workspaceName: () => string) {
  return workspaceContainer(env.CODER_WORKSPACE, workspaceName);
}

/**
 * The main agent's capabilities: git, a browser, and eyes on the checkout.
 *
 * Read the `restrictMainAgentTools` call as the point of this file. The computer
 * and browser plugins are **installed** here, they just do not hand the parent
 * their full surface — and installing them is not optional even for the one that
 * gives the parent nothing, because `validateRecipe` runs on the *parent* and
 * drops any tool family the parent's plugins did not register. A parent that
 * "tidied away" a plugin it does not call would silently delete that family from
 * every recipe its subagents run.
 */
export const parentPlugins = (host: PluginHost<Env>): AgentPlugin[] => {
  const active = activeRepo(host);
  const config = container(host.env, () =>
    workspaceName(host.callerKey(), active.get())
  );
  const workspace = () =>
    host.env.CODER_WORKSPACE.get(
      host.env.CODER_WORKSPACE.idFromName(
        workspaceName(host.callerKey(), active.get())
      )
    );
  /**
   * Hoisted because more than one plugin commits under it now.
   *
   * Defaults to the generic `da-coder` identity — see `.env.example` for
   * `GITHUB_NAME`/`GITHUB_EMAIL` and why. Has to match `defaultGitIdentity` in
   * `src/workspace/object.ts`, or a commit could be attributed differently
   * depending on which side made it.
   */
  const author = {
    name: host.env.GITHUB_NAME || "da-coder",
    email: host.env.GITHUB_EMAIL
  };

  return [
    // Declared first: order in this array is the order the delegating model is
    // shown the subtask types, and `code` is the only one this agent has.
    //
    // It takes the workspace name because it *owns* the `code` type, which makes
    // it the plugin whose `resolveRuntime` core calls — the one hook that runs
    // on the parent, where `host.callerKey()` resolves rather than throwing.
    code({
      workspaceName: () => workspaceName(host.callerKey(), active.get())
    }),
    repo({
      // Composed rather than imported: the repo plugin needs a shell, not a
      // container, so it takes one instead of depending on the computer module.
      // This is also what lets the parent keep git while having no shell of its
      // own — `computerExec` is a function, not a tool.
      exec: computerExec(config),
      // The other half of the same seam, and the reason `exec` above is safe to
      // hand a model with a shell: clone, fetch and push do not go through it.
      // They go here, to the workspace object, which reads `GITHUB_TOKEN` from
      // its own environment — so the container never holds the credential at
      // all, in any command, for any length of time.
      git: workspaceGit({
        binding: host.env.CODER_WORKSPACE,
        // The same name `config` resolves, and it has to be: a push acting on a
        // different workspace than the container writes into would push whatever
        // that other checkout happened to contain.
        workspaceName: config.workspaceName
      }),
      // Still needed, and now only for `repo_open_pr` — the one credentialed
      // call this side makes directly.
      token: () => host.env.GITHUB_TOKEN,
      author,

      // The two hooks that make per-repository workspaces work, and the order
      // between them is the whole design. `beforeCheckout` fires with the parsed
      // URL *before* git runs, so the clone lands in the right workspace rather
      // than in one it would have to be moved out of. `afterCheckout` fires once
      // the tree is there, which is when an install becomes meaningful.
      beforeCheckout: ({ owner, repo: name }) => active.set(`${owner}/${name}`),
      afterCheckout: async ({ dir, repo: name }) => {
        const ws = workspace();
        // Before the install, and never inside it: an install is conditional
        // where a checkout is not, so no install outcome may decide whether the
        // path is recorded. The reasoning is on `noteCheckout` in
        // `src/workspace/object.ts`.
        await ws.noteCheckout({
          dir,
          kind: "repo",
          ...(name ? { repo: name } : {})
        });
        // Returns as soon as the command is spawned — the workspace object
        // drains it. Blocking here would put a 225-second install inside a
        // model turn, which is the failure this whole arrangement avoids.
        await ws.startInstall({
          dir,
          ...(name ? { repo: name } : {})
        });
      }
    }),
    /**
     * A place to work when the work is not a repository.
     *
     * Next to `repo` because it answers the same question — *where does this
     * task happen* — and because the two are alternatives: a task opens a
     * checkout or a scratchpad, never both. It shares `repo`'s shell, its author
     * identity and its workspace thunk, so there is one answer to each of those
     * rather than a second one drifting alongside.
     */
    hostScratch({
      exec: computerExec(config),
      workspace,
      active,
      author
    }),
    restrictMainAgentTools(computer(config), {
      allow: [...PARENT_SANDBOX_TOOLS],
      capability: PARENT_SANDBOX_CAPABILITY
    }),
    // Full surface, for reading documentation an unfamiliar dependency needs.
    // Deliberately last — an agent that reaches for the web before reading the
    // repository in front of it is usually about to solve the wrong problem.
    browser({ binding: host.env.BROWSER })
  ];
};

/**
 * The subagent's capabilities: the shell and the browser, and no git at all.
 *
 * No `repo` here, deliberately. The parent owns the history — it clones,
 * reviews, commits, pushes and opens the pull request — and a subagent sharing
 * the parent's checkout must not also share its ability to rewrite it. Anything
 * a subagent legitimately needs from git (`git status`, `git diff`, `git log`)
 * it can run through `sb_exec`, which is read-only in effect and leaves no
 * credential anywhere near it.
 *
 * `code(...)` **must** be here even though the subagent never delegates:
 * `RecipeSubagentBase` re-checks `types.validateParams(request.type, …)` on its
 * inbound request, which throws `unknown subtask type: code` against a registry
 * that has never heard of it.
 */
export const subagentPlugins = (host: PluginHost<Env>): AgentPlugin[] => {
  const active = activeRepo(host);
  const config = container(host.env, () =>
    workspaceName(host.callerKey(), active.get())
  );

  return [
    // The name resolves from `ctx.runtime` on a subagent, so this thunk is only
    // a fallback — and on a facet `host.callerKey()` throws, which is exactly
    // why the parent puts the resolved name on the runtime in the first place.
    code({ workspaceName: () => config.workspaceName() }),
    computer(config),
    browser({ binding: host.env.BROWSER })
  ];
};

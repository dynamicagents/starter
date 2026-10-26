import { restrictTools, type AgentPlugin } from "@dynamicagents/core";
import {
  computer,
  type SandboxComputerConfig
} from "@dynamicagents/plugins/computer";
import { repo } from "@dynamicagents/plugins/repo-github";
import { browser } from "@dynamicagents/plugins/browser";
import type { ActiveRepo } from "@/workspace/active-repo";
import {
  parentWorkspaceContext,
  SANDBOX_TOOLS,
  sandboxShell
} from "@/workspace/container";
import { sandboxGit } from "@/workspace/git";
import { gitIdentity } from "@/workspace/git-identity";
import { hostScratch } from "@/workspace/scratch";

/**
 * The one file you edit to add or remove a capability for this agent.
 *
 * Delete a line and that module leaves the bundle entirely. Nothing in core
 * imports a plugin, and `@dynamicagents/plugins` has no root barrel — the bare
 * specifier does not resolve — so the guarantee is structural rather than a
 * tree-shaker's opinion. `npm run verify:isolation` asserts it on the built graph.
 *
 * ## Two lists, because the parent and its sub-agent are not the same agent
 *
 * This agent **always delegates**, and the reason is context. A parent that reads
 * files, runs builds and reads their output accumulates the one conversation
 * that has to survive the *whole* task. Pushing the expensive, disposable half
 * into a sub-agent leaves the parent holding a short transcript of decisions.
 *
 * So the parent gets git, a browser, and read-only access to the checkout — enough
 * to check a claim rather than take it on trust. No shell, no writer, no editor:
 * `restrictTools` keeps only `grep` of the computer plugin's own tools, and
 * `./agent.ts` leaves Think's file writers out of the turn and installs a
 * workspace with no runtime, which is what denies it a shell at all.
 */

/**
 * Where this agent's tools reach: the sandbox `sandboxName` names, in this
 * agent's namespace. The tools' own settings are shared — see
 * `@/workspace/container.ts`, which carries the reason a second copy is not an
 * option.
 */
export function place(
  env: Env,
  sandboxName: () => string
): SandboxComputerConfig {
  return { binding: env.CODING_SANDBOX, sandboxName };
}

/**
 * The parent's capabilities: git, a scratchpad, a browser, and eyes on the
 * checkout.
 *
 * `active` is the agent's own selection, one instance shared with its
 * `workspace`: the selection caches what it last read, so a second instance
 * would go on answering the repository the first had already moved away from.
 */
export const parentPlugins = (
  env: Env,
  active: ActiveRepo,
  at: SandboxComputerConfig
): AgentPlugin<Env>[] => {
  const sandbox = () => env.CODING_SANDBOX.getByName(at.sandboxName());
  const shell = sandboxShell(env.CODING_SANDBOX, at.sandboxName);
  /** Shared with every command the sandbox runs — see `@/workspace/git-identity`. */
  const author = gitIdentity(env);

  return [
    repo({
      // Composed rather than imported: the repo plugin needs a shell, not a
      // container, so it takes one instead of depending on the computer module.
      // This is also what lets the parent keep git while having no shell of its
      // own — a shell here is a function, not a tool.
      exec: shell,
      // Clone, fetch and push: the container's git, with a placeholder the
      // egress swaps for `GITHUB_TOKEN` on the Worker side, so the container
      // never holds the credential — see `@/workspace/git.ts`.
      git: sandboxGit({
        binding: env.CODING_SANDBOX,
        // The same name the shell resolves, and it has to be: a push acting on
        // a different sandbox than the one written into would push whatever
        // that other checkout happened to contain.
        sandboxName: at.sandboxName
      }),
      // Still needed, and now only for `repo_open_pr` — the one credentialed
      // call this side makes directly.
      token: () => env.GITHUB_TOKEN,
      author,

      // The two hooks that make per-repository workspaces work, and the order
      // between them is the whole design. `beforeCheckout` fires with the parsed
      // URL *before* git runs, so the clone lands in the right workspace rather
      // than in one it would have to be moved out of. `afterCheckout` fires once
      // the tree is there, which is when an install becomes meaningful.
      beforeCheckout: ({ owner, repo: name }) => active.set(`${owner}/${name}`),
      afterCheckout: async ({ dir, repo: name }) => {
        const ws = sandbox();
        // Before the install, and never inside it: an install is conditional
        // where a checkout is not, so no install outcome may decide whether the
        // path is recorded — and a recorded checkout is what the sandbox backs
        // up and brings back.
        await ws.noteCheckout({
          dir,
          kind: "repo",
          ...(name ? { repo: name } : {})
        });
        // Returns as soon as the command is spawned — the sandbox drains it.
        // Blocking here would put a 225-second install inside a model turn,
        // which is the failure this whole arrangement avoids.
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
    hostScratch({ exec: shell, workspace: sandbox, active, author }),
    restrictTools(computer(SANDBOX_TOOLS), {
      allow: ["grep"],
      context: [
        {
          provider: {
            get: async () => parentWorkspaceContext("the `code` sub-agents")
          }
        }
      ]
    }),
    // Full surface, for reading documentation an unfamiliar dependency needs.
    // Deliberately last — an agent that reaches for the web before reading the
    // repository in front of it is usually about to solve the wrong problem.
    browser({ binding: env.BROWSER })
  ];
};

/**
 * The sub-agent's capabilities: the shell, the editor and the browser, and no
 * git at all.
 *
 * **No `repo` here, deliberately.** The parent owns the history — it clones,
 * reviews, commits, pushes and opens the pull request — and a sub-agent
 * sharing the parent's checkout must not also share its ability to rewrite it.
 * `repo_commit` and `repo_push` would otherwise sit behind prose alone. Anything
 * a sub-agent legitimately needs from git (`git status`, `git diff`, `git log`)
 * it runs through `exec`, which leaves no credential anywhere near it.
 */
export const childPlugins = (env: Env): AgentPlugin<Env>[] => [
  computer(SANDBOX_TOOLS),
  browser({ binding: env.BROWSER })
];

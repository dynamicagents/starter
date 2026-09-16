import { restrictMainAgentTools, type AgentPlugin } from "@dynamicagents/core";
import type { PluginHost } from "@dynamicagents/core/host";
import { claudeCode } from "@dynamicagents/plugins/claude-code";
import { computer, computerExec } from "@dynamicagents/plugins/computer";
import { repo } from "@dynamicagents/plugins/repo";
import { browser } from "@dynamicagents/plugins/browser";
import { recall } from "@dynamicagents/plugins/recall";
import { RECALL } from "@/config";
import { activeRepo } from "@/workspace/active-repo";
import {
  DEPENDENCY_TREE_NOTE,
  workspaceContainer
} from "@/workspace/container";
import { workspaceGit } from "@/workspace/git";
import { workspaceName } from "@dynamicagents/plugins/computer";
import { gitIdentity } from "@/workspace/git-identity";
import { hostScratch } from "@/workspace/scratch";
import { claudeCodeConfig } from "./claude-code";

/**
 * The one file you edit to add or remove a capability for this agent.
 *
 * ## Two lists, and the split is sharper here than in the coder
 *
 * The coder's parent delegates because a parent that reads files and runs builds
 * accumulates a session nobody can keep warm. That reason applies here too — and
 * a second one lands on top of it: **the subagent is not running core's loop at
 * all.** A `claude-code` subtask is one `claude -p` session inside the container,
 * with its own tools, its own context management and its own system prompt.
 * There is nothing for the parent's plugins to lend it.
 *
 * So the subagent list below is one entry long, and that is not an oversight.
 *
 * ## Why there is no `workspace()` here
 *
 * `@dynamicagents/plugins/workspace` is a virtual filesystem over the *agent's* own
 * SQLite. The computer plugin's filesystem is a *different* Durable Object's
 * SQLite, mounted into a container. Installing both would hand the model two
 * unrelated filesystems and no way to tell from a path which one it is
 * addressing.
 */

/** The sandbox tools the *parent* keeps: enough to verify, not enough to edit. */
const PARENT_SANDBOX_TOOLS = ["sb_read", "sb_ls", "sb_exists"] as const;

/**
 * What the parent is told about the workspace, replacing the plugin's own block.
 *
 * The plugin's version advertises `sb_exec`, `sb_write` and `sb_edit`, which the
 * parent does not have. Leaving it in place is not cosmetic: a model told it has
 * a shell spends a turn discovering it does not, and the natural next move —
 * doing the work itself — is the one thing this split exists to prevent.
 */
const PARENT_SANDBOX_CAPABILITY = [
  "You can read the workspace the Claude Code sessions work in, but not change it:",
  "- `sb_read` reads a file, `sb_ls` lists a directory, `sb_exists` checks a path.",
  "Use these to check a session's report against what is actually on disk — read the file it says it changed. You cannot run commands, write, or edit.",
  DEPENDENCY_TREE_NOTE
].join("\n");

/**
 * This agent's container settings — the shared ones, pointed at its namespace.
 *
 * Exported because the cancel path needs the *same* settings; see the outage
 * comment on `@/workspace/container.ts`.
 */
export function container(env: Env, name: () => string) {
  return workspaceContainer(env.CLAUDE_CODER_WORKSPACE, name);
}

/**
 * The parent: git, a browser, memory, and read-only eyes on the checkout.
 *
 * Read the `restrictMainAgentTools` call as the point of this file. The computer
 * plugin is **installed** here, it just does not hand the parent its full
 * surface — and installing it is not optional, because `validateRecipe` runs on
 * the *parent* and drops any tool family the parent's plugins did not register.
 */
export const parentPlugins = (host: PluginHost<Env>): AgentPlugin[] => {
  const active = activeRepo(host);
  const name = () => workspaceName(host.callerKey(), active.get());
  const config = container(host.env, name);
  const workspace = () =>
    host.env.CLAUDE_CODER_WORKSPACE.get(
      host.env.CLAUDE_CODER_WORKSPACE.idFromName(name())
    );
  /** Shared with the workspace object — see `@/workspace/git-identity`. */
  const author = gitIdentity(host.env);

  return [
    /**
     * Declared first: order in this array is the order the delegating model is
     * shown the subtask types, and `claude-code` is the only one this agent has.
     *
     * It takes the whole config, not just a name, because it is the plugin whose
     * `resolveRuntime` core calls — the one hook that runs on the parent, where
     * `host.callerKey()` resolves rather than throwing. What that hook writes is
     * how the facet finds this workspace; without it a delegated session has no
     * way to address the container holding the checkout it was told to work in.
     */
    claudeCode(claudeCodeConfig(host.env, name)),
    repo({
      // Composed rather than imported: the repo plugin needs a shell, not a
      // container, so it takes one instead of depending on the computer module.
      // This is also what lets the parent keep git while having no shell of its
      // own — `computerExec` is a function, not a tool.
      exec: computerExec(config),
      // The other half of the same seam, and the reason `exec` above is safe to
      // hand a model with a shell: clone, fetch and push do not go through it.
      // They go to the workspace object, which reads `GITHUB_TOKEN` from its own
      // environment — so the container never holds the credential at all.
      git: workspaceGit({
        binding: host.env.CLAUDE_CODER_WORKSPACE,
        workspaceName: config.workspaceName
      }),
      // Still needed, and now only for `repo_open_pr` — the one credentialed
      // call this side makes directly.
      token: () => host.env.GITHUB_TOKEN,
      author,

      beforeCheckout: ({ owner, repo: repoName }) =>
        active.set(`${owner}/${repoName}`),
      afterCheckout: async ({ dir, repo: repoName }) => {
        const ws = workspace();
        // Before the install, and never inside it: an install is conditional
        // where a checkout is not, so no install outcome may decide whether the
        // path is recorded. The reasoning is on `noteCheckout` in the
        // workspace host, in `@dynamicagents/plugins/computer`.
        await ws.noteCheckout({
          dir,
          kind: "repo",
          ...(repoName ? { repo: repoName } : {})
        });
        // Returns as soon as the command is spawned — the workspace object
        // drains it. Blocking here would put a 225-second install inside a model
        // turn, which is the failure this whole arrangement avoids.
        await ws.startInstall({
          dir,
          ...(repoName ? { repo: repoName } : {})
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
    /**
     * Episodic memory, which the coder deliberately does without.
     *
     * It earns its place here for a reason specific to this agent: a session is
     * expensive to start and the parent's own context is short, so "we tried
     * this three tasks ago and it did not work" is exactly the kind of thing
     * worth not paying to rediscover.
     */
    recall({
      ai: host.env.AI,
      index: host.env.VECTORIZE,
      namespace: host.callerKey,
      // The host's *resolved* AI Gateway id, so embedding calls are correlated with
      // chat calls. Spread the rest: enumerating each field silently drops any
      // option the plugin adds later.
      aiGatewayId: host.aiGatewayId,
      ...RECALL
    }),
    restrictMainAgentTools(computer(config), {
      allow: [...PARENT_SANDBOX_TOOLS],
      capability: PARENT_SANDBOX_CAPABILITY
    }),
    // Deliberately last — an agent that reaches for the web before reading the
    // repository in front of it is usually about to solve the wrong problem.
    browser({ binding: host.env.BROWSER })
  ];
};

/**
 * The subagent: one entry, and it registers a type rather than lending a tool.
 *
 * `CLAUDE_CODE_RECIPE.toolFamilies` is `[]`, so there is genuinely nothing here
 * for core to build — the session's tools are Claude Code's, inside the
 * container. What this line buys is that `RecipeSubagentBase` re-checks
 * `types.validateParams(request.type, …)` on its inbound request, and against an
 * empty registry that throws `unknown subtask type: claude-code` before
 * `executeChunk` ever runs.
 *
 * The workspace name thunk would throw on a facet — `callerKey()` is
 * deliberately unavailable there — so it is never called on this side. The name
 * arrives on `ctx.runtime`, put there by the parent's copy of this same plugin.
 */
export const subagentPlugins = (host: PluginHost<Env>): AgentPlugin[] => [
  claudeCode(
    claudeCodeConfig(host.env, () => {
      throw new Error(
        "claude-coder: a subagent resolves its workspace from ctx.runtime, " +
          "never from the caller identity — see plugins.ts"
      );
    })
  )
];

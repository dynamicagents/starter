import {
  restrictTools,
  type AgentPlugin,
  type PluginContext
} from "@dynamicagents/core";
import {
  claudeCodeSession,
  type SessionRuntime
} from "@dynamicagents/plugins/claude-code";
import { computer, type ComputerConfig } from "@dynamicagents/plugins/computer";
import { openWorkspace, workspaceExec } from "@dynamicagents/plugins/workspace";
import { repo } from "@dynamicagents/plugins/repo";
import { browser } from "@dynamicagents/plugins/browser";
import { activeRepo, type ActiveRepo } from "@/workspace/active-repo";
import {
  subtaskWorkspaces,
  type SubtaskWorkspaces
} from "@/workspace/subtask-workspace";
import { sqlPoolStore } from "@/workspace/worktree-pool";
import { worktreeSwitch } from "@/workspace/worktrees";
import {
  parentWorkspaceContext,
  workspaceContainer
} from "@/workspace/container";
import { workspaceGit } from "@/workspace/git";
import { gitIdentity } from "@/workspace/git-identity";
import { hostScratch } from "@/workspace/scratch";
import { claudeCodeConfig } from "./claude-code";
import { anthropicCoding } from "./definition";

/**
 * The one file you edit to add or remove a capability for this agent.
 *
 * ## The parent's list, and nothing for the sessions
 *
 * `coding`'s parent delegates because a parent that reads files and runs builds
 * accumulates a conversation nobody can keep warm. That reason applies here too
 * — and a second one lands on top of it: **a session is not a model loop at
 * all.** It is one `claude -p` process inside the container, with its own tools,
 * its own context management and its own system prompt. There is nothing for
 * the parent's plugins to lend it, so the sub-agents in `./children.ts` install
 * none.
 */

/**
 * This agent's container settings — the shared ones, pointed at its namespace.
 * See the outage comment on `@/workspace/container.ts`.
 */
export function container(env: Env, name: () => string): ComputerConfig {
  return workspaceContainer(env.ANTHROPIC_CODING_WORKSPACE, name);
}

/** Stop a run's session in a workspace: both execs. */
export async function stopSession(
  env: Env,
  workspace: string,
  runId: string
): Promise<void> {
  const binding = env.ANTHROPIC_CODING_WORKSPACE;
  using opened = await openWorkspace(
    binding.get(binding.idFromName(workspace))
  );
  await claudeCodeSession(claudeCodeConfig(env)).stop(
    opened.runtime as SessionRuntime,
    runId
  );
}

/** What to say when the whole credential pool is unavailable. */
function exhausted(retryAt: number | undefined): string {
  if (retryAt === undefined) {
    return (
      "no Anthropic credential in this deployment is usable, and none will " +
      "recover on its own — every one was rejected, or none is configured. " +
      "An operator has to mint a fresh `claude setup-token` credential. " +
      "Nothing was changed in the repository."
    );
  }
  return (
    "every Anthropic credential in this deployment has reached its " +
    `subscription limit. The earliest resets at ${new Date(retryAt).toISOString()}. ` +
    "Nothing was changed in the repository — send this request again after that."
  );
}

/**
 * Refuse a session the credential pool cannot pay for, before its container
 * starts — what that saves is on `credentials` in
 * `@dynamicagents/plugins/claude-code`. From `prepare`, not `brief`: a writer's
 * worktree is cloned before `brief` runs. The refusal is the tool's answer,
 * with the reset time in it, and nothing is dispatched.
 *
 * Asked of the workspace the session runs in, because each keeps its own pool:
 * see `./workspace.ts`.
 */
export async function admitSession(env: Env, workspace: string): Promise<void> {
  const binding = env.ANTHROPIC_CODING_WORKSPACE;
  const lead = await binding
    .get(binding.idFromName(workspace))
    .claudeCredentials();
  if (!lead.ok) throw new Error(exhausted(lead.retryAt));
}

/**
 * Where a writing session works, and what becomes of it — built from the
 * parent's context, which is what `prepare` and `settle` are handed.
 *
 * A fresh selection each time rather than the agent's own instance: this reads
 * the selection and never moves it, and a fresh one reads what is stored.
 */
export function sessionWorkspaces(ctx: PluginContext<Env>): SubtaskWorkspaces {
  const env = ctx.env;
  return subtaskWorkspaces({
    binding: env.ANTHROPIC_CODING_WORKSPACE,
    callerKey: () => ctx.callerKey(),
    // The same settings the parent's own tools run under — `shell: "bash"`
    // above all — pointed at whichever worktree is being prepared. A partial
    // copy of this config has already cost an outage; see
    // `@/workspace/container.ts`.
    exec: (command, options, workspace) =>
      workspaceExec(container(env, () => workspace))(command, options),
    stopSession: (workspace, runId) => stopSession(env, workspace, runId),
    admit: (workspace) => admitSession(env, workspace),
    active: activeRepo(ctx.storage),
    pool: sqlPoolStore(ctx.storage),
    // The tenant id is where this name lives; `./agent.ts` spells its own log
    // prefix from the same place.
    label: anthropicCoding.tenant
  });
}

/**
 * The parent: git, a scratchpad, a browser, and read-only eyes on the checkout.
 *
 * `active` is the agent's own selection, one instance shared with its
 * `workspace`: the selection caches what it last read, so a second instance
 * would go on answering the repository the first had already moved away from.
 */
export const parentPlugins = (
  env: Env,
  ctx: { storage: DurableObjectStorage; callerKey: () => string },
  active: ActiveRepo,
  config: ComputerConfig
): AgentPlugin<Env>[] => {
  const binding = env.ANTHROPIC_CODING_WORKSPACE;
  /** How the parent's tools move into the worktrees and back — see `@/workspace/worktrees`. */
  const worktrees = worktreeSwitch({
    active,
    pool: sqlPoolStore(ctx.storage),
    binding,
    callerKey: ctx.callerKey
  });
  const workspace = () =>
    binding.get(binding.idFromName(config.workspaceName()));
  /** Shared with the workspace object — see `@/workspace/git-identity`. */
  const author = gitIdentity(env);

  return [
    repo({
      // Composed rather than imported: the repo plugin needs a shell, not a
      // container, so it takes one instead of depending on the computer module.
      // This is also what lets the parent keep git while having no shell of its
      // own — `workspaceExec` is a function, not a tool.
      exec: workspaceExec(config),
      // The other half of the same seam, and the reason `exec` above is safe to
      // hand a model with a shell: clone, fetch and push do not go through it.
      // They go to the workspace object, which reads `GITHUB_TOKEN` from its own
      // environment — so the container never holds the credential at all.
      git: workspaceGit({ binding, workspaceName: config.workspaceName }),
      // Still needed, and now only for `repo_open_pr` — the one credentialed
      // call this side makes directly.
      token: () => env.GITHUB_TOKEN,
      author,

      beforeCheckout: ({ owner, repo: repoName }) =>
        active.set(`${owner}/${repoName}`),
      afterCheckout: async ({ dir, repo: repoName, url, branch }) => {
        const ws = workspace();
        // Recorded so a writing session can clone the same thing into a
        // container of its own. The url has already been through this plugin's
        // host allowlist, which is why it is the one worth keeping.
        active.setCheckout({ url, dir, branch });
        // Before the install, and never inside it: an install is conditional
        // where a checkout is not, so no install outcome may decide whether the
        // path is recorded. The reasoning is on `noteCheckout` in the
        // workspace object, in `@dynamicagents/plugins/workspace`.
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
      },
      // The worktrees writing sessions commit in, and the switch into them. The
      // hooks are what a worktree adds to this plugin's own guards: a session may
      // still be in it, and a session had a shell over its `.git/config`.
      worktrees,
      beforeWrite: worktrees.beforeWrite,
      afterPush: worktrees.afterPush
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
    hostScratch({ exec: workspaceExec(config), workspace, active, author }),
    restrictTools(computer(config), {
      allow: ["grep"],
      context: [
        {
          provider: {
            get: async () => parentWorkspaceContext("the Claude Code sessions")
          }
        }
      ]
    }),
    // Deliberately last — an agent that reaches for the web before reading the
    // repository in front of it is usually about to solve the wrong problem.
    browser({ binding: env.BROWSER })
  ];
};

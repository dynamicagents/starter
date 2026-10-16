import {
  restrictTools,
  type AgentPlugin,
  type PluginContext
} from "@dynamicagents/core";
import {
  sandboxComputer,
  type SandboxComputerConfig
} from "@dynamicagents/plugins/computer";
import { repo } from "@dynamicagents/plugins/repo-github";
import { browser } from "@dynamicagents/plugins/browser";
import { activeRepo, type ActiveRepo } from "@/workspace/active-repo";
import {
  gitmodulesOf,
  submoduleRepos,
  subtaskWorkspaces,
  type SubtaskWorkspaces
} from "@/workspace/subtask-workspace";
import { sqlPoolStore } from "@/workspace/worktree-pool";
import { worktreeSwitch } from "@/workspace/worktrees";
import {
  parentWorkspaceContext,
  SANDBOX_TOOLS,
  sandboxShell
} from "@/workspace/container";
import { sandboxGit } from "@/workspace/git";
import { gitIdentity } from "@/workspace/git-identity";
import { hostScratch } from "@/workspace/scratch";
import { claudeCoordinator } from "./definition";

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
 * Where this agent's tools reach: the sandbox `sandboxName` names, in this
 * agent's namespace. The tools' own settings are shared — see the outage
 * comment on `SANDBOX_TOOLS` in `@/workspace/container.ts`.
 */
export function place(
  env: Env,
  sandboxName: () => string
): SandboxComputerConfig {
  return { binding: env.CLAUDE_COORDINATOR_SANDBOX, sandboxName };
}

/**
 * Stop a run's session in a sandbox. Returns once its CLI has left and its
 * last files are synced — `stopRun` in `@dynamicagents/plugins/sandbox` — so
 * what keeps its work commits nothing it is still writing.
 */
export async function stopSession(
  env: Env,
  sandbox: string,
  runId: string
): Promise<void> {
  await env.CLAUDE_COORDINATOR_SANDBOX.getByName(sandbox).stopRun(runId);
}

/** What to say when the deployment has no Anthropic credential to try. */
const NO_CREDENTIAL =
  "no Anthropic credential is configured in this deployment. An operator " +
  "has to set a `claude setup-token` credential. Nothing was changed in the " +
  "repository.";

/**
 * Admit a session: reopen the credential pool, so the session asks Anthropic
 * again rather than trusting a stored reset — `admit` in
 * `@dynamicagents/plugins/claude-code` says why. A spent pool still admits; the
 * session ends on the egress gateway's `429` naming the earliest reset. Only a
 * deployment with no credential is refused here, before anything is dispatched.
 *
 * Asked of the sandbox the session runs in, because each keeps its own pool:
 * see `./sandbox.ts`.
 */
export async function admitSession(env: Env, sandbox: string): Promise<void> {
  const lead =
    await env.CLAUDE_COORDINATOR_SANDBOX.getByName(sandbox).claudeAdmit();
  if (!lead.ok) throw new Error(NO_CREDENTIAL);
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
    binding: env.CLAUDE_COORDINATOR_SANDBOX,
    callerKey: () => ctx.callerKey(),
    // The same shell the parent's own commands run in, pointed at whichever
    // worktree is being prepared.
    exec: (command, options, sandbox) =>
      sandboxShell(env.CLAUDE_COORDINATOR_SANDBOX, () => sandbox)(
        command,
        options
      ),
    stopSession: (sandbox, runId) => stopSession(env, sandbox, runId),
    admit: (sandbox) => admitSession(env, sandbox),
    active: activeRepo(ctx.storage),
    pool: sqlPoolStore(ctx.storage),
    // The tenant id is where this name lives; `./agent.ts` spells its own log
    // prefix from the same place.
    label: claudeCoordinator.tenant
  });
}

/**
 * The parent: a checkout to open and pull requests to watch, a scratchpad, a
 * browser, and read-only eyes on the checkout.
 *
 * `active` is the agent's own selection, which its `workspace` reads too — the
 * one instance `activeRepo` hands everything on this storage.
 */
export const parentPlugins = (
  env: Env,
  ctx: { storage: DurableObjectStorage; callerKey: () => string },
  active: ActiveRepo,
  at: SandboxComputerConfig
): AgentPlugin<Env>[] => {
  const binding = env.CLAUDE_COORDINATOR_SANDBOX;
  /** The writing sessions' worktrees — see `@/workspace/worktrees`. */
  const worktrees = worktreeSwitch({
    active,
    pool: sqlPoolStore(ctx.storage),
    binding,
    callerKey: ctx.callerKey
  });
  const sandbox = () => binding.getByName(at.sandboxName());
  const shell = sandboxShell(binding, at.sandboxName);
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
      git: sandboxGit({ binding, sandboxName: at.sandboxName }),
      // For the GitHub reads the coordinator watches a pull request with.
      token: () => env.GITHUB_TOKEN,
      author,
      // The coordinator reads; the sessions write. A pull request, its review
      // and its replies are a session's — see `githubToken` in `./claude-code.ts`.
      tools: [
        "repo_clone",
        "repo_issue_view",
        "repo_pr_view",
        "repo_pr_threads",
        "repo_pr_checks",
        "repo_worktrees",
        "repo_worktree"
      ],

      beforeCheckout: ({ owner, repo: repoName }) =>
        active.set(`${owner}/${repoName}`),
      afterCheckout: async ({ dir, repo: repoName, url, branch }) => {
        const ws = sandbox();
        // Recorded so a writing session can clone the same thing into a
        // container of its own. The url has already been through this plugin's
        // host allowlist, which is why it is the one worth keeping. With the
        // repositories it carries, so a session for any of them works in this
        // one — see `rootOf` in `@/workspace/active-repo`.
        const gitmodules = await gitmodulesOf(ws, dir);
        active.setCheckout(
          { url, dir, branch },
          {
            repo: repoName,
            ...(gitmodules === undefined
              ? {}
              : { submodules: submoduleRepos(gitmodules, url) })
          }
        );
        // Before the install, and never inside it: an install is conditional
        // where a checkout is not, so no install outcome may decide whether the
        // path is recorded — and a recorded checkout is what the sandbox backs
        // up and brings back.
        await ws.noteCheckout({
          dir,
          kind: "repo",
          ...(repoName ? { repo: repoName } : {})
        });
        // Returns as soon as the command is spawned — the sandbox drains it.
        // Blocking here would put a 225-second install inside a model turn,
        // which is the failure this whole arrangement avoids.
        await ws.startInstall({
          dir,
          ...(repoName ? { repo: repoName } : {})
        });
      },
      // The worktrees writing sessions commit in: to read one, list what a
      // canceled session kept, and release what will not be continued.
      worktrees
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
    restrictTools(sandboxComputer(SANDBOX_TOOLS), {
      allow: ["grep"],
      context: [
        {
          provider: {
            get: async () => parentWorkspaceContext("the Claude Code sessions")
          }
        },
        // Re-read every turn and sent again whenever it moves: a selection
        // moved without the model hearing of it is one its last `repo_worktree`
        // answer still describes, so it reads the wrong checkout.
        {
          label: "reads",
          description: "where your file reads and repo tools run right now",
          whenChanged: "remind",
          provider: { get: async () => worktrees.where() }
        }
      ]
    }),
    // Deliberately last — an agent that reaches for the web before reading the
    // repository in front of it is usually about to solve the wrong problem.
    browser({ binding: env.BROWSER })
  ];
};

import {
  sandboxRepoGit,
  type RepoGit,
  type SandboxGitHost
} from "@dynamicagents/plugins/repo-github";

/**
 * `/repo`'s credentialed half — clone, fetch and push — in the sandbox that
 * holds the checkout.
 *
 * The counterpart to the shell `./container.ts` hands `/repo`, and on the same
 * side of the boundary now: git runs in the container, as the agent, with a
 * placeholder, and the token is swapped in by the egress on the Worker side —
 * `githubSandboxEgress` in `@dynamicagents/plugins/repo-github` carries the
 * rest. So this file is only an address. It resolves the same sandbox the
 * shell does, which it must, or a push would act on a checkout the shell never
 * saw.
 *
 * Shared by every agent with a sandbox, so the address cannot drift per agent.
 *
 * **No `runtime` parameter**, deliberately. The shell takes one so a sub-agent
 * can reach its parent's container; `/repo` is installed on the parent alone,
 * so a sub-agent sharing the checkout cannot rewrite its history.
 */
export function sandboxGit(config: {
  /** Whichever agent's sandbox namespace this call belongs to. */
  binding: DurableObjectNamespace<SandboxGitHost & Rpc.DurableObjectBranded>;
  sandboxName: () => string;
}): RepoGit {
  // Per call, never memoised: the name depends on caller and repository, neither
  // knowable when the plugin list is built. A stub captured once would send a
  // second caller's push into the first caller's checkout.
  return sandboxRepoGit(() => config.binding.getByName(config.sandboxName()));
}

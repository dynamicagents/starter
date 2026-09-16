import type { RepoGit, RepoGitResult } from "@dynamicagents/plugins/repo";
import type { WorkspaceObjectBase } from "@dynamicagents/plugins/computer";

/**
 * `/repo`'s credentialed half, wired to the Durable Object that owns the files.
 *
 * The counterpart to `computerExec`, and the same shape of thing — a function
 * the plugin is handed rather than a module it imports — but on the other side
 * of the trust boundary. `computerExec` sends a command into the container,
 * where the model has a root shell and no credential exists; this sends clone,
 * fetch and push to the `WorkspaceObjectBase` subclass that holds `GITHUB_TOKEN`
 * and never passes it on.
 *
 * Git runs *there* rather than here because git needs the filesystem, and the
 * filesystem is that object's SQLite: anywhere else, every object read and ref
 * write is an RPC round trip. So this file is only an address — it resolves the
 * same workspace `computerExec` does, which it must, or a push would act on a
 * checkout the container never saw.
 *
 * Shared by every agent with a workspace, and it has to be: the credential rule
 * below is the one thing about git in this repository that must not be
 * re-implemented per agent.
 *
 * **No `runtime` parameter**, deliberately. `computerExec` takes one so a
 * delegated subagent can reach its parent's container; `/repo` is installed on
 * the parent alone, precisely so a subagent sharing the checkout cannot rewrite
 * its history.
 */
export function workspaceGit(config: {
  /**
   * Whichever agent's workspace namespace this call belongs to.
   *
   * Typed on the shared base rather than on one agent's class: the three RPCs
   * below are declared there, and naming a concrete subclass would make this
   * function the coder's alone for no reason a caller could act on.
   */
  binding: DurableObjectNamespace<WorkspaceObjectBase>;
  workspaceName: () => string;
}): RepoGit {
  // Per call, never memoised: the name depends on caller and repository, neither
  // knowable when the plugin list is built. A stub captured once would send a
  // second caller's push into the first caller's checkout.
  const stub = () =>
    config.binding.get(config.binding.idFromName(config.workspaceName()));

  return {
    clone: (req): Promise<RepoGitResult> => stub().gitClone(req),
    fetch: (req): Promise<RepoGitResult> => stub().gitFetch(req),
    push: (req): Promise<RepoGitResult> => stub().gitPush(req)
  };
}

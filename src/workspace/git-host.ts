import type { RepoGitResult } from "@dynamicagents/plugins/repo";
import type { AuthCallback, GitClient } from "@cloudflare/computer/git";

/**
 * The three git operations that need the forge token, run on this side.
 *
 * They are here rather than on the `WorkspaceStub` the plugin already holds
 * because `WorkspaceGitStub` exposes only `cli(argv)` across a Durable Object
 * boundary, and argv cannot carry an `onAuth` callback. Routed through here, the
 * credential is read from the workspace object's own `env` and never crosses an
 * RPC boundary, never appears in an argument list, and never enters the
 * container.
 *
 * That last clause is the point, and it is why running credentialed `git` in the
 * container is not an option however carefully it is sandboxed: git executes
 * whatever `.git/config` and `.git/hooks` name, the model has a root shell on
 * that filesystem, and even a disposable git dir leaves the token readable
 * through `/proc` for the life of the process. isomorphic-git runs here and has
 * no hooks, no `ext::` transport, no template directory and no credential
 * helpers.
 *
 * **The caller owns the preconditions.** Bringing the workspace up to date is
 * the workspace object's job and it must happen first: git here reads this
 * object's SQLite, so a commit made in the container that has not been pulled
 * yet is a commit this code cannot see. See `#git` in `./object.ts`.
 */

export interface GitHostDeps {
  /** The workspace's own client — isomorphic-git over the local store. */
  git: () => GitClient;
  /** The forge credential, read at the moment it would be handed over. */
  token: () => string | undefined;
  tag: () => string;
}

export class WorkspaceGitHost {
  constructor(private readonly deps: GitHostDeps) {}

  /**
   * Each operation takes `url` explicitly rather than a remote name: resolving
   * `origin` would read `.git/config`, a workspace file a co-installed shell
   * tool can write.
   */
  async clone(req: {
    url: string;
    dir: string;
    allowedHosts: string[];
    branch?: string;
    depth?: number;
  }): Promise<RepoGitResult> {
    return this.#run(req.allowedHosts, async (git, onAuth) => {
      // Spelled out rather than `git.clone`, and the reason is the credential.
      //
      // `clone` is the one network operation the client does not give an
      // `onAuth` callback — it authenticates only through a `headers` option,
      // which means attaching the token to the very first request to a URL the
      // *model* chose. Composing the same work out of `fetch` puts every
      // credentialed request on this side of `onAuth` instead, where the host is
      // checked at the moment the token would be handed over. The cost is four
      // calls instead of one; `clone` is these four.
      await git.init({ dir: req.dir });
      await git.remoteAdd({
        dir: req.dir,
        name: "origin",
        url: req.url,
        force: true
      });
      const fetched = await git.fetch({
        url: req.url,
        dir: req.dir,
        onAuth,
        // `depth: 0` means full history to isomorphic-git, so a caller that
        // asked for nothing gets the shallow default rather than the whole repo.
        depth: req.depth ?? 1,
        singleBranch: true,
        tags: false,
        ...(req.branch ? { ref: req.branch } : {})
      });
      const landed =
        req.branch ?? fetched.defaultBranch?.replace(/^refs\/heads\//, "");
      if (!landed)
        throw new Error(
          `cloned ${req.url} but the remote named no default branch to check out`
        );
      await git.checkout({ dir: req.dir, ref: landed });
      // What a real `git clone` writes and the container's git will look for:
      // without it the branch tracks nothing, and a subagent reaching for a bare
      // `git status` in the shell sees a branch with no upstream.
      await git.configSet({
        dir: req.dir,
        path: `branch.${landed}.remote`,
        value: "origin"
      });
      await git.configSet({
        dir: req.dir,
        path: `branch.${landed}.merge`,
        value: `refs/heads/${landed}`
      });
      return landed;
    });
  }

  async fetch(req: {
    url: string;
    dir: string;
    allowedHosts: string[];
    depth?: number;
  }): Promise<RepoGitResult> {
    return this.#run(req.allowedHosts, async (git, onAuth) => {
      const result = await git.fetch({
        url: req.url,
        dir: req.dir,
        onAuth,
        prune: true,
        tags: false,
        singleBranch: false,
        ...(req.depth ? { depth: req.depth } : {})
      });
      return `fetched ${req.url} (default branch ${result.defaultBranch ?? "unknown"})`;
    });
  }

  async push(req: {
    url: string;
    dir: string;
    branch: string;
    allowedHosts: string[];
  }): Promise<RepoGitResult> {
    return this.#run(req.allowedHosts, async (git, onAuth) => {
      const result = await git.push({
        url: req.url,
        dir: req.dir,
        ref: req.branch,
        remoteRef: req.branch,
        onAuth
        // No `force`, ever, and not a knob: `/repo` refuses anything but a plain
        // branch name precisely so that a push cannot be turned into a force
        // push, and this is the other end of that promise.
      });
      // isomorphic-git reports a rejected push in the *result* rather than by
      // throwing — a non-fast-forward comes back `ok: false` with the reason on
      // the ref. Reading only the absence of an exception would report every
      // rejected push as a success, in the one plugin whose entire theme is that
      // a failed command is not a completed operation.
      if (!result.ok) {
        const perRef = Object.entries(result.refs)
          .filter(([, status]) => !status.ok)
          .map(([ref, status]) => `${ref}: ${status.error ?? "rejected"}`)
          .join("; ");
        throw new Error(
          result.error ?? perRef ?? "the remote rejected the push"
        );
      }
      return `pushed ${req.branch} to ${req.url}`;
    });
  }

  /**
   * The shared body: entry-point bookkeeping, the credential, and the translation
   * back into something that survives RPC.
   *
   * A thrown `GitError` loses its prototype crossing a Durable Object boundary,
   * so `instanceof` on the far side is not available and the caller would be left
   * pattern-matching a string. The `code` is lifted here, while the error is
   * still itself, and travels as data.
   */
  async #run(
    allowedHosts: string[],
    body: (git: GitClient, onAuth: AuthCallback) => Promise<string>
  ): Promise<RepoGitResult> {
    // Bound to the credential rather than checked before the call, which is
    // strictly stronger: this is the moment the token would be handed over, and
    // it sees the URL git actually authenticated against — including one it
    // reached by redirect. A host nobody allowed gets no credential and the
    // request fails unauthenticated, rather than the token being offered to it
    // and *then* the mistake being noticed.
    const onAuth: AuthCallback = (url) => {
      let host: string;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") return {};
        host = parsed.hostname;
      } catch {
        return {};
      }
      if (!allowedHosts.includes(host)) {
        console.warn(`[${this.deps.tag()}] refused to authenticate to a host`, {
          host
        });
        return {};
      }
      return { username: "x-access-token", password: this.deps.token() };
    };

    try {
      return { ok: true, detail: await body(this.deps.git(), onAuth) };
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      return {
        ok: false,
        ...(typeof code === "string" ? { code } : {}),
        message: err instanceof Error ? err.message : String(err)
      };
    }
  }
}

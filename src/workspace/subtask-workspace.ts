import {
  workspaceName,
  type WorkspaceObjectBase
} from "@dynamicagents/plugins/computer";
import type { ActiveCheckout, ActiveRepo } from "./active-repo";
import { SCRATCH_REPO } from "./scratch";
import {
  claim,
  isSubtaskBranch,
  parseWorktreeRepo,
  worktreeRepo,
  type PoolRepo,
  type PoolStore,
  type Worktree
} from "./worktree-pool";

/**
 * Where a writing subtask works, and what becomes of it afterwards.
 *
 * `@dynamicagents/plugins/claude-code` owns *that* a writing subtask needs a
 * workspace no other live session shares, and why. What is here is the half a
 * plugin cannot have: **which Durable Object, how it comes to hold the right
 * checkout on the right branch, and what is kept when the subtask ends.** It
 * reaches the plugin through its `subtaskWorkspace`, `releaseSubtaskWorkspace`
 * and `abortSubtaskWorkspace` seams.
 *
 * The workspace is a worktree from `./worktree-pool.ts`, and it is **kept**: the
 * branch and its commits stay in it for the parent to switch into — see
 * `./worktrees.ts` — and push. Nothing here pushes.
 */

/**
 * Whether the parent's current selection names a repository a worktree can be
 * cloned from — itself, or the pool of a worktree it has switched into.
 *
 * Stated as "not a sentinel" for everything else, so a sentinel added later is
 * refused by default instead of being mistaken for a repository name.
 */
export function selectedRepo(selected: string | undefined): string | undefined {
  if (selected === undefined || selected === SCRATCH_REPO) return undefined;
  const worktree = parseWorktreeRepo(selected);
  if (worktree) return worktree.repo;
  return selected.startsWith("<") ? undefined : selected;
}

/** One submodule a writing subtask's clone carries, as `.gitmodules` declares it. */
export interface Submodule {
  path: string;
  url: string;
  /** Absent when `.gitmodules` names none: the superproject's pinned commit. */
  branch?: string;
}

/** Enough of a shell in one checkout to read what it declares. */
type Run = (
  command: string,
  options: { cwd: string; env?: Record<string, string> }
) => Promise<{ success: boolean; stdout: string; stderr: string }>;

/**
 * Parse `git config --null --get-regexp` over `.gitmodules`.
 *
 * NUL-separated because a value may hold anything but NUL, and the subsection —
 * the submodule's name — may hold dots, which is why the key is matched from its
 * end. An entry without both a path and a url is not one git could check out
 * either, and is dropped.
 */
export function parseGitmodules(out: string): Submodule[] {
  const byName = new Map<string, Partial<Submodule>>();
  for (const entry of out.split("\0")) {
    const newline = entry.indexOf("\n");
    if (newline < 0) continue;
    const match = /^submodule\.(.+)\.(path|url|branch)$/.exec(
      entry.slice(0, newline)
    );
    if (!match) continue;
    const [, name, field] = match as unknown as [
      string,
      string,
      keyof Submodule
    ];
    const sub = byName.get(name) ?? {};
    sub[field] = entry.slice(newline + 1);
    byName.set(name, sub);
  }
  return [...byName.values()].filter((sub): sub is Submodule =>
    Boolean(sub.path && sub.url)
  );
}

/**
 * Refuse a submodule path that could leave the checkout or split a line.
 *
 * `.gitmodules` is repository content, and its paths become clone targets, the
 * cwd of git commands, and rows of the tab- and newline-separated lists the
 * branch script reads. A control character would turn one path into two rows —
 * `safe\n../outside` runs git outside the checkout — so each is refused here,
 * before any of those uses, along with every segment that walks out.
 */
function assertSubmodulePath(path: string): void {
  if (
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(
      `claude-coder: refusing a submodule path that could leave the checkout: ${JSON.stringify(path)}`
    );
  }
}

/**
 * The submodules a checkout declares — one level, never theirs — each with a
 * path that stays inside it.
 *
 * Nested submodules are left alone: each level would be another clone in front
 * of the session, and the ones this workspace has met have none.
 */
export async function readSubmodules(
  run: Run,
  dir: string
): Promise<Submodule[]> {
  const listed = await run(
    "[ ! -f .gitmodules ] || git config -f .gitmodules --null --get-regexp '^submodule\\..*\\.(path|url|branch)$'",
    { cwd: dir }
  );
  // `--get-regexp` exits 1 on no match, which is a file with nothing in it —
  // not a failure. Anything that said why is one.
  if (!listed.success && listed.stderr.trim()) {
    throw new Error(
      `claude-coder: could not read .gitmodules in ${dir}: ${listed.stderr.trim()}`
    );
  }
  const submodules = parseGitmodules(listed.stdout);
  for (const sub of submodules) assertSubmodulePath(sub.path);
  return submodules;
}

/**
 * Where to clone one submodule from, or why not.
 *
 * A relative url is resolved the way git resolves it, against the superproject's
 * own. An absolute one must be https on the host the parent's checkout came from:
 * that host has passed `/repo`'s allowlist, and a `.gitmodules` is repository
 * content — a url in it has passed nothing.
 */
export function submoduleCloneUrl(sub: Submodule, parentUrl: string): string {
  const url =
    sub.url.startsWith("./") || sub.url.startsWith("../")
      ? new URL(sub.url, parentUrl.replace(/\/*$/, "/")).href
      : sub.url;
  const host = new URL(parentUrl).hostname;
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  if (parsed?.protocol !== "https:" || parsed.hostname !== host) {
    throw new Error(
      `claude-coder: the submodule at ${sub.path} is cloned from ${sub.url}, and ` +
        `a writing subtask clones only over https from ${host}, where the ` +
        "parent's checkout came from"
    );
  }
  return url;
}

/**
 * Which submodules a previous attempt already cloned, clearing any it left
 * half-done.
 *
 * Present means a repository of its own with a commit checked out, asked of its
 * own `.git` — `git -C` there would walk up to the superproject and answer for
 * it. A `.git` with no commit behind it is a clone that failed part-way, and is
 * cleared so the next one is not refused as "already exists".
 */
async function populated(
  run: Run,
  dir: string,
  submodules: readonly Submodule[]
): Promise<Set<string>> {
  if (submodules.length === 0) return new Set();
  const found = await run(
    `while IFS= read -r p; do
  [ -n "$p" ] || continue
  if [ -e "$p/.git" ] && git --git-dir="$p/.git" rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
    printf '%s\\n' "$p"
  elif [ -e "$p/.git" ]; then
    rm -rf "$p" || exit 1
  fi
done <<EOF
$SUBMODULE_PATHS
EOF`,
    {
      cwd: dir,
      env: { SUBMODULE_PATHS: submodules.map((sub) => sub.path).join("\n") }
    }
  );
  if (!found.success) {
    throw new Error(
      `claude-coder: could not read which submodules are cloned: ${found.stderr || found.stdout}`
    );
  }
  return new Set(found.stdout.split("\n").filter(Boolean));
}

/**
 * Put each repository listed on the worktree's branch, and say where it started.
 *
 * One line in per repository — path, then the commit to start from — and one
 * out: path, base, start, and what the remote has of the branch. Paths reach the
 * script as values, never as command text.
 *
 * - `new` starts the branch at the base, discarding whatever the worktree held
 *   before: that was pushed, or released, or it would not have been free.
 * - `continue` keeps the branch this worktree already holds, and only a
 *   repository that lacks it — a submodule added since — starts one at its base.
 * - `adopt` takes the branch from the remote where it is there.
 *
 * `-f` and `clean -x` because nothing uncommitted in a worktree is kept, and
 * `-e node_modules` because a dependency tree is a mount point `clean` cannot
 * remove. `@pinned` is the commit the superproject records for a submodule that
 * declares no branch, read after the superproject is on its own.
 */
const PUT_ON_BRANCH = `tab="$(printf '\\t')"
while IFS="$tab" read -r path base; do
  [ -n "$path" ] || continue
  if [ "$base" = "@pinned" ]; then
    base="$(git rev-parse "HEAD:$path")" || { echo "the superproject records no commit for $path" >&2; exit 1; }
  fi
  target="$base"
  case "$WORKTREE_MODE" in
    continue)
      if git -C "$path" rev-parse --verify --quiet "refs/heads/$WORKTREE_BRANCH" >/dev/null; then
        target=""
        git -C "$path" checkout -f -q "$WORKTREE_BRANCH" || exit 1
      fi ;;
    adopt)
      if git -C "$path" rev-parse --verify --quiet "refs/remotes/origin/$WORKTREE_BRANCH" >/dev/null; then
        target="origin/$WORKTREE_BRANCH"
      fi ;;
  esac
  if [ -n "$target" ]; then
    git -C "$path" rev-parse --verify --quiet "$target^{commit}" >/dev/null || { echo "$path has no $target — it is not on the remote" >&2; exit 1; }
    git -C "$path" checkout -f -q -B "$WORKTREE_BRANCH" "$target" || exit 1
  fi
  git -C "$path" clean -ffdxq -e node_modules || exit 1
  if [ -n "$WORKTREE_PREVIOUS" ] && [ "$WORKTREE_PREVIOUS" != "$WORKTREE_BRANCH" ]; then
    git -C "$path" branch -D -q "$WORKTREE_PREVIOUS" >/dev/null 2>&1 || true
  fi
  printf '%s\\t%s\\t%s\\t%s\\n' "$path" "$(git -C "$path" rev-parse "$base^{commit}")" "$(git -C "$path" rev-parse HEAD)" "$(git -C "$path" rev-parse --verify --quiet "refs/remotes/origin/$WORKTREE_BRANCH" || true)"
done <<EOF
$WORKTREE_REPOS
EOF`;

/** Each listed repository's HEAD, or nothing where it cannot be read. */
const READ_TIPS = `while IFS= read -r path; do
  [ -n "$path" ] || continue
  printf '%s\\t%s\\n' "$path" "$(git -C "$path" rev-parse HEAD 2>/dev/null)"
done <<EOF
$WORKTREE_PATHS
EOF`;

/** Put each listed repository back where the subtask started it. */
const RESET_TO_START = `tab="$(printf '\\t')"
while IFS="$tab" read -r path start; do
  [ -n "$path" ] || continue
  git -C "$path" checkout -f -q -B "$WORKTREE_BRANCH" "$start" || exit 1
  git -C "$path" clean -ffdxq -e node_modules || exit 1
done <<EOF
$WORKTREE_REPOS
EOF`;

/** What {@link PUT_ON_BRANCH} reports for one repository. */
interface Placed {
  path: string;
  base: string;
  start: string;
  pushed?: string;
}

function parsePlaced(out: string): Placed[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [path = "", base = "", start = "", pushed = ""] = line.split("\t");
      return { path, base, start, ...(pushed ? { pushed } : {}) };
    });
}

export interface SubtaskWorkspaces {
  /** Claim a worktree, put it on the subtask's branch, and answer its name. */
  resolve(ctx: {
    taskId: string;
    subtaskId: number;
    continue?: string;
  }): Promise<string>;
  /** The subtask is over: record where it left each repository and free it. */
  release(ctx: { taskId: string; subtaskId: number }): Promise<void>;
  /** The subtask was cut short: stop it and discard what it committed. */
  abort(ctx: { taskId: string; subtaskId: number }): Promise<void>;
}

export function subtaskWorkspaces(config: {
  binding: DurableObjectNamespace<WorkspaceObjectBase>;
  /** The verified caller. Resolves on the parent, throws on a facet. */
  callerKey: () => string;
  /**
   * Run a command in a named workspace's container.
   *
   * Takes the name per call rather than closing over one: every other `exec` in
   * this Worker is bound to the workspace its agent is working in, and this one is
   * deliberately not — it addresses whichever worktree is being prepared.
   */
  exec: (
    command: string,
    options: { cwd: string; env?: Record<string, string> },
    workspace: string
  ) => Promise<{ success: boolean; stdout: string; stderr: string }>;
  /** Stop a subtask's session in a workspace, before its commits are discarded. */
  stopSession: (workspace: string, subtaskId: number) => Promise<void>;
  active: ActiveRepo;
  pool: PoolStore;
  label: string;
  now?: () => number;
}): SubtaskWorkspaces {
  const now = config.now ?? Date.now;
  const nameOf = (worktree: Worktree) =>
    workspaceName(
      config.callerKey(),
      worktreeRepo(worktree.repo, worktree.slot)
    );
  const stubFor = (name: string) =>
    config.binding.get(config.binding.idFromName(name));
  /**
   * The row a subtask holds, whichever pool it is in: the parent may have moved to
   * another repository since the subtask was resolved.
   */
  const liveRow = (ctx: { taskId: string; subtaskId: number }) =>
    config.pool
      .every()
      .find(
        (row) =>
          row.live?.taskId === ctx.taskId &&
          row.live.subtaskId === ctx.subtaskId
      );

  /**
   * Put a claimed worktree on its branch, in the superproject and every
   * submodule, and record where each repository started.
   *
   * **Every step runs again on a retry and is idempotent**, because `ready` is
   * only set once the last one finished: a first attempt that cloned and then
   * failed at a submodule is completed, not mistaken for a finished one.
   */
  async function prepare(
    worktree: Worktree,
    checkout: ActiveCheckout,
    name: string
  ): Promise<Worktree> {
    const stub = stubFor(name);
    const run = (
      command: string,
      options: { cwd: string; env?: Record<string, string> }
    ) => config.exec(command, options, name);
    const host = new URL(checkout.url).hostname;
    const recorded = new Map(worktree.repos.map((repo) => [repo.path, repo]));
    let mode = worktree.mode ?? "new";

    if (!(await stub.checkoutDir())) {
      /**
       * A clone that failed part-way leaves a repository nobody recorded — the
       * clone initialises before it fetches — and a second clone into it is
       * refused with "git repository already exists", on every retry. Nothing
       * is worth keeping in a worktree with no recorded checkout, so what is
       * there is cleared first.
       */
      if (!/^\/[^/]+\/./.test(checkout.dir)) {
        throw new Error(
          `claude-coder: refusing to clear a checkout path that is not under a workspace directory: ${checkout.dir}`
        );
      }
      const cleared = await run('rm -rf "$CHECKOUT_DIR"', {
        cwd: "/",
        env: { CHECKOUT_DIR: checkout.dir }
      });
      if (!cleared.success) {
        throw new Error(
          `claude-coder: could not clear an unfinished clone in a worktree: ${cleared.stderr || cleared.stdout}`
        );
      }
      const cloned = await stub.gitClone({
        url: checkout.url,
        dir: checkout.dir,
        branch: checkout.branch,
        // The host this checkout already came from, rather than the plugin's
        // whole allowlist: it passed that allowlist once, and narrowing to the
        // one host cannot refuse anything the parent was allowed.
        allowedHosts: [host]
      });
      if (!cloned.ok) {
        // The branch is named because the likeliest cause is one that exists
        // only in the parent's checkout — a worktree clones from the remote.
        throw new Error(
          `claude-coder: could not clone ${checkout.url} at ${checkout.branch} into a worktree: ${cloned.message}`
        );
      }
      // A worktree whose storage went — reclaimed after a week untouched — no
      // longer holds the branch it is recorded with. What the remote has of it
      // is all that is left.
      if (mode === "continue") mode = "adopt";
    }
    // Straight after the clone, so a retry that fails later finds a recorded
    // checkout and does not clone over it — and before the install, for the
    // reason `noteCheckout` gives in `@dynamicagents/plugins/computer`.
    await stub.noteCheckout({
      dir: checkout.dir,
      kind: "repo",
      repo: worktree.repo
    });

    const fetch = async (url: string, dir: string, what: string) => {
      const fetched = await stub.gitFetch({ url, dir, allowedHosts: [host] });
      if (!fetched.ok) {
        throw new Error(
          `claude-coder: could not fetch ${what} in a worktree: ${fetched.message}`
        );
      }
    };
    const place = async (
      rows: { path: string; base: string }[]
    ): Promise<Placed[]> => {
      if (rows.length === 0) return [];
      const placed = await run(PUT_ON_BRANCH, {
        cwd: checkout.dir,
        env: {
          WORKTREE_BRANCH: worktree.branch as string,
          WORKTREE_MODE: mode,
          WORKTREE_PREVIOUS: worktree.previous ?? "",
          WORKTREE_REPOS: rows
            .map((row) => `${row.path}\t${row.base}`)
            .join("\n")
        }
      });
      if (!placed.success) {
        throw new Error(
          `claude-coder: could not put a worktree on ${worktree.branch}: ${placed.stderr || placed.stdout}`
        );
      }
      return parsePlaced(placed.stdout);
    };
    /**
     * Where a repository's branch starts from. A branch being continued keeps
     * the base it was first given — the remote's branch has moved on since, and
     * measuring against where it is now would count other people's commits as
     * this branch's work.
     */
    const startFrom = (path: string, ref: string) =>
      mode === "continue" ? (recorded.get(path)?.base ?? ref) : ref;

    // The superproject first: which submodules there are, and which commit each
    // is pinned to, is what the branch it is now on says.
    await fetch(checkout.url, checkout.dir, "the superproject");
    const rootRef = `origin/${checkout.branch}`;
    const [root] = await place([{ path: ".", base: startFrom(".", rootRef) }]);

    /**
     * Every submodule, each cloned into this worktree with objects of its own.
     *
     * The superproject's clone leaves an empty directory at each gitlink —
     * isomorphic-git clones no submodules — so a session asked to change one
     * would find nothing there. Each is cloned on its declared branch, which is
     * what the superproject's own sync would check out, and fetched in full so
     * the pinned commit of one that declares none is there too.
     */
    const submodules = await readSubmodules(run, checkout.dir);
    const present = await populated(run, checkout.dir, submodules);
    const refs = new Map<string, string>();
    for (const sub of submodules) {
      const url = submoduleCloneUrl(sub, checkout.url);
      const dir = `${checkout.dir}/${sub.path}`;
      // `.` means "the superproject's branch", in git's own reading of it.
      const branch = sub.branch === "." ? checkout.branch : sub.branch;
      refs.set(sub.path, branch ? `origin/${branch}` : "@pinned");
      if (!present.has(sub.path)) {
        const cloned = await stub.gitClone({
          url,
          dir,
          allowedHosts: [host],
          ...(branch ? { branch } : {})
        });
        if (!cloned.ok) {
          throw new Error(
            `claude-coder: could not clone the submodule at ${sub.path}${branch ? ` on ${branch}` : ""}: ${cloned.message}`
          );
        }
      }
      await fetch(url, dir, `the submodule at ${sub.path}`);
    }
    const placedSubs = await place(
      submodules.map((sub) => ({
        path: sub.path,
        base: startFrom(sub.path, refs.get(sub.path) as string)
      }))
    );

    /**
     * An adopted branch has to be on the remote somewhere. A repository without
     * it starts from its base, which is right for one the branch never
     * changed — but a branch on the remote nowhere was never pushed, and
     * starting it from the base would report the earlier work as there when it
     * went with the worktree that held it.
     */
    if (
      mode === "adopt" &&
      ![root, ...placedSubs].some((placed) => placed?.pushed)
    ) {
      throw new Error(
        `claude-coder: no worktree holds ${worktree.branch}, and it is on the remote ` +
          "in no repository — it was never pushed, and the worktree that held it " +
          "was released or deleted. Its commits are gone; delegate without " +
          "`continue` to do the work again."
      );
    }

    // Returns as soon as the command is spawned. Awaiting a dependency install
    // here would put minutes in front of the session waiting for it.
    await stub.startInstall({ dir: checkout.dir, repo: worktree.repo });

    const urls = new Map<string, string>([[".", checkout.url]]);
    for (const sub of submodules)
      urls.set(sub.path, submoduleCloneUrl(sub, checkout.url));
    const repos: PoolRepo[] = [root, ...placedSubs]
      .filter((placed): placed is Placed => Boolean(placed))
      .map((placed) => {
        const ref = placed.path === "." ? rootRef : refs.get(placed.path);
        const kept =
          mode === "continue" ? recorded.get(placed.path) : undefined;
        return {
          path: placed.path,
          url: urls.get(placed.path) as string,
          // A pinned submodule's base is a commit, and a reviewer passes it as one.
          baseRef:
            kept?.baseRef ??
            (ref === "@pinned" || ref === undefined ? placed.base : ref),
          base: placed.base,
          start: placed.start,
          tip: placed.start,
          ...(placed.pushed ? { pushed: placed.pushed } : {})
        };
      });

    const { previous: _previous, ...rest } = worktree;
    const ready: Worktree = {
      ...rest,
      mode,
      dir: checkout.dir,
      repos,
      ready: true
    };
    config.pool.put(ready);
    return ready;
  }

  return {
    async resolve(ctx): Promise<string> {
      /**
       * A scratchpad is the parent's, and shared.
       *
       * There is nothing to clone — a scratchpad has no remote — so the isolation
       * this whole module provides has no mechanism here, and the honest answer is
       * the workspace the parent already opened. The consequence is a real limit:
       * writing subtasks in a scratchpad share one tree, so fan-out there is the
       * model's judgement rather than the platform's guarantee.
       */
      const selected = config.active.get();
      const repo = selectedRepo(selected);
      if (repo === undefined) {
        return workspaceName(config.callerKey(), selected);
      }

      // What the parent cloned, which is the only honest thing to clone: the url
      // has already been through `/repo`'s host allowlist. The sentence names the
      // refusal that leaves a checkout on disk unrecorded, because "nothing was
      // cloned" is what an agent looking at that checkout will not believe.
      const checkout = config.active.checkout();
      if (!checkout) {
        throw new Error(
          "claude-coder: there is no recorded checkout for a writing subtask to " +
            "clone. `repo_clone` records one only when it leaves a clean tree on " +
            "a named branch — if its last answer was a refusal (uncommitted " +
            "changes, another repository at that path), deal with that and run " +
            "`repo_clone` again before delegating"
        );
      }
      if (ctx.continue !== undefined && !isSubtaskBranch(ctx.continue)) {
        throw new Error(
          `claude-coder: \`continue\` names ${JSON.stringify(ctx.continue)}, which is ` +
            "not a branch a writing subtask made. Pass the branch an earlier " +
            "subtask's report named — `claude-coder/<task>/<n>` — or leave it out " +
            "to start a new one."
        );
      }

      const claimed = claim(config.pool, repo, ctx, now());
      const name = nameOf(claimed);
      if (!claimed.ready) await prepare(claimed, checkout, name);
      // `note`, not `set`: this enrols the worktree in the sweep's candidate list
      // without routing the parent's own tools to it. A workspace the sweep cannot
      // see falls back to its own seven-day alarm with no backstop.
      config.active.note(worktreeRepo(claimed.repo, claimed.slot));
      return name;
    },

    async release(ctx): Promise<void> {
      const row = liveRow(ctx);
      if (!row) return;
      let repos = row.repos;
      if (row.ready && row.dir) {
        try {
          const read = await config.exec(
            READ_TIPS,
            {
              cwd: row.dir,
              env: { WORKTREE_PATHS: repos.map((repo) => repo.path).join("\n") }
            },
            nameOf(row)
          );
          const tips = new Map(
            read.stdout
              .split("\n")
              .filter(Boolean)
              .map((line) => line.split("\t") as [string, string])
          );
          repos = repos.map((repo) => ({
            ...repo,
            tip: tips.get(repo.path) ?? ""
          }));
        } catch (err) {
          // Unknown tips keep the worktree held, which is the side to err on.
          console.warn(
            `[${config.label}] could not read a worktree's commits`,
            {
              slot: row.slot,
              err: String(err)
            }
          );
          repos = repos.map((repo) => ({ ...repo, tip: "" }));
        }
      }
      // A worktree that never got onto its new branch holds nothing of it; one
      // being continued still holds the branch it had.
      const keeps = row.ready || row.mode === "continue";
      const { live: _live, mode: _mode, ready: _ready, ...rest } = row;
      config.pool.put({
        ...rest,
        repos,
        usedAt: now(),
        ...(keeps
          ? {}
          : { branch: undefined, previous: row.branch ?? row.previous })
      });
    },

    async abort(ctx): Promise<void> {
      const row = liveRow(ctx);
      if (!row) return;
      const name = nameOf(row);
      // Stopped first: core runs this before it tears the facet down, and a
      // session still running would commit on top of the reset.
      try {
        await config.stopSession(name, ctx.subtaskId);
      } catch (err) {
        console.warn(`[${config.label}] could not stop a session to abort it`, {
          slot: row.slot,
          err: String(err)
        });
      }
      if (!row.ready || !row.dir || !row.branch) return;
      const reset = await config.exec(
        RESET_TO_START,
        {
          cwd: row.dir,
          env: {
            WORKTREE_BRANCH: row.branch,
            WORKTREE_REPOS: row.repos
              .map((repo) => `${repo.path}\t${repo.start}`)
              .join("\n")
          }
        },
        name
      );
      if (!reset.success) {
        // Left live and left as it is: `release` runs next, reads the tips and
        // holds the worktree on them, which is the right side to err on for a
        // worktree that may still carry the commits this meant to discard.
        console.warn(
          `[${config.label}] could not discard an aborted subtask's commits`,
          {
            slot: row.slot,
            stderr: reset.stderr.trim().slice(0, 500)
          }
        );
        return;
      }
      /**
       * Record where the reset put it, and free it here rather than leaving that
       * to `release`.
       *
       * `stopSession` above delivers `SIGTERM` and returns; Claude Code then
       * aborts its turn, kills its process tree and runs its `SessionEnd` hooks,
       * so a session can still commit for a moment after the reset ran. The
       * facet's own cancellation waits that out — `ClaudeCoderSubagent.abortRun`
       * awaits the drain before resetting — but this path runs in the parent, a
       * Durable Object away from the promise that would say when the drain
       * unwound, and it is reached precisely when there is no drain left to
       * await: a chunk whose isolate was evicted or whose branch failed.
       *
       * So the reset is not ordered against the session, and what that would
       * cost is `release` reading a tip a moment later and recording a commit
       * this exists to discard — which `isFree` then reads as work worth
       * keeping, holding the slot on a branch nobody asked for. Writing `start`
       * here says what the reset did, and dropping `live` means `release` finds
       * no row and records nothing.
       *
       * Files written after the reset are a smaller matter and are left: the
       * next subtask to claim this slot is prepared with `checkout -f` and
       * `clean -ffdx` before it runs, which is where an unordered write ends.
       */
      const { live: _live, mode: _mode, ready: _ready, ...rest } = row;
      config.pool.put({
        ...rest,
        repos: row.repos.map((repo) => ({ ...repo, tip: repo.start })),
        usedAt: now()
      });
    }
  };
}

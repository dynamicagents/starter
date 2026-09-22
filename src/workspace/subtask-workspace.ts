import {
  workspaceName,
  type WorkspaceObjectBase
} from "@dynamicagents/plugins/computer";
import type { ActiveRepo } from "./active-repo";
import { SCRATCH_REPO } from "./scratch";

/**
 * Where a writing subtask works, and what becomes of it afterwards.
 *
 * `@dynamicagents/plugins/claude-code` owns *that* a writing subtask needs a
 * workspace of its own and why — two autonomous sessions in one container edit one
 * working tree. What is here is the half a plugin cannot have: **which Durable
 * Object, how an empty one acquires a checkout, and who retires it.** Both reach
 * the plugin through its `subtaskWorkspace` and `reclaimSubtaskWorkspace` seams,
 * the same arrangement `./scratch.ts` uses for a scratchpad.
 */

/**
 * The repository sentinel one subtask's workspace is keyed on.
 *
 * Routed as a repository, exactly as a scratchpad is — `workspaceName` documents
 * that slot as taking a sentinel, and `computer` pairs one Durable Object with one
 * container, so a name nobody else uses is a filesystem nobody else has.
 *
 * Angle brackets because no forge name can contain them, so this cannot collide
 * with a repository a caller could clone. No `|`, because that is the separator
 * `workspaceName` joins on and a sentinel carrying one could forge a caller
 * boundary. See `SCRATCH_REPO` in `./scratch.ts`, which is the same argument.
 *
 * **A pure function of the two ids, and that is load-bearing.** Core resolves an
 * execution's runtime once per *chunk*, not once per run, so a name that varied
 * would hand chunk two a different container than chunk one and abandon the work
 * in the first.
 */
export function subtaskRepo(ctx: {
  taskId: string;
  subtaskId: number;
}): string {
  return `<subtask:${ctx.taskId}:${ctx.subtaskId}>`;
}

/** Whether a repository slot is one of {@link subtaskRepo}'s. */
export function isSubtaskRepo(repo: string): boolean {
  return repo.startsWith("<subtask:");
}

/**
 * The branch one writing subtask's work arrives on.
 *
 * **Derived, never chosen by a model or reported back by one.** The parent has to
 * name this branch to fetch and review it, and the subtask has to be pushed to it,
 * and the two never speak — so the one thing that must not happen is the name
 * being agreed. It is a function of the same two ids the workspace is.
 *
 * `git push` sends a local ref to a remote ref of the same name here — see
 * `WorkspaceGitHost.push` in `@dynamicagents/plugins/computer` — so this is also
 * what the checkout's local branch is called. Slashes are ordinary in a branch
 * name; what `/repo`'s `UNSAFE_BRANCH` refuses is a leading dash, a colon, a
 * trailing slash and the traversal spellings, none of which a task id contains.
 */
export function subtaskBranch(ctx: {
  taskId: string;
  subtaskId: number;
}): string {
  return `claude-coder/${ctx.taskId}/${ctx.subtaskId}`;
}

/**
 * Whether the parent's current selection is a repository, as against a sentinel.
 *
 * Only a repository can be cloned into a workspace of its own, so this is what
 * decides whether a writing subtask is isolated at all. Stated as "not a sentinel"
 * rather than as a pattern for `owner/repo`, so a sentinel added later is refused
 * here by default instead of being mistaken for a repository name.
 */
function isRepoSelection(selected: string): boolean {
  return selected !== SCRATCH_REPO && !isSubtaskRepo(selected);
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
 * Put the superproject and each submodule on the subtask's branch.
 *
 * Switch to it if a previous attempt got this far, create it otherwise.
 * `checkout -B` would do both in one word and is wrong: it resets the branch to
 * HEAD, discarding commits a retried attempt had already made. A submodule with no
 * declared branch is first put on the commit the superproject pins, which is only
 * reached when the branch does not exist yet — so a retry never moves it.
 *
 * Paths reach the script as one value per line, never as command text.
 */
const START_BRANCH = `while IFS="$(printf '\\t')" read -r path pinned; do
  [ -n "$path" ] || continue
  if ! git -C "$path" checkout --quiet "$SUBTASK_BRANCH" 2>/dev/null; then
    if [ -n "$pinned" ]; then
      git -C "$path" checkout --quiet --detach "$(git rev-parse "HEAD:$path")" || exit 1
    fi
    git -C "$path" checkout --quiet -b "$SUBTASK_BRANCH" || exit 1
  fi
done <<EOF
$SUBTASK_REPOS
EOF`;

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

export interface SubtaskWorkspaces {
  /** Route and prepare, answering the workspace name. */
  resolve(ctx: { taskId: string; subtaskId: number }): Promise<string>;
  /** Retire it, whatever the execution's outcome was. */
  reclaim(ctx: { taskId: string; subtaskId: number }): Promise<void>;
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
   * deliberately not — it addresses whichever subtask workspace is being prepared.
   */
  exec: (
    command: string,
    options: { cwd: string; env?: Record<string, string> },
    workspace: string
  ) => Promise<{ success: boolean; stdout: string; stderr: string }>;
  active: ActiveRepo;
  label: string;
}): SubtaskWorkspaces {
  const stubFor = (repo: string) =>
    config.binding.get(
      config.binding.idFromName(workspaceName(config.callerKey(), repo))
    );

  return {
    async resolve(ctx): Promise<string> {
      const repo = subtaskRepo(ctx);
      const name = workspaceName(config.callerKey(), repo);
      const stub = stubFor(repo);

      /**
       * A scratchpad is the parent's, and shared.
       *
       * There is nothing to clone — a scratchpad has no remote — so the isolation
       * this whole module provides has no mechanism here, and the honest answer is
       * the workspace the parent already opened. Checked against the *selection*
       * rather than against {@link ActiveRepo.checkout}, which still holds
       * whatever repository was cloned before `scratch_open` ran and would
       * otherwise clone a stale one into a container of its own.
       *
       * The consequence is stated because it is a real limit: writing subtasks in
       * a scratchpad share one tree, exactly as they did before any of this, so
       * fan-out there is the model's judgement rather than the platform's
       * guarantee.
       */
      const selected = config.active.get();
      if (selected === undefined || !isRepoSelection(selected)) {
        return workspaceName(config.callerKey(), selected);
      }

      /**
       * **Every step below runs on every chunk**, and each is idempotent.
       *
       * The tempting shape is to return early once the tree is there. It is
       * wrong: if a first attempt clones and then fails at the install or the
       * branch, the retry sees a checkout, skips the rest, and runs the session
       * on the source branch — so the branch the parent fetches never exists and
       * the work cannot be published. A partial setup has to be completable, not
       * mistaken for a finished one.
       */
      const already = await stub.checkoutDir();

      // What the parent cloned, which is the only honest thing to clone: the url
      // has already been through `/repo`'s host allowlist. Saying there is none
      // beats cloning a guess — and the sentence names the refusal that leaves a
      // checkout on disk unrecorded, because "nothing was cloned" is what an
      // agent looking at that checkout will not believe.
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

      if (!already) {
        /**
         * A clone that failed part-way leaves a repository nobody recorded — the
         * clone initialises before it fetches — and a second clone into it is
         * refused with "git repository already exists", on every retry. This
         * workspace is this subtask's alone and holds nothing worth keeping
         * until a checkout is recorded, so what is there is cleared first.
         */
        if (!/^\/[^/]+\/./.test(checkout.dir)) {
          throw new Error(
            `claude-coder: refusing to clear a checkout path that is not under a workspace directory: ${checkout.dir}`
          );
        }
        const cleared = await config.exec(
          'rm -rf "$CHECKOUT_DIR"',
          { cwd: "/", env: { CHECKOUT_DIR: checkout.dir } },
          name
        );
        if (!cleared.success) {
          throw new Error(
            `claude-coder: could not clear an unfinished clone in a subtask workspace: ${cleared.stderr || cleared.stdout}`
          );
        }
        const cloned = await stub.gitClone({
          url: checkout.url,
          dir: checkout.dir,
          branch: checkout.branch,
          // The host this checkout already came from, rather than the plugin's
          // whole allowlist: it passed that allowlist once, and narrowing to the
          // one host cannot refuse anything the parent was allowed.
          allowedHosts: [new URL(checkout.url).hostname]
        });
        if (!cloned.ok) {
          // Thrown rather than returned: `resolveRuntime` answering a name for a
          // workspace with no tree would send the session to a directory that is
          // not there, and it would report that as the task's answer. The branch
          // is named because the likeliest cause is one that exists only in the
          // parent's checkout — a subtask clones from the remote.
          throw new Error(
            `claude-coder: could not clone ${checkout.url} at ${checkout.branch} into a subtask workspace: ${cloned.message}`
          );
        }
      }

      const parentRepo = config.active.get();
      // Straight after the clone, so a retry that fails later — at a submodule,
      // the install or the branch — finds a recorded checkout and does not clone
      // over it. Before the install and never inside it, for the reason
      // `noteCheckout` gives: an install is conditional where a checkout is not,
      // so no install outcome may decide whether the path was recorded.
      await stub.noteCheckout({
        dir: checkout.dir,
        kind: "repo",
        ...(parentRepo ? { repo: parentRepo } : {})
      });

      /**
       * Every submodule, cloned the same way and from the same host.
       *
       * The clone above is the superproject alone — isomorphic-git leaves an empty
       * directory at each gitlink — so a session asked to change a submodule would
       * find nothing there. Each is cloned on its declared branch, which is what
       * the superproject's own sync would check out; one that declares none is
       * put on the commit the superproject pins, below.
       */
      const submodules = await readSubmodules(
        (command, options) => config.exec(command, options, name),
        checkout.dir
      );
      const host = new URL(checkout.url).hostname;
      const present = await populated(
        (command, options) => config.exec(command, options, name),
        checkout.dir,
        submodules
      );
      for (const sub of submodules) {
        const url = submoduleCloneUrl(sub, checkout.url);
        if (present.has(sub.path)) continue;
        // `.` means "the superproject's branch", in git's own reading of it.
        const branch = sub.branch === "." ? checkout.branch : sub.branch;
        const cloned = await stub.gitClone({
          url,
          dir: `${checkout.dir}/${sub.path}`,
          allowedHosts: [host],
          ...(branch ? { branch } : {})
        });
        if (!cloned.ok) {
          throw new Error(
            `claude-coder: could not clone the submodule at ${sub.path}${branch ? ` on ${branch}` : ""}: ${cloned.message}`
          );
        }
      }
      // Returns as soon as the command is spawned. Awaiting a dependency install
      // here would put minutes in front of the session waiting for it.
      await stub.startInstall({
        dir: checkout.dir,
        ...(parentRepo ? { repo: parentRepo } : {})
      });

      /**
       * The branch the work will be pushed on, created **here** rather than asked
       * of the session — in the superproject and in every submodule, since a
       * commit lands in whichever repository the session changed.
       *
       * The parent fetches this name to review it and never learns one from the
       * subtask's report, so a session that named its own branch — or forgot to —
       * would produce work nobody comes to look at. Checked out before the session
       * starts, so every commit it makes lands on it without being told to.
       */
      const branch = subtaskBranch(ctx);
      const checkedOut = await config.exec(
        START_BRANCH,
        {
          cwd: checkout.dir,
          env: {
            SUBTASK_BRANCH: branch,
            SUBTASK_REPOS: [
              ".\t",
              ...submodules.map(
                (sub) => `${sub.path}\t${sub.branch ? "" : "pinned"}`
              )
            ].join("\n")
          }
        },
        name
      );
      if (!checkedOut.success) {
        throw new Error(
          `claude-coder: could not start branch ${branch} in a subtask workspace: ${checkedOut.stderr || checkedOut.stdout}`
        );
      }

      // `note`, not `set`: this enrols the sentinel in the sweep's candidate list
      // without routing the parent's own tools to it. A workspace the sweep cannot
      // see falls back to its own seven-day alarm with no backstop.
      config.active.note(repo);
      return name;
    },

    async reclaim(ctx): Promise<void> {
      const repo = subtaskRepo(ctx);
      try {
        // Zero, so it reclaims on the spot rather than asking whether it is idle:
        // the execution is over, and nothing will use this workspace again. A
        // reclaim rather than a container release, because unlike the parent's
        // there is nothing in it worth keeping — that distinction is on
        // `releaseContainer` in `@dynamicagents/plugins/computer`.
        //
        // Safe on a workspace that was never created: `reclaimIfIdle` answers
        // nothing-to-do when there is nothing there, which is the ordinary case
        // for a subtask that failed before it ever resolved one.
        const result = await stubFor(repo).reclaimIfIdle(0);
        // Only what this call actually retired, which is the same rule the weekly
        // sweep follows: a candidate dropped for a reclaim that did not happen
        // would leave a workspace with no backstop but its own alarm.
        if (result.reclaimed) config.active.forget(repo);
      } catch (err) {
        /**
         * "workspace reclaimed" is the workspace saying it has been — its reset
         * runs from an alarm that can land before this call's answer does, and
         * the answer is then lost with the instance. In production every
         * reclaim ended this way, so it is read as the success it reports.
         */
        if (String(err).includes("workspace reclaimed")) {
          config.active.forget(repo);
          return;
        }
        // Best-effort, like every other teardown on this path. The execution is
        // already terminal, and a container that cannot be stopped must not be
        // reported as a subtask that failed — the idle deadline is the backstop.
        console.warn(
          `[${config.label}] could not reclaim a subtask workspace`,
          {
            repo,
            err: String(err)
          }
        );
      }
    }
  };
}

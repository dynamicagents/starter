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
      // has already been through `/repo`'s host allowlist. A subtask delegated
      // before the parent cloned anything has nothing to work in, and saying so
      // beats cloning a guess.
      const checkout = config.active.checkout();
      if (!checkout) {
        throw new Error(
          "claude-coder: a writing subtask was delegated before any repository " +
            "was cloned, so there is nothing for it to work in"
        );
      }

      if (!already) {
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
          // not there, and it would report that as the task's answer.
          throw new Error(
            `claude-coder: could not clone into a subtask workspace: ${cloned.message}`
          );
        }
      }

      const parentRepo = config.active.get();
      // Before the install and never inside it, for the reason `noteCheckout`
      // gives: an install is conditional where a checkout is not, so no install
      // outcome may decide whether the path was recorded.
      await stub.noteCheckout({
        dir: checkout.dir,
        kind: "repo",
        ...(parentRepo ? { repo: parentRepo } : {})
      });
      // Returns as soon as the command is spawned. Awaiting a dependency install
      // here would put minutes in front of the session waiting for it.
      await stub.startInstall({
        dir: checkout.dir,
        ...(parentRepo ? { repo: parentRepo } : {})
      });

      /**
       * The branch the work will be pushed on, created **here** rather than asked
       * of the session.
       *
       * The parent fetches this name to review it and never learns one from the
       * subtask's report, so a session that named its own branch — or forgot to —
       * would produce work nobody comes to look at. Checked out before the session
       * starts, so every commit it makes lands on it without being told to.
       */
      const branch = subtaskBranch(ctx);
      // Switch to it if a previous attempt got this far, create it otherwise.
      // `checkout -B` would do both in one word and is wrong: it resets the
      // branch to HEAD, discarding commits a retried attempt had already made.
      const checkedOut = await config.exec(
        'git checkout "$SUBTASK_BRANCH" 2>/dev/null || git checkout -b "$SUBTASK_BRANCH"',
        { cwd: checkout.dir, env: { SUBTASK_BRANCH: branch } },
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

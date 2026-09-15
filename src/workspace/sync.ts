import type { Workspace } from "@cloudflare/computer";
import type { Deadline } from "@dynamicagents/core/alarm";

/**
 * The host's half of syncing: moving what the container wrote into the object.
 *
 * ## Why the host has a half at all
 *
 * Every command is bracketed by a sync — a push before it runs, a pull after it
 * exits — and the pull is what carries its writes back into this object's
 * SQLite. That pull can fail while the command itself succeeds: a transport that
 * dropped, a container replaced underneath it. The library reports that on the
 * command's result and schedules nothing of its own afterwards. What it does
 * keep is the cursor, so a later `pull()` resumes the same operation rather than
 * starting one.
 *
 * That later `pull()` is this. Without it the workspace silently lags the
 * container: the file tools read a tree missing the last command's work, and git
 * — which runs on this side — would commit and push it that way.
 */

/**
 * How long one drain spends moving blocks before it comes back.
 *
 * The alarm is shared. Every other reason a workspace wakes is queued behind
 * whatever the alarm is doing, so a drain that ran to completion in one
 * invocation would hold the object for as long as the pull takes. A minute
 * finishes an ordinary pull outright and keeps a large one from starving the
 * install watchdog.
 */
export const SYNC_DRAIN_BUDGET_MS = 60_000;

/** How soon an unfinished drain comes back for the next block. */
export const SYNC_DRAIN_RESUME_MS = 1_000;

/**
 * What one drain achieved.
 *
 * `unavailable` is not a failure: it is the answer when there is no container to
 * pull from, which also means there is nothing outstanding that could still be
 * recovered. Kept distinct from `complete` so a caller deciding whether to act
 * on the workspace — a git push, say — can tell "nothing to move" from "nothing
 * reachable".
 */
export type DrainOutcome = "complete" | "incomplete" | "unavailable";

export interface WorkspaceSyncDeps {
  workspace: () => Workspace;
  /** Whether a container is up. A drain must never start one — see {@link drain}. */
  containerRunning: () => boolean;
  /** Where the next block is scheduled. */
  deadline: () => Deadline;
  tag: () => string;
  id: () => string;
}

export class WorkspaceSync {
  constructor(private readonly deps: WorkspaceSyncDeps) {}

  /**
   * Come back shortly and move what is still outstanding.
   *
   * A deadline rather than an immediate drain, because the caller is usually
   * holding something that should not wait on a pull — an install's drain, or a
   * request. `set` replaces whatever stood before, so arming twice is one
   * schedule rather than two.
   */
  async arm(): Promise<void> {
    await this.deps.deadline().set(new Date(Date.now() + SYNC_DRAIN_RESUME_MS));
  }

  /**
   * Move what the container has written into this object's storage.
   *
   * One block per `next()`, under a budget rather than to completion, because
   * the iterator is disposable by design: the durable state is the cursor the
   * block just committed, so stopping is a normal thing to do and a recreated
   * iterable picks up where this one stopped.
   *
   * **Never starts a container.** Opening a backend handle would launch one, and
   * a pull against a replacement finds an empty filesystem rather than the
   * writes it was after — the library fences that to the runtime that ran the
   * command, but launching a container to discover so is pure cost. A stopped
   * container also means there is nothing left to pull: whatever it held that
   * never arrived is gone, which is why a drain runs *before* an idle deadline
   * stops one.
   */
  async drain(budgetMs: number): Promise<DrainOutcome> {
    if (!this.deps.containerRunning()) return "unavailable";

    const stopAt = Date.now() + budgetMs;
    let blocks = 0;
    let entries = 0;
    try {
      for await (const progress of this.deps.workspace().pull()) {
        blocks += 1;
        entries += progress.entries;
        if (progress.complete) {
          // Silent for the ordinary case — one empty block, which is what a
          // workspace with nothing outstanding returns on every check.
          if (blocks > 1 || entries > 0) {
            console.info(`[${this.deps.tag()}] pull drained`, {
              id: this.deps.id(),
              blocks,
              entries
            });
          }
          return "complete";
        }
        if (Date.now() >= stopAt) return "incomplete";
      }
      // The iterable ended without a block claiming completion, which is what a
      // backend with nothing to sync returns. Nothing is outstanding either way.
      return "complete";
    } catch (err) {
      // Left outstanding rather than retried here: the cursor is durable, so the
      // next drain resumes it, and a failing pull that this loop re-entered
      // immediately would spin against whatever is broken.
      console.error(`[${this.deps.tag()}] a pull could not be drained`, {
        id: this.deps.id(),
        blocks,
        entries,
        err: String(err)
      });
      return "incomplete";
    }
  }
}

import type { PluginHost } from "@dynamicagents/core/host";
import { computerExec } from "@dynamicagents/plugins/computer";
import { activeRepo } from "./active-repo";
import { workspaceContainer } from "./container";
import {
  workspaceName,
  WORKSPACE_DIR,
  type WorkspaceObjectBase
} from "@dynamicagents/plugins/computer-host";
import { SCRATCH_DIR, SCRATCH_REPO } from "./scratch";

/**
 * The two things an agent with a workspace owes it, beyond the object itself.
 *
 * Both were written once in `coder/agent.ts` and would otherwise be copied into
 * every sibling — and both are the kind of code that is subtly wrong in a copy:
 * one is a cleanup that must not throw away the expensive thing, the other is a
 * sweep whose whole job is to decide nothing.
 */

/** A workspace namespace, as either agent's `Env` spells it. */
export type WorkspaceNamespace = DurableObjectNamespace<WorkspaceObjectBase>;

/**
 * Discard a cancelled task's half-finished edits — without discarding the
 * workspace.
 *
 * The guarantee: the checkout outlives the task, so edits nobody asked for would
 * otherwise be handed to the *next* task as its starting point.
 *
 * **Not by throwing the container away.** The checkout lives in a Durable Object
 * and survives the container, and so do its dependencies — so `destroy()` would
 * cost a container start and leave the abandoned edits exactly where they were.
 * Exactly backwards. The reset happens in the checkout instead.
 *
 * **`-x` is the load-bearing flag, and `-e node_modules` is what makes it safe.**
 * Without `-x`, `git clean -fd` leaves ignored files in place: a half-built
 * `dist/`, a generated client, a scratch config written by the abandoned run all
 * survive into the next task while `git status` reports the tree as clean. That
 * is the very case this exists to prevent, arriving through the one door
 * `git status` does not show. `-x` closes it, and naming `node_modules` keeps
 * the single artefact that is expensive rather than merely regenerable.
 *
 * That trade only works because the workspace is a JavaScript one by
 * construction — `INSTALL_PLAN` resolves npm, pnpm or yarn and nothing else. An
 * install plan that grows another ecosystem must add its directory here in the
 * same change, or a cancellation starts deleting a `.venv` or a Rust `target/`.
 *
 * Best-effort and deliberately not fatal: `git clean` on a checkout that does
 * not exist yet is a no-op, and a cancellation must complete either way.
 */
export async function discardWorkingTree(config: {
  binding: WorkspaceNamespace;
  name: string;
  /** `owner/repo`, for the fallback path only. */
  repo: string | undefined;
  label: string;
}): Promise<void> {
  try {
    // The same settings the tools run under — `shell: "bash"` above all, which
    // a partial copy of this config used to drop.
    const exec = computerExec(
      workspaceContainer(config.binding, () => config.name)
    );
    // The path the checkout is actually at, as the workspace recorded it and
    // then probed for. Falling back to the conventional layout only for a
    // workspace that predates that record, in which case the convention is what
    // it was built on anyway.
    //
    // The scratchpad arm is not decoration. Its `repo` is a sentinel rather than
    // an `owner/repo`, so the split below yields `/workspace/repo` — a directory
    // that does not exist, in which `git clean` succeeds having cleaned nothing
    // and the cancelled session's files survive into the next task. A fallback
    // that is wrong only when it is unused is a trap, so it is stated.
    const dir =
      (await config.binding
        .get(config.binding.idFromName(config.name))
        .checkoutDir()) ??
      (config.repo === SCRATCH_REPO
        ? SCRATCH_DIR
        : `${WORKSPACE_DIR}/${config.repo?.split("/")[1] ?? "repo"}`);
    /**
     * Sequenced, not chained — `;` rather than `&&`, and that is the whole
     * comment.
     *
     * The two halves discard different things and neither depends on the other
     * succeeding. `reset` fails outright on a repository with no resolvable
     * `HEAD`, and chaining makes that failure skip the `clean` — so the branch
     * that removes untracked files, which is where an abandoned run's output
     * actually is, never runs precisely when the tree is least trustworthy.
     */
    const discarded = await exec(
      "git reset --hard; git clean -fdx -e node_modules",
      { cwd: dir }
    );
    // The clean is the last command, so this is its status. Reported because
    // this path is best-effort and otherwise silent: the tree the next task
    // starts from is whatever was left here.
    if (!discarded.success) {
      console.warn(
        `[${config.label}] the working tree was not fully discarded`,
        {
          dir,
          stderr: discarded.stderr.trim().slice(0, 500)
        }
      );
    }
  } catch (err) {
    console.warn(`[${config.label}] could not discard the working tree`, {
      err: String(err)
    });
  }
}

/**
 * Offer every workspace this caller has used a chance to go.
 *
 * A **backstop**, not the mechanism. Each workspace arms its own `idle-reclaim`
 * alarm on every use, and that is what normally fires — exactly seven days after
 * the last touch, with no registry and no help from the agent.
 *
 * What this covers is the one case a workspace cannot cover itself. A throwing
 * `alarm()` is retried a bounded number of times and then dropped permanently,
 * and `idle-reclaim` is the only intent that cannot heal on the next RPC,
 * because by definition nothing is calling in.
 *
 * The agent decides nothing. It knows which names it handed out; the workspace
 * knows when it was last touched, which is the only clock worth reading — the
 * agent names a workspace once and then the subagent facet uses it for the rest
 * of the task, traffic the agent never sees.
 */
export async function sweepIdleWorkspaces(config: {
  host: PluginHost<Env>;
  binding: WorkspaceNamespace;
  label: string;
}): Promise<void> {
  let callerKey: string;
  try {
    callerKey = config.host.callerKey();
  } catch {
    // A scheduled wake-up on an instance that has never served a turn. There is
    // nothing to sweep, because nothing was ever handed out.
    return;
  }

  const repos = activeRepo(config.host);
  for (const repo of repos.seen()) {
    const name = workspaceName(callerKey, repo);
    try {
      const result = await config.binding
        .get(config.binding.idFromName(name))
        .reclaimIfIdle();
      if (result.reclaimed) {
        console.info(`[${config.label}] reclaimed an idle workspace`, { name });
        // Drop the candidate with the workspace it named. Without this the list
        // only ever grows, so the sweep's cost is the number of repositories a
        // caller has *ever* touched rather than the number they still have —
        // and `set()` puts it back the moment they clone that repository again.
        repos.forget(repo);
      }
    } catch (err) {
      // Best-effort per workspace: one unreachable object must not stop the
      // sweep reaching the rest.
      console.warn(`[${config.label}] could not sweep a workspace`, {
        name,
        err: String(err)
      });
    }
  }
}

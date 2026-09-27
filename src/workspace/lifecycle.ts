import {
  workspaceName,
  type WorkspaceObjectBase
} from "@dynamicagents/plugins/workspace";
import { activeRepo } from "./active-repo";

/**
 * What an agent with a workspace owes it beyond the object itself: a sweep
 * whose whole job is to decide nothing. Here rather than in each agent, because
 * it is the kind of code that is subtly wrong in a copy.
 */

/** A workspace namespace, as either agent's `Env` spells it. */
export type WorkspaceNamespace = DurableObjectNamespace<WorkspaceObjectBase>;

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
 * agent names a workspace once and then a sub-agent uses it for the rest of its
 * run, traffic the agent never sees.
 */
export async function sweepIdleWorkspaces(config: {
  /** The agent's own storage, which holds the names it handed out. */
  storage: DurableObjectStorage;
  callerKey: string;
  binding: WorkspaceNamespace;
  label: string;
  /** Told each name this sweep retired, for a host keeping state about it. */
  onReclaimed?: (repo: string) => void;
}): Promise<void> {
  const repos = activeRepo(config.storage);
  for (const repo of repos.seen()) {
    const name = workspaceName(config.callerKey, repo);
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
        config.onReclaimed?.(repo);
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

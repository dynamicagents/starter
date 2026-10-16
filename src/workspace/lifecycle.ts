import { sandboxName } from "@dynamicagents/plugins/sandbox";
import { SANDBOX_RECLAIM_MS } from "@/config";
import { activeRepo } from "./active-repo";

/**
 * What an agent with a sandbox owes it beyond the object itself: a sweep
 * whose whole job is to decide nothing. Here rather than in each agent, because
 * it is the kind of code that is subtly wrong in a copy.
 */

/** A sandbox namespace, as either agent's `Env` spells it, by what a sweep calls. */
export type SweptNamespace = DurableObjectNamespace<
  {
    reclaimIfIdle(
      maxIdleMs: number
    ): Promise<{ reclaimed: boolean; idleMs: number }>;
  } & Rpc.DurableObjectBranded
>;

/**
 * Offer every sandbox this caller has used a chance to go.
 *
 * **This is the mechanism.** A sandbox stops its container minutes after its
 * last use, but nothing empties it — its checkout, its backups — until a sweep
 * asks, and it agrees only once {@link SANDBOX_RECLAIM_MS} have passed since its
 * own last use.
 *
 * The agent decides nothing. It knows which names it handed out; the sandbox
 * knows when it was last used, which is the only clock worth reading — the
 * agent names a sandbox once and then a sub-agent uses it for the rest of its
 * run, traffic the agent never sees.
 */
export async function sweepIdleWorkspaces(config: {
  /** The agent's own storage, which holds the names it handed out. */
  storage: DurableObjectStorage;
  callerKey: string;
  binding: SweptNamespace;
  label: string;
  /** Told each name this sweep retired, for a host keeping state about it. */
  onReclaimed?: (repo: string) => void;
}): Promise<void> {
  const repos = activeRepo(config.storage);
  for (const repo of repos.seen()) {
    const name = sandboxName(config.callerKey, repo);
    try {
      const result = await config.binding
        .getByName(name)
        .reclaimIfIdle(SANDBOX_RECLAIM_MS);
      if (result.reclaimed) {
        console.info(`[${config.label}] reclaimed an idle sandbox`, { name });
        // Drop the candidate with the sandbox it named. Without this the list
        // only ever grows, so the sweep's cost is the number of repositories a
        // caller has *ever* touched rather than the number they still have —
        // and `set()` puts it back the moment they clone that repository again.
        repos.forget(repo);
        config.onReclaimed?.(repo);
      }
    } catch (err) {
      // Best-effort per sandbox: one unreachable object must not stop the
      // sweep reaching the rest.
      console.warn(`[${config.label}] could not sweep a sandbox`, {
        name,
        err: String(err)
      });
    }
  }
}

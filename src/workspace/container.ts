import type { ComputerConfig } from "@dynamicagents/plugins/computer";
import {
  WORKSPACE_DIR,
  type WorkspaceObjectBase
} from "@dynamicagents/plugins/workspace";

/**
 * How long `bash` waits on an install in flight before running the command
 * anyway. See `installGateMs` below for why it is above the plugin's default.
 */
const INSTALL_GATE_MS = 180_000;

/**
 * What a read-only parent is told about the workspace, in place of the
 * `computer` plugin's own block — which describes a shell, a writer and an
 * editor the parent does not have. A model told it has a shell spends a turn
 * discovering it does not, and the natural next move, doing the work itself, is
 * the one thing the split exists to prevent.
 *
 * Here rather than in either agent's `plugins.ts` because both say it: two
 * copies drift, and the drift is invisible. What a sub-agent is told about
 * working in the tree belongs to `@dynamicagents/plugins/computer`.
 *
 * `delegate` is the sentence that differs, naming who does the work.
 */
export function parentWorkspaceContext(delegate: string): string {
  return [
    `You can read the workspace ${delegate} work in, but not change it: \`read\` a file, \`list\` a directory, \`find\` files by name, and \`grep\` their contents.`,
    "Use these to check a report against what is actually on disk — read the file it says it changed. You cannot run commands, write, edit or delete; that is what delegation is for.",
    "`node_modules` lives on the container's disk, not in the workspace, so these tools cannot see inside it. A sub-agent's shell can."
  ].join("\n");
}

/**
 * The tools a read-only parent keeps from its model: Think's own file writers,
 * over the same checkout its sub-agents work in. Its `activeTools` leave these
 * out; the computer plugin's own `bash` and `edit` are not installed on it at
 * all, and Think's `bash` is switched off.
 */
export const WORKSPACE_WRITERS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "delete"
]);

/**
 * The container settings every path into a workspace shares.
 *
 * Exported and shared because a partial copy of this has already caused an
 * outage: a path that rebuilt its own without `shell: "bash"` ran its commands
 * under a different shell than every other command in the same container. One
 * definition stops that wherever a workspace is reached.
 *
 * The name is a parameter rather than resolved here: it is one workspace per
 * caller **per repository** (`@cloudflare/computer` pairs one Durable Object
 * with one container, so two repositories cannot share one), and which
 * repository is the caller's to choose, turn by turn.
 *
 * A caller's checkout **outlives the task**, which is why `repo_clone` fetches
 * and resets an existing one rather than assuming an empty directory. Its
 * dependencies do not: they live on the container's disk, and a new container
 * reinstalls — `@dynamicagents/plugins/workspace` owns that.
 */
export function workspaceContainer(
  binding: DurableObjectNamespace<WorkspaceObjectBase>,
  workspaceName: () => string
): ComputerConfig {
  return {
    binding,
    workspaceName,
    cwd: WORKSPACE_DIR,
    /**
     * The image is `debian:stable-slim`, so `/bin/sh` is **dash** — and a model
     * writing shell writes bash. Left unset, a subagent lost two minutes to
     * `${PIPESTATUS[0]}` in a pipeline: dash has no such variable, failed the line
     * with exit 2 after a 58-second `npm run check`, and the model re-ran the
     * whole check a third time under `bash -c` to recover. See `ComputerConfig.shell`.
     *
     * Safe because the base image ships bash — that third command is the proof it
     * was there all along.
     */
    shell: "bash",
    /**
     * Above the plugin's 90-second default, because this deployment starts its
     * installs *early* rather than on demand.
     *
     * The workspace object arms an install the moment it sees a checkout with no
     * dependency tree, so by the time a command that needs one arrives, the
     * install is usually part-done and the gate only has to absorb the
     * remainder. But "usually"
     * is not "always": a model that reaches for `npm` immediately meets a fresh
     * ~85-second `npm ci`, and at 90 seconds the gate would give up a few seconds
     * short, report "nothing was run — call again in a moment", and spend a
     * step on it.
     *
     * Three minutes covers a measured install with room.
     */
    installGateMs: INSTALL_GATE_MS
    // No `timeoutMs`: the plugin's default is the one its container-idle window
    // is sized against, and a longer one needs that window raised with it.
  };
}

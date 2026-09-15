import { MAX_TOOL_CALL_MS, TOOL_CALL_GRACE_MS } from "@dynamicagents/core";
import type { ComputerConfig } from "@dynamicagents/plugins/computer";
import type { WorkspaceObjectBase } from "./object";
import { WORKSPACE_DIR } from "./object";

/**
 * How long `sb_exec` waits on an install in flight before running the command
 * anyway. See `installGateMs` below for why it is above the plugin's default.
 */
const INSTALL_GATE_MS = 180_000;

/**
 * What one container command may run for — derived, because the install gate and
 * the command share a single tool call, and core aborts that call's signal
 * `TOOL_CALL_GRACE_MS` short of `MAX_TOOL_CALL_MS` from its start. Core's
 * `MAX_TOOL_CALL_MS` explains what that ceiling protects, and `TOOL_CALL_GRACE_MS`
 * why the signal comes first.
 *
 * Staying under the signal is what keeps the container's own kill the one that
 * lands, and the difference is what the model gets back: the container's kill
 * returns every line the command wrote, while `sb_exec` stopping at the signal
 * returns only that it stopped. The margin covers the Worker-side work around the
 * command — opening the workspace, the gate's last read, starting the process — so
 * the two cannot race at the boundary. It is sized generously rather than measured.
 */
const COMMAND_TIMEOUT_MS =
  MAX_TOOL_CALL_MS - TOOL_CALL_GRACE_MS - INSTALL_GATE_MS - 15_000;

/**
 * The container settings every path into a workspace shares.
 *
 * Exported and shared because a partial copy of this has already caused an
 * outage. The coder's cancellation path used to rebuild its own — without
 * `shell: "bash"` — so a cancelled task's cleanup ran under a different shell
 * than every other command in the same container. One definition is what stops
 * that, and now it stops it across two agents rather than two call sites.
 *
 * The name is a parameter rather than resolved here: it is one workspace per
 * caller **per repository** (`@cloudflare/computer` pairs one Durable Object
 * with one container, so two repositories cannot share one), and the callers
 * differ in how they reach the caller half — `host.callerKey()` on a plugin
 * list, which throws once a task is cancelled, and `identityKeyOrTask` on the
 * cancellation path.
 *
 * A caller's checkout **outlives the task**, which is why `repo_clone` fetches
 * and resets an existing one rather than assuming an empty directory. What does
 * *not* outlive the container is `node_modules`; see `./install-plan.ts`.
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
     * The workspace object arms a reinstall the moment it sees a cold container,
     * so by the time a command that needs `node_modules` arrives, the install is
     * usually part-done and the gate only has to absorb the remainder. But "usually"
     * is not "always": a model that reaches for `npm` immediately meets a fresh
     * ~85-second `npm ci`, and at 90 seconds the gate would give up a few seconds
     * short, report "nothing was run — call again in a moment", and spend a turn
     * on it.
     *
     * Three minutes covers a measured install with room. It is not free: the wait
     * happens inside the same tool call as the command, so every second of it
     * comes out of {@link COMMAND_TIMEOUT_MS}.
     */
    installGateMs: INSTALL_GATE_MS,
    /**
     * Stated rather than defaulted, because it is one side of an invariant held
     * with core's tool deadline and the computer plugin's install gate. See
     * {@link COMMAND_TIMEOUT_MS} for why it sits below the call's signal rather
     * than at `MAX_TOOL_CALL_MS`.
     *
     * Note the other end of the same command: `CONTAINER_IDLE_MS` in `./object.ts`
     * must stay above this, or the idle sweeper destroys the container out from
     * under a command still running in it.
     */
    timeoutMs: COMMAND_TIMEOUT_MS
  };
}

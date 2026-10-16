import { scratch, DEFAULT_SCRATCH_DIR } from "@dynamicagents/plugins/scratch";
import type { AgentPlugin } from "@dynamicagents/core";
import type { sandboxExec } from "@dynamicagents/plugins/sandbox";
import type { ActiveRepo } from "./active-repo";

/**
 * How *this* Worker addresses a scratchpad.
 *
 * `@dynamicagents/plugins/scratch` owns what a scratchpad is — a git repository
 * with no remote, its empty initial commit, the reset, the words the model
 * reads. None of that is specific to this deployment.
 *
 * What is here is the half the plugin cannot have: **which Durable Object a
 * scratchpad lives in, and what records that it exists.** Both go through the
 * plugin's two hooks, the same seam `/repo` uses for the same reason.
 */

/**
 * The repository sentinel a scratchpad is keyed on.
 *
 * A scratchpad is routed as a repository — `sandboxName(caller, SCRATCH_REPO)`
 * gives it a sandbox of its own, so its own container and its own disk.
 *
 * Angle brackets because no GitHub name can contain them. This shares a namespace
 * with the `owner/repo` strings in {@link ActiveRepo}, so a sentinel a caller
 * could clone is a sentinel a caller could collide with — the same reasoning that
 * spells the pre-selection window `<unassigned>` — see `sandboxName` in
 * `@dynamicagents/plugins/sandbox`.
 */
export const SCRATCH_REPO = "<scratch>";

/**
 * Where a scratchpad lives, re-exported so `./lifecycle.ts` has one import site
 * for the pair. We take the plugin's default rather than naming a path: the
 * plugin decides the layout, and two spellings of one directory is how a
 * fallback drifts from the thing it falls back to.
 */
export const SCRATCH_DIR = DEFAULT_SCRATCH_DIR;

/**
 * The scratch plugin with this deployment's two hooks filled in.
 *
 * `beforeOpen` is the routing decision and has to be first — `exec` and
 * `workspace()` both resolve through the active selection, so a command issued
 * before it runs in whichever sandbox the last task left open. Going through
 * `active.set()` rather than setting the name some other way is also what enrols
 * a scratchpad in `sweepIdleWorkspaces`, which walks `seen()`: without it a
 * scratchpad's sandbox would never be reclaimed.
 *
 * `afterOpen` is what makes a scratchpad reachable at all. `checkoutDir()` on
 * the sandbox answers from the checkout record, and a scratchpad has
 * nothing else that would
 * write one — a directory with no `package.json` is exactly what the install
 * resolver skips. The `present` it reports back is the same probe the delegation
 * will make, so a sandbox that cannot see the tree says so in this tool's own
 * result rather than in a delegation refusing a scratchpad the model was just
 * told it had opened.
 */
export function hostScratch(config: {
  exec: ReturnType<typeof sandboxExec>;
  workspace: () => {
    noteCheckout(record: {
      dir: string;
      kind: "scratch";
    }): Promise<{ present: boolean }>;
  };
  active: ActiveRepo;
  author: { name: string; email: string };
}): AgentPlugin {
  return scratch({
    exec: config.exec,
    author: config.author,
    beforeOpen: () => config.active.set(SCRATCH_REPO),
    afterOpen: async ({ dir }) => {
      const { present } = await config.workspace().noteCheckout({
        dir,
        kind: "scratch"
      });
      return {
        ready: present,
        because: "the sandbox cannot see it yet"
      };
    }
  });
}

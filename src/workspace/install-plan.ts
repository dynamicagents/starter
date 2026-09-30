import {
  DEFAULT_INSTALL_PLAN,
  type InstallPlan
} from "@dynamicagents/plugins/workspace";

/**
 * How **this deployment** installs dependencies — the one file to edit when a
 * repository does it differently.
 *
 * The plugin owns the procedure (inspect the checkout in a fixed order, never
 * guess); the commands are here, because they vary per repository in a way a
 * hard-coded `npm ci` would get wrong for most of them.
 *
 * Runs on every checkout, and again for every new container: the tree lives on
 * the container's disk, so it goes with the container. It runs *outside* a turn
 * because `npm ci` measured 225 s on slack-gatekeeper, and a turn is cut after
 * at most fifteen minutes, losing the tool call in flight.
 *
 * Overrides are keyed `owner/repo`, exactly as the clone URL spells it, and
 * replace the whole command:
 *
 * ```ts
 * overrides: {
 *   "dynamicagents/slack-gatekeeper": "npm ci --no-audit --no-fund && npm run build"
 * }
 * ```
 *
 * They also participate in the fingerprint, so changing one re-installs rather
 * than reusing a tree built the old way.
 */
export const INSTALL_PLAN: InstallPlan = {
  // Spread, not restated, so a rule the plugin adds arrives here instead of
  // being pinned to the set that existed when this was written.
  ...DEFAULT_INSTALL_PLAN,
  overrides: {
    // A superproject: its own lockfile installs a git hook and nothing else,
    // and the code is in submodules no clone initialises. `bootstrap` is the
    // one command its AGENTS.md gives a clone: submodules on their branches,
    // then `npm ci` in each whose `node_modules` is empty — as every one is in
    // a new container. A reading session's copy carries what this leaves.
    "dynamicagents/dev-agents":
      "npm ci --no-audit --no-fund && npm run bootstrap"
  },
  // Above the measured 225 s, with room for a much larger repository. Bounds the
  // command, not the turn.
  timeoutMs: 20 * 60_000
};

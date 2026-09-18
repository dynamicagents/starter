import {
  DEFAULT_INSTALL_PLAN,
  type InstallPlan
} from "@dynamicagents/plugins/computer";

/**
 * How **this deployment** installs dependencies — the one file to edit when a
 * repository does it differently.
 *
 * The plugin owns the procedure (inspect the checkout in a fixed order, never
 * guess); the commands are here, because they vary per repository in a way a
 * hard-coded `npm ci` would get wrong for most of them.
 *
 * Runs on every checkout, and again for every new container: the tree lives on
 * the container's disk, so it goes with the container. It runs *outside* a round
 * because `npm ci` measured 225 s on slack-gatekeeper, and a chunk step is killed
 * at ten minutes — after which Workflows retries the chunk and installs again.
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
  overrides: {},
  // Above the measured 225 s, with room for a much larger repository. Bounds the
  // command, not the round.
  timeoutMs: 20 * 60_000
};

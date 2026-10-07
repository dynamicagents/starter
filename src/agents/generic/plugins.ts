import type { AgentPlugin } from "@dynamicagents/core";
import { browser } from "@dynamicagents/plugins/browser";

/**
 * The one file you edit to add or remove a capability for this agent.
 *
 * Delete a line and that module leaves the bundle entirely. Nothing in core
 * imports a plugin, and `@dynamicagents/plugins` has no root barrel — the bare
 * specifier does not resolve — so the guarantee is structural rather than a
 * tree-shaker's opinion. `npm run verify:isolation` asserts it on the built graph.
 *
 * Each agent in this Worker has its own copy of this file, which is what keeps
 * one agent's plugins out of another's graph. There is deliberately no shared
 * one: a single list would put every plugin in every agent.
 *
 * The agent and its `general` sub-agent install the same list. Files are
 * Think's own workspace, in each object's SQLite, so there is nothing to
 * install for them.
 */
export const plugins = (env: Env): AgentPlugin<Env>[] => [
  // Read web pages. Requires the `BROWSER` binding and a paid Workers plan.
  browser({ binding: env.BROWSER })
];

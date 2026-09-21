import type { AgentPlugin } from "@dynamicagents/core";
import { browser } from "@dynamicagents/plugins/browser";
import { recall } from "@dynamicagents/plugins/recall";
import { workspace } from "@dynamicagents/plugins/workspace";
import { RECALL } from "@/config";
import type { PluginHost } from "@dynamicagents/core/host";
import { general } from "./general";

/**
 * The one file you edit to add or remove a capability for this agent.
 *
 * Delete a line and that module leaves the bundle entirely. Nothing in core
 * imports a plugin, and `@dynamicagents/plugins` has no root barrel — the bare
 * specifier does not resolve — so the guarantee is structural rather than a
 * tree-shaker's opinion. `npm run verify:isolation` asserts it on the built graph.
 *
 * Each agent in this Worker has its own copy of this file, which is what keeps
 * arc-agi out of the proactive agent's graph. There is deliberately no shared
 * one: a single list would put every plugin in every agent.
 */

export const plugins = (host: PluginHost<Env>): AgentPlugin[] => [
  // The catch-all, first: order here is the order the delegating model is shown
  // the types, and it should read the general case before the specialized ones.
  general(),

  // Read web pages. Requires the `BROWSER` binding and a paid Workers plan.
  browser({ binding: host.env.BROWSER }),

  // The durable file store behind every subagent execution's workspace, plus
  // tools over it. At most one installed plugin may back a workspace; drop this
  // and core falls back to an in-memory one, so `runtime.workspaceBacking` is
  // always defined and the SubagentRuntime never needs a null check.
  workspace(),

  // Episodic memory: the messages each compaction folds away are embedded into
  // Vectorize and searchable afterwards. Wired to the session through
  // `runtime.onMessagesDisplaced` — see `agent.ts`.
  recall({
    ai: host.env.AI,
    index: host.env.VECTORIZE,
    namespace: host.callerKey,
    // The host's *resolved* AI Gateway id, so embedding calls are correlated with
    // chat calls. Spread the rest: enumerating each field silently drops any
    // option the plugin adds later.
    aiGatewayId: host.aiGatewayId,
    agentName: host.agentName,
    ...RECALL
  })
];

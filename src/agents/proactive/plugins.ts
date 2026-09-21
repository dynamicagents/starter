import type { AgentPlugin } from "@dynamicagents/core";
import { browser } from "@dynamicagents/plugins/browser";
import { recall } from "@dynamicagents/plugins/recall";
import { triage } from "@dynamicagents/plugins/triage";
import { RECALL, TRIAGE } from "@/config";
import type { PluginHost } from "@dynamicagents/core/host";

/**
 * The one file you edit to add or remove a capability for the proactive agent.
 *
 * Its own file, not shared with the reactive agent's, and that separation is what
 * the CI isolation check measures: nothing imported here reaches for `/arc-agi`,
 * so nothing arc-shaped can appear in this agent's module graph. A single shared
 * plugin list would put every plugin in every agent and make the guarantee
 * unmeasurable.
 *
 * Note what it does **not** install: `/workspace`. This agent never delegates, so
 * no subagent execution ever needs a durable file store — and `@cloudflare/shell`
 * is a real dependency to carry for nothing.
 */
export const plugins = (host: PluginHost<Env>): AgentPlugin[] => [
  // The pre-turn gate: is this message even for me?
  //
  // An agent that sees every message in its channels is mostly seeing messages
  // that are not for it. Left to the main loop, that judgement is made by a model
  // simultaneously trying to be helpful — and it degrades *invisibly*, because
  // failing to call a decline-tool looks identical to deciding not to. This moves
  // the decision somewhere it cannot be skipped, and it fails open: a gate that
  // throws counts as `true`, because a wrong reply is noise the user can see and
  // ignore while a wrong silence is invisible to whoever needed an answer.
  triage({
    ai: host.env.AI,
    aiGatewayId: host.aiGatewayId,
    agentName: host.agentName,
    ...TRIAGE
  }),

  // Read web pages. Requires the `BROWSER` binding and a paid Workers plan.
  browser({ binding: host.env.BROWSER }),

  // Episodic memory over the messages compaction folds away.
  recall({
    ai: host.env.AI,
    index: host.env.VECTORIZE,
    namespace: host.callerKey,
    // `host.aiGatewayId` is the **resolved** value. Reading it off
    // `PROACTIVE_CONFIG.model?.aiGatewayId` — as this used to — yields
    // `undefined` the moment that override is dropped in favour of core's
    // default, and these calls quietly stop being correlated.
    aiGatewayId: host.aiGatewayId,
    agentName: host.agentName,
    ...RECALL
  })
];

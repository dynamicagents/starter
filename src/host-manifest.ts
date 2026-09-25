import type { AgentManifest } from "@dynamicagents/core/a2a";

/**
 * The **stub** card served at `/.well-known/agent-card.json`.
 *
 * It describes the deployment, not an agent. Every agent here is a tenant of
 * one endpoint, so this card exists to be the single conformant, signed
 * AgentCard at the URI RFC 8615 and A2A's IANA registration reserve —
 * advertising where to call, which protocol, and that real cards are reachable
 * through `GetExtendedAgentCard`.
 *
 * It cannot list the tenants as interfaces. A card carries one interface entry
 * and spec §8.3.2 has clients take the first, so declaring one per tenant would
 * just make every client address whichever came first. They go in `description`
 * for a human reading the deploy in a browser, and are registered out of band.
 *
 * **The description must therefore name every mounted tenant.** It is the only
 * place this card says what is here, so a tenant missing from it is a tenant an
 * operator reading the deploy has no way to discover — which is what happened to
 * `claude-coder` when it was added to `src/index.ts` and not to this string.
 *
 * `skills` is empty for the same reason: the skills belong to the tenants, and
 * a client that picked one from here would have no way to act on it.
 */
export const hostManifest: AgentManifest = {
  name: "da-starter",
  description:
    "Hosts several Dynamic Agents behind one A2A endpoint. This card describes " +
    "the deployment rather than any one agent — call GetExtendedAgentCard with " +
    "a tenant id to fetch an agent's own card. Tenants: `reactive` (delegating " +
    "round loop), `cf-coder` (implements changes in a git repository and opens " +
    "pull requests), `claude-coder` (the same, for larger changes, working " +
    "several independent strands at once).",
  version: "0.1.0",
  // `extensions` is a required (repeated) protobuf field in v1.0 — we declare no
  // protocol extensions, so it stays empty. `extendedAgentCard` is set by core,
  // which owns that contract.
  capabilities: { streaming: false, pushNotifications: true, extensions: [] },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: []
};

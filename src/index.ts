import { createA2AWorker } from "@dynamicagents/core/worker";
import { Artifacts, handleArtifactRoute } from "@dynamicagents/core/artifacts";

import { hostManifest } from "./host-manifest";
import { reactive } from "./agents/reactive/definition";
import { proactive } from "./agents/proactive/definition";
import { arcPlayer } from "./agents/arc-player/definition";
import { cfCoder } from "./agents/cf-coder/definition";
import { claudeCoder } from "./agents/claude-coder/definition";

// Durable Objects and Workflows must be exported from the Worker entry so the
// runtime can resolve them by class name. `ReactiveSubagent` / `ArcPlayerSubagent`
// are **facets**: they need no wrangler binding and no `new_sqlite_classes` entry,
// only this export, so `ctx.exports` can find them.
export { ReactiveAgent } from "./agents/reactive/agent";
export { ReactiveSubagent } from "./agents/reactive/subagent";
export { HandleTaskWorkflow } from "./agents/reactive/workflow";
export { ProactiveAgent } from "./agents/proactive/agent";
export { NotifyTaskWorkflow } from "./agents/proactive/workflow";
export { ArcPlayerAgent } from "./agents/arc-player/agent";
export { ArcPlayerSubagent } from "./agents/arc-player/subagent";
export { ArcHandleTaskWorkflow } from "./agents/arc-player/workflow";

export { CfCoderAgent } from "./agents/cf-coder/agent";
export { CfCoderSubagent } from "./agents/cf-coder/subagent";
export { CfCoderWorkflow } from "./agents/cf-coder/workflow";

// The workspaces: a Durable Object holding one repository's filesystem in
// SQLite, paired with the container that mounts it. One class per agent that has
// one — a namespace is keyed by class name, so a shared class would put both
// agents' checkouts in one namespace. Both are thin subclasses of the base in
// `@dynamicagents/plugins/computer`; `verify:isolation` keeps each out of
// the bundles that do not install it.
export { CfCoderWorkspaceDO } from "./agents/cf-coder/workspace-do";
export { ClaudeCoderWorkspaceDO } from "./agents/claude-coder/workspace-do";

// Not one of our classes, and **not optional**. `CloudflareContainerBackend`
// builds the container's egress loopback with `ctx.exports.WorkspaceProxy`, so
// the class has to be in this module's graph under that exact name. Nothing
// imports it and no binding names it, which makes it look like dead code —
// deleting it compiles cleanly and breaks every container at runtime.
export { WorkspaceProxy } from "@cloudflare/computer";

// Core's own class, shipped whole and re-exported unmodified — there is nothing
// here to subclass, and a namespace is keyed by the class name, so this export
// is what `ARTIFACTS` resolves to. Why it is required rather than optional sits
// beside the binding in wrangler.jsonc.
export { Artifacts };

export { ClaudeCoderAgent } from "./agents/claude-coder/agent";
export { ClaudeCoderSubagent } from "./agents/claude-coder/subagent";
export { ClaudeCoderWorkflow } from "./agents/claude-coder/workflow";

/**
 * One Worker, every agent below, addressed by A2A `tenant`.
 *
 * They share one origin, one endpoint, one signing key and one card:
 *
 * ```
 * /.well-known/agent-card.json   the stub card for the deployment
 * /.well-known/jwks.json         the one public key, verifying every card
 * /a2a                           every agent, picked by params.tenant
 * ```
 *
 * Each agent is one `defineAgent` call in its own `definition.ts` — tenant id,
 * card, Durable Object, Workflow. That declaration is what is mounted here *and*
 * what the agent's Workflow resolves its DO stub from, so the two can never
 * address different objects. Adding an agent is one file plus a line below plus
 * its wrangler bindings; `npm run agent:new <tenant>` does all of it.
 *
 * A tenant rather than a path prefix, and one signing key rather than one per
 * agent, both because the AgentCard lives at a **well-known URI** — RFC 8615
 * defines those per-authority, so this origin serves one card and a gatekeeper pins
 * one key. What separates the agents is the gatekeeper token's tenant claim,
 * checked by core against the tenant the request addressed: a cryptographic
 * boundary that holds even though they share an audience. The README works
 * through why the alternative cannot be made to work.
 */
const a2a = createA2AWorker<Env>({
  manifest: hostManifest,
  agents: [reactive, proactive, arcPlayer, cfCoder, claudeCoder]
});

export default {
  /**
   * The artifact links first, everything else after — and the order is the
   * requirement, not a preference.
   *
   * `handleArtifactRoute` answers `null` for every path it does not claim, so
   * in front it costs the A2A router nothing and takes nothing from it. Behind
   * it, `/a/<token>` reaches a router that knows nothing about the prefix, and
   * what that costs is a link that opens onto the wrong answer rather than a
   * failure anyone notices. The artifact routes are not A2A and deliberately
   * sit outside it: no gatekeeper token, no tenant, and the token in the path
   * is the whole credential.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await handleArtifactRoute(request, env)) ?? a2a(request, env);
  }
} satisfies ExportedHandler<Env>;

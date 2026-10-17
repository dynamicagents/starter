import { createA2AWorker } from "@dynamicagents/core/worker";
import { Artifacts, handleArtifactRoute } from "@dynamicagents/core/artifacts";

import { hostManifest } from "./host-manifest";
import { generic } from "./agents/generic/definition";
import { coding } from "./agents/coding/definition";
import { claudeCoordinator } from "./agents/claude-coordinator/definition";

// Durable Objects and Workflows must be exported from the Worker entry so the
// runtime can resolve them by class name. Each tenant is a task host, the
// pipeline it runs each task as, and the step agent the pipeline's steps run
// on. The sub-agent classes are **facets**: they need no wrangler binding and
// no `new_sqlite_classes` entry, only this export, so `ctx.exports` can find
// them.
export { GenericHost } from "./agents/generic/host";
export { GenericWorkflow } from "./agents/generic/workflow";
export { GenericAgent } from "./agents/generic/agent";
export { GenericChild } from "./agents/generic/children";

export { CodingHost } from "./agents/coding/host";
export { CodingWorkflow } from "./agents/coding/workflow";
export { CodingAgent } from "./agents/coding/agent";
export { CodingChild } from "./agents/coding/children";

// The sandboxes: a Durable Object driving one container whose disk is the
// checkout, through `@dynamicagents/plugins/sandbox`. One class per agent that
// has one — a namespace is keyed by class name, so a shared class would put
// both agents' checkouts in one namespace.
export { CodingSandbox } from "./agents/coding/sandbox";
export { ClaudeCoordinatorSandbox } from "./agents/claude-coordinator/sandbox";

// Where each class's container egress is intercepted to, on `ctx.exports`: a
// stateless entrypoint per class, reading the same rules its sandbox does.
export { CodingEgress } from "./agents/coding/egress";
export { ClaudeCoordinatorEgress } from "./agents/claude-coordinator/egress";

// `@cloudflare/sandbox`'s, and not optional: a sandbox backs its checkouts up to
// R2 through `ctx.exports.DirectoryBackupGateway`, so nothing names it and
// every image change would lose unpushed work without it.
export { DirectoryBackupGateway } from "@dynamicagents/plugins/sandbox";

// Core's own class, shipped whole and re-exported unmodified — there is nothing
// here to subclass, and a namespace is keyed by the class name, so this export
// is what `ARTIFACTS` resolves to. Why it is required rather than optional sits
// beside the binding in wrangler.jsonc.
export { Artifacts };

export { ClaudeCoordinatorHost } from "./agents/claude-coordinator/host";
export { ClaudeCoordinatorWorkflow } from "./agents/claude-coordinator/workflow";
export { ClaudeCoordinatorAgent } from "./agents/claude-coordinator/agent";
export {
  ClaudeCoordinatorWriterChild,
  ClaudeCoordinatorReviserChild,
  ClaudeCoordinatorPlannerChild
} from "./agents/claude-coordinator/children";

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
 * card, Durable Object. Adding an agent is one file plus a line below plus its
 * wrangler bindings.
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
  agents: [generic, coding, claudeCoordinator]
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

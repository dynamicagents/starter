import type { AgentManifest } from "@dynamicagents/core/a2a";

/**
 * The transport-independent half of this agent's AgentCard. `buildBaseCard` adds
 * `supportedInterfaces` (the deployment's shared `/a2a` url, tagged with this
 * agent's tenant id) and the security scheme. Served via `GetExtendedAgentCard`,
 * since the well-known path carries the deployment's stub card.
 *
 * Names no model. A card is what a gatekeeper operator reads to decide what to
 * route here, and what belongs on it is what they can act on: this one takes a
 * change to a merge-ready pull request, review and CI included, and asks the
 * person only what nobody else can answer.
 */
export const manifest: AgentManifest = {
  name: "Claude Coordinator",
  description:
    "Carries a change through a repository to a pull request ready for you to merge. For anything substantial it has a plan written and sends you its link to approve, comment on or reject — unless you have told it you do not approve plans. Long-running coding sessions then build it in isolated checkouts, open the pull request, and answer its review and CI, while it watches the pull request between them and brings you only the questions nobody else can answer. Replies with the pull request's URL and what is left for you. Never merges, and never commits to a default branch.",
  version: "0.1.0",
  // `extensions` is a required (repeated) protobuf field in v1.0 — we declare no
  // protocol extensions, so it stays empty.
  capabilities: { streaming: false, pushNotifications: true, extensions: [] },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "implement-change",
      name: "Implement a substantial change",
      description:
        "Carry a described change through a repository end to end: a plan you approve by its link, then the implementation and tests, a pull request, and its review and CI answered. Suited to work that spans several files or needs judgement the request cannot fully specify.",
      tags: ["code", "git", "pull-request"],
      examples: [
        "In github.com/acme/api, add rate limiting to the public endpoints, with tests and docs.",
        "In github.com/acme/cli, migrate the config loader off the deprecated library and keep the existing file format working."
      ],
      // Empty means "inherit the card's defaultInput/OutputModes".
      inputModes: [],
      outputModes: [],
      // Empty means "inherit the card-level requirement" (the gatekeeper JWT).
      securityRequirements: []
    },
    {
      id: "planning",
      name: "Research and plan a change",
      description:
        "Research a repository and reply with a plan behind a link, or with findings when the question needs no change, without changing anything. Comment to have the plan revised, reject it to stop there, or approve it to have it built.",
      tags: ["code", "research", "planning"],
      examples: [
        "In github.com/acme/api, how does request authentication actually work end to end?",
        "In github.com/acme/cli, plan a migration off the deprecated config library; I'll decide after reading it."
      ],
      inputModes: [],
      outputModes: [],
      securityRequirements: []
    }
  ]
};

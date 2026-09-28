import type { AgentManifest } from "@dynamicagents/core/a2a";

/**
 * The transport-independent half of this agent's AgentCard. `buildBaseCard` adds
 * `supportedInterfaces` (the deployment's shared `/a2a` url, tagged with this
 * agent's tenant id) and the security scheme. Served via `GetExtendedAgentCard`,
 * since the well-known path carries the deployment's stub card.
 *
 * Deliberately does **not** name Claude Code or the model behind it. A card is
 * what a gatekeeper operator reads to decide what to route here, and the engine is
 * an implementation detail that would go stale the first time it changed. What
 * belongs here is the difference an operator can act on: this one takes larger,
 * self-contained changes, and works several strands at once when they are genuinely
 * independent.
 */
export const manifest: AgentManifest = {
  name: "Claude Coder Agent",
  description:
    "A senior software engineer for substantial changes. Give it a repository and a change to make; it researches the repository and replies with a plan to approve, comment on or reject. Once approved, it delegates the implementation to long-running coding sessions that each work in an isolated checkout, reviews the branches they push, runs the project's own tests and opens a pull request, and replies with its URL. At its best on work too large to specify step by step, and can carry several independent strands in parallel. Never commits to a default branch.",
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
        "Carry a described change through a repository end to end: a plan you approve, then the implementation, tests and a pull request. Suited to work that spans several files or needs judgement the request cannot fully specify.",
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
        "Research a repository and reply with a plan, or with findings when the question needs no change, without changing anything. Comment to have it revised, reject it to stop at the plan, or approve it to have it built.",
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

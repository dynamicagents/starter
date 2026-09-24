import type { AgentManifest } from "@dynamicagents/core/a2a";

/**
 * The transport-independent half of this agent's AgentCard. `buildBaseCard` adds
 * `supportedInterfaces` (the deployment's shared `/a2a` url, tagged with this
 * agent's tenant id) and the security scheme. Served via `GetExtendedAgentCard`,
 * since the well-known path carries the deployment's stub card.
 */
export const manifest: AgentManifest = {
  name: "Cloudflare Coder Agent",
  description:
    "A senior software engineer. Give it a repository and a change to make; it clones into a Linux sandbox, implements the change, runs the project's own tests, pushes a work branch and opens a pull request. Replies with the pull request URL. Never commits to a default branch.",
  version: "0.1.0",
  // `extensions` is a required (repeated) protobuf field in v1.0 — we declare no
  // protocol extensions, so it stays empty.
  capabilities: { streaming: false, pushNotifications: true, extensions: [] },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "implement-change",
      name: "Implement a change",
      description:
        "Make a described code change in a repository and open a pull request for it, with the project's own tests run and passing.",
      tags: ["code", "git", "pull-request"],
      examples: [
        "In github.com/acme/cli, add a --json flag to the list command, with a test.",
        "In github.com/acme/api, the /health endpoint returns 500 when the DB is slow. Fix it and add a regression test."
      ],
      // Empty means "inherit the card's defaultInput/OutputModes".
      inputModes: [],
      outputModes: [],
      // Empty means "inherit the card-level requirement" (the gatekeeper JWT).
      securityRequirements: []
    },
    {
      id: "investigate",
      name: "Investigate a repository",
      description:
        "Read an unfamiliar codebase and explain how something works, or why it is failing, without changing it. Returns findings rather than a pull request.",
      tags: ["code", "research"],
      examples: [
        "In github.com/acme/api, how does request authentication actually work end to end?",
        "In github.com/acme/cli, why is the integration suite flaky on CI but not locally?"
      ],
      inputModes: [],
      outputModes: [],
      securityRequirements: []
    }
  ]
};

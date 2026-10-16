import { WorkerEntrypoint } from "cloudflare:workers";
import type { EgressRoute } from "agents/harness/container";
import { claudeCodeSandboxEgress } from "@dynamicagents/plugins/claude-code";
import { githubSandboxEgress } from "@dynamicagents/plugins/repo-github";
import {
  sandboxEgress,
  type SandboxEgressRule
} from "@dynamicagents/plugins/sandbox";

/**
 * What `claude-coordinator`'s sandboxes may reach as the deployment, each host
 * declared by the plugin that needs it. `./sandbox.ts`'s config and the
 * entrypoint below both read this one list, so what is intercepted and what
 * serves it cannot disagree.
 *
 * A session is Claude Code, which reaches Anthropic through the CLI's
 * placeholder host, and it pushes its branch, opens its pull request and
 * answers its review as the deployment's account — git and `gh` both, so the
 * API is intercepted too. Every credentialed push is still held to what
 * `repo_push` would allow; `@dynamicagents/plugins/repo-github` says what that is.
 */
export const CLAUDE_COORDINATOR_EGRESS: readonly SandboxEgressRule[] = [
  claudeCodeSandboxEgress({ label: "claude-coordinator-egress" }),
  githubSandboxEgress({ tokenBinding: "GITHUB_TOKEN", api: true })
];

/** Where those hosts are intercepted to. `src/index.ts` exports it, so it is on `ctx.exports`. */
export class ClaudeCoordinatorEgress extends WorkerEntrypoint<
  Env,
  { routes: readonly EgressRoute[] }
> {
  override fetch(request: Request): Promise<Response> {
    return sandboxEgress(
      request,
      this.ctx.props.routes,
      this.env as unknown as Readonly<Record<string, unknown>>,
      CLAUDE_COORDINATOR_EGRESS
    );
  }
}

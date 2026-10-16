import { WorkerEntrypoint } from "cloudflare:workers";
import type { EgressRoute } from "agents/harness/container";
import { githubSandboxEgress } from "@dynamicagents/plugins/repo-github";
import {
  sandboxEgress,
  type SandboxEgressRule
} from "@dynamicagents/plugins/sandbox";

/**
 * What `coding`'s sandboxes may reach as the deployment: git, through GitHub's
 * placeholder host, for the parent's clone, fetch and push. `./sandbox.ts`'s
 * config and the entrypoint below both read this one list.
 *
 * **No API intercept.** The parent reads and opens pull requests from the
 * Worker with its own token, and nothing in the container needs the API as the
 * deployment — so `gh` there is anonymous. Git is not: any process in the
 * container can present the placeholder, so every credentialed push is held to
 * what `repo_push` would allow, whoever sent it.
 */
export const CODING_EGRESS: readonly SandboxEgressRule[] = [
  githubSandboxEgress({ tokenBinding: "GITHUB_TOKEN" })
];

/** Where that host is intercepted to. `src/index.ts` exports it, so it is on `ctx.exports`. */
export class CodingEgress extends WorkerEntrypoint<
  Env,
  { routes: readonly EgressRoute[] }
> {
  override fetch(request: Request): Promise<Response> {
    return sandboxEgress(
      request,
      this.ctx.props.routes,
      this.env as unknown as Readonly<Record<string, unknown>>,
      CODING_EGRESS
    );
  }
}

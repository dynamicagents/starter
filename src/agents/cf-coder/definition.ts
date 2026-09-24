import { defineAgent } from "@dynamicagents/core/worker";
import { manifest } from "./manifest";

/**
 * How this agent is reached: its tenant id, its card, its Durable Object, and the
 * Workflow its turns run on — declared once.
 *
 * `src/index.ts` mounts the tenant from this, and `./workflow.ts` resolves its DO
 * stub from this, so the two cannot address different Durable Objects.
 */
export const cfCoder = defineAgent({
  tenant: "cf-coder",
  manifest,
  agent: (env: Env) => env.CfCoderAgent,
  workflow: (env: Env) => env.CF_CODER_WORKFLOW
});

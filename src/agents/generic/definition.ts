import { defineAgent } from "@dynamicagents/core/worker";
import { manifest } from "./manifest";

/**
 * How this agent is reached: its tenant id, its card and its Durable Object,
 * declared once. `src/index.ts` mounts the tenant from this.
 */
export const generic = defineAgent({
  tenant: "generic",
  manifest,
  agent: (env: Env) => env.GenericTasks
});

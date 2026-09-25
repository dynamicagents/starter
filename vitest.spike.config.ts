import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import path from "node:path";
// The realm-neutral slice: this file runs in Node, and the `/testing` barrel
// pulls in `cloudflare:test` and `vitest`, which fails at load.
import {
  GATEKEEPER_ORIGIN,
  TEST_AGENT_PRIVATE_JWK
} from "@dynamicagents/core/testing/fixtures";

/**
 * The spike's own suite, on the spike's own Worker.
 *
 * Separate from `vitest.config.ts` because it boots a different
 * `wrangler.spike.jsonc` — a different `main`, different Durable Objects and a
 * different migration tag. Run it with
 * `npx vitest run -c vitest.spike.config.ts`.
 */

process.env.A2A_SIGNING_KEY ??= JSON.stringify(TEST_AGENT_PRIVATE_JWK);
process.env.GATEKEEPER_ORIGINS ??= JSON.stringify([GATEKEEPER_ORIGIN]);
// The debug routes are not exercised here — the specs drive the agent through
// core's real A2A edge — but `secrets.required` is what types them as definite
// strings, so the pool warns on every run without a value.
process.env.SPIKE_DEBUG_TOKEN ??= "spike-test-token";
// How the specs select the rule-based streaming model.
process.env.SPIKE_FAKE_MODEL ??= "1";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") }
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.spike.jsonc" },
      // Workers AI has no local execution mode, and leaving this unset makes
      // the pool eagerly open a remote connection per test file. Nothing here
      // calls the binding: the fake model answers every turn.
      remoteBindings: false,
      miniflare: {
        // A test-only binding for the sub-agent facet. In production it needs
        // none — facet storage is created beneath the bound parent — but the
        // pool only marks *bound* classes as Durable Object classes, so
        // without this `runAgentTool` cannot create the child.
        durableObjects: {
          SPIKE_GENERAL: { className: "SpikeGeneral", useSQLite: true }
        }
      }
    })
  ],
  test: {
    include: ["test/spike/**/*.spec.ts"],
    // A detached child sleeps for seconds, and a `check_back` wake is a real
    // alarm: the scenarios are slower than an inference-free suite usually is.
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});

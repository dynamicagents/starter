import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import path from "node:path";
// The realm-neutral slice, deliberately. This file runs in **Node**, and the
// `/testing` barrel pulls in `cloudflare:test` and `vitest`, which fails at load
// before a single test runs.
import {
  GATEKEEPER_ORIGIN,
  TEST_AGENT_PRIVATE_JWK
} from "@dynamicagents/core/testing/fixtures";
// Node-realm half of the VCR harness: it reaches `node:fs` to read and write
// cassettes, which workerd has no equivalent of.
import { createVcr, recordFromEnv } from "@dynamicagents/core/testing/node";

/**
 * The whole suite runs in the Workers runtime (workerd via miniflare) through a
 * single `cloudflareTest()` pool — including the loop specs, which drive the
 * round and turn operations against an injected mock model and a `FakeSession`.
 *
 * The pool reads `wrangler.jsonc` directly (main, compat settings, the AI
 * binding, and the three agent DOs with their SQLite migration) so this config
 * cannot drift from it; secrets are supplied via `process.env` below.
 */

// Test defaults for the required secrets. Real env vars — from CI or the shell —
// take precedence via `??=`. The pool sources `secrets.required`
// (wrangler.jsonc) from `process.env` into the worker `env`.
//
// One key for the whole deployment, in tests as in production — the card is
// per-origin, so the key the gatekeeper pins is too.
process.env.A2A_SIGNING_KEY ??= JSON.stringify(TEST_AGENT_PRIVATE_JWK);
process.env.GATEKEEPER_ORIGINS ??= JSON.stringify([GATEKEEPER_ORIGIN]);
// The coder's. Never real: nothing in the suite reaches GitHub — the repo tools
// are tested against an injected `exec`. It exists only so `secrets.required` is
// satisfied and the pool stops warning.
//
// No model credential appears here because this Worker holds none: every agent
// reaches Workers AI through the `AI` binding, which the platform authenticates.
//
// This Worker's *own* origin has no line here on purpose either: core discovers
// it from the `jku` on each turn, so there is nothing to answer — and a default
// here would hide the case an operator actually hits.
process.env.GITHUB_TOKEN ??= "test-token";
// The identity half of the same setup, left blank on purpose: that satisfies
// `secrets.required` while exercising the same `|| "da-coder"` fallback a
// real deploy takes when an operator leaves them unset.
process.env.GITHUB_NAME ??= "";
process.env.GITHUB_EMAIL ??= "";
// claude-coder's credential pool. Never real, and nothing in the suite reaches
// Anthropic — the egress gateway is tested against a stubbed `fetch` in
// `@dynamicagents/plugins`, and no spec here starts a session. One line per
// entry in `wrangler.jsonc`'s `secrets.required`, since that list is what the
// generated `Env` types as a definite string, and the pool only ever leaves
// this Worker through the egress gateway.
process.env.CLAUDE_CODE_OAUTH_TOKEN_1 ??= "sk-ant-oat01-test-1";
process.env.CLAUDE_CODE_OAUTH_TOKEN_2 ??= "sk-ant-oat01-test-2";
process.env.CLAUDE_CODE_OAUTH_TOKEN_3 ??= "sk-ant-oat01-test-3";

/**
 * The recorder, and the reason the suite cannot reach the network by accident.
 *
 * Every outbound fetch flows through this one Miniflare hook. With no active
 * cassette it is **blocked** rather than forwarded, so a spec that grows a real
 * HTTP call fails loudly instead of silently depending on someone's credentials
 * and an internet connection.
 *
 * `outboundService` is the hook, never `fetchMock`: that option is gone, and an
 * unknown key under `miniflare` is ignored rather than rejected — so reaching
 * for it again would disable this silently rather than fail.
 */
const vcr = createVcr({
  snapshotsDir: path.resolve(import.meta.dirname, "test/snapshots"),
  record: recordFromEnv(),
  // What makes a cassette safe to commit, and why replay needs no credentials.
  excludeHeaders: ["authorization", "x-api-key", "cookie", "set-cookie"]
});

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") }
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Required, not just the default. Workers AI has no local execution mode
      // (Miniflare always proxies `AI` through a remote-connection worker), and
      // leaving this unset — even though `false` is its documented default —
      // measurably makes the pool eagerly establish that remote connection per
      // test file (~15-20s total, plus a reproducible teardown hang: "close
      // timed out after 10000ms"). Passing `false` explicitly avoids it
      // entirely: `AI.run()` still fails gracefully the moment a turn actually
      // calls it, but nothing is attempted at test-file startup.
      remoteBindings: false,
      miniflare: {
        outboundService: vcr.outboundService,
        // Test-only Durable Object bindings for the subagent facet classes.
        //
        // In production they need NO binding and NO `new_sqlite_classes` entry —
        // facet storage is created beneath the bound parent agent — but the
        // Vitest pool only marks *bound* classes as DO classes, so without this
        // `ctx.exports.ReactiveSubagent` is not facet-compatible and
        // `subAgent()` throws. See "Notes for testing" in
        // node_modules/agents/docs/sub-agents.md.
        durableObjects: {
          REACTIVE_SUBAGENT: {
            className: "ReactiveSubagent",
            useSQLite: true
          },
          CODER_SUBAGENT: {
            className: "CoderSubagent",
            useSQLite: true
          },
          CLAUDE_CODER_SUBAGENT: {
            className: "ClaudeCoderSubagent",
            useSQLite: true
          }
        }
      }
    })
  ],
  test: {
    include: ["test/**/*.spec.ts"],
    // Node realm. Last chance to flush a cassette; each is already written when
    // its test releases it, so this is only a safety net.
    globalSetup: ["@dynamicagents/core/testing/vcr-global-setup"]
  }
});

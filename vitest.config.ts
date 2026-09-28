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
 * single `cloudflareTest()` pool.
 *
 * The pool reads `wrangler.jsonc` directly (compat settings, the AI binding, and
 * the agent DOs with their SQLite migration) so this config cannot drift from
 * it; secrets are supplied via `process.env` below. Its `main` is
 * `test/worker.ts`, which is this deployment's Worker plus each agent on a
 * scripted model — Workers AI has no local mode, so a real model cannot finish
 * a turn here.
 */

// Test defaults for the required secrets. Real env vars — from CI or the shell —
// take precedence via `??=`. The pool sources `secrets.required`
// (wrangler.jsonc) from `process.env` into the worker `env`.
//
// One key for the whole deployment, in tests as in production — the card is
// per-origin, so the key the gatekeeper pins is too.
process.env.A2A_SIGNING_KEY ??= JSON.stringify(TEST_AGENT_PRIVATE_JWK);
process.env.GATEKEEPER_ORIGINS ??= JSON.stringify([GATEKEEPER_ORIGIN]);
// Both coders'. Never real: nothing in the suite reaches GitHub — the repo tools
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
      main: "./test/worker.ts",
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
        // Test-only Durable Object bindings: the scripted agents in
        // `test/worker.ts`, the hosts pointed at them, and every sub-agent
        // class.
        //
        // In production a sub-agent needs NO binding and NO `new_sqlite_classes`
        // entry — facet storage is created beneath the bound parent agent — but
        // the pool only marks *bound* classes as DO classes, so without these
        // `runAgentTool` cannot create a child. See "Notes for testing" in
        // node_modules/agents/docs/sub-agents.md.
        durableObjects: {
          TEST_REACTIVE: { className: "TestReactive", useSQLite: true },
          TEST_CF_CODER: { className: "TestCfCoder", useSQLite: true },
          TEST_CLAUDE_CODER: { className: "TestClaudeCoder", useSQLite: true },
          TEST_REACTIVE_TASKS: {
            className: "TestReactiveTasks",
            useSQLite: true
          },
          TEST_CF_CODER_TASKS: {
            className: "TestCfCoderTasks",
            useSQLite: true
          },
          TEST_CLAUDE_CODER_TASKS: {
            className: "TestClaudeCoderTasks",
            useSQLite: true
          },
          REACTIVE_GENERAL: { className: "ReactiveGeneral", useSQLite: true },
          CF_CODER_CODE: { className: "CfCoderCode", useSQLite: true },
          CLAUDE_CODER_SESSION: {
            className: "ClaudeCoderSession",
            useSQLite: true
          },
          CLAUDE_CODER_READER: {
            className: "ClaudeCoderReader",
            useSQLite: true
          },
          TEST_REACTIVE_GENERAL: {
            className: "TestReactiveGeneral",
            useSQLite: true
          },
          TEST_CF_CODER_CODE: { className: "TestCfCoderCode", useSQLite: true },
          TEST_CLAUDE_CODER_SESSION: {
            className: "TestClaudeCoderSession",
            useSQLite: true
          },
          TEST_CLAUDE_CODER_READER: {
            className: "TestClaudeCoderReader",
            useSQLite: true
          }
        },
        // The scripted pipelines, beside the real ones `wrangler.jsonc` binds.
        workflows: {
          TEST_REACTIVE_TASK: {
            name: "test-reactive-task",
            className: "TestReactiveTask"
          },
          TEST_CF_CODER_TASK: {
            name: "test-cf-coder-task",
            className: "TestCfCoderTask"
          },
          TEST_CLAUDE_CODER_TASK: {
            name: "test-claude-coder-task",
            className: "TestClaudeCoderTask"
          }
        }
      }
    })
  ],
  test: {
    include: ["test/**/*.spec.ts"],
    // A lifecycle spec waits on real alarms: a background run reports in a
    // later turn.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Node realm. Last chance to flush a cassette; each is already written when
    // its test releases it, so this is only a safety net.
    globalSetup: ["@dynamicagents/core/testing/vcr-global-setup"]
  }
});

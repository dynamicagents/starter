/**
 * The sandbox image's entrypoint: the harness daemon, serving Claude Code as
 * each session's CLI. Node, not a Worker — `scripts/build-daemon.mjs` bundles
 * it for `Dockerfile.sandbox` — so it imports nothing that reaches the Worker's
 * bindings, and its relative imports are to modules with none.
 *
 * What a session is told to answer is named here and compiled in: a run's
 * header names a schema, never carries one. The credential and the hosts are
 * not here at all — they are the egress's, on the Worker side.
 */
import { claudeCodeDaemonCli } from "@dynamicagents/plugins/claude-code/daemon";
import { serveSandboxDaemon } from "@dynamicagents/plugins/sandbox/daemon";
import { SESSION_SCHEMAS } from "./agents/claude-coordinator/schemas";
import { CLAUDE_CODE_SESSION, SANDBOX_ADAPTER } from "./config";

await serveSandboxDaemon({
  cli: claudeCodeDaemonCli({
    id: SANDBOX_ADAPTER,
    schemas: SESSION_SCHEMAS,
    model: CLAUDE_CODE_SESSION.model,
    effort: CLAUDE_CODE_SESSION.effort,
    permissionMode: CLAUDE_CODE_SESSION.permissionMode,
    maxSubagentDepth: CLAUDE_CODE_SESSION.maxSubagentDepth,
    maxConcurrentSubagents: CLAUDE_CODE_SESSION.maxConcurrentSubagents
  })
});

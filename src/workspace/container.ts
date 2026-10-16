import type { ComputerToolsConfig } from "@dynamicagents/plugins/computer";
import {
  sandboxExec,
  type SandboxExecHost,
  type SandboxObjectConfig
} from "@dynamicagents/plugins/sandbox";
import { gitIdentity } from "./git-identity";

/**
 * How long `bash` waits on an install in flight before running the command
 * anyway. See `installGateMs` below for why it is above the plugin's default.
 */
const INSTALL_GATE_MS = 180_000;

/**
 * What a read-only parent is told about the checkout, in place of the
 * `computer` plugin's own block — which describes a shell, a writer and an
 * editor the parent does not have. A model told it has a shell spends a turn
 * discovering it does not, and the natural next move, doing the work itself, is
 * the one thing the split exists to prevent.
 *
 * Here rather than in either agent's `plugins.ts` because both say it: two
 * copies drift, and the drift is invisible. What a sub-agent is told about
 * working in the tree belongs to `@dynamicagents/plugins/computer`.
 *
 * `delegate` is the sentence that differs, naming who does the work.
 */
export function parentWorkspaceContext(delegate: string): string {
  return [
    `You can read the checkout ${delegate} work in, but not change it: \`read\` a file, \`list\` a directory, \`find\` files by name, and \`grep\` their contents.`,
    "Use these to check a report against what is actually on disk — read the file it says it changed. You cannot run commands, write, edit or delete; that is what delegation is for.",
    "`node_modules` is on the container's disk beside the checkout, and these tools leave it out. A sub-agent's shell can read it."
  ].join("\n");
}

/**
 * The tools a read-only parent keeps from its model: Think's own file writers,
 * over the same checkout its sub-agents work in. Its `activeTools` leave these
 * out; the computer plugin's own `bash` and `edit` are not installed on it at
 * all, and Think's `bash` is switched off.
 */
export const WORKSPACE_WRITERS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "delete"
]);

/** A sandbox namespace, as either agent's `Env` spells it. */
export type SandboxNamespace = DurableObjectNamespace<
  SandboxExecHost & Rpc.DurableObjectBranded
>;

/**
 * The environment every command in a sandbox runs under — an `exec`, an
 * install, a session — beside what the egress rules add.
 *
 * `CI` and `HUSKY=0` because a cloned repository's install would otherwise
 * install its git hooks into the checkout, and every commit a session makes
 * would then run them. `--use-openssl-ca` because Node keeps its own CA list,
 * and an intercepted HTTPS host is signed by the runtime's CA, which the
 * sandbox trusts in the system store. The author is the one every other commit
 * in this Worker carries: see `./git-identity.ts`.
 */
export function sandboxEnv(env: Env): Record<string, string> {
  const author = gitIdentity(env);
  return {
    CI: "1",
    HUSKY: "0",
    DISABLE_AUTOUPDATER: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_PROGRESS: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    WRANGLER_SEND_METRICS: "false",
    LANG: "C.UTF-8",
    NODE_OPTIONS: "--use-openssl-ca",
    GIT_AUTHOR_NAME: author.name,
    GIT_COMMITTER_NAME: author.name,
    // An empty email is git's fatal "empty ident"; unset, git falls back to
    // what the checkout's own config says.
    ...(author.email
      ? { GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_EMAIL: author.email }
      : {})
  };
}

/**
 * A sandbox's config, from what is this agent's. One builder for both agents,
 * because the shared half — the environment, where checkouts are backed up —
 * has to be the same for every sandbox this Worker runs.
 */
export function sandboxConfigFor(
  env: Env,
  ctx: DurableObjectState,
  own: Omit<SandboxObjectConfig, "env" | "backups"> & {
    /** Under `SANDBOX_BACKUPS`, one prefix per class. */
    backupPrefix: string;
  }
): SandboxObjectConfig {
  const { backupPrefix, ...config } = own;
  return {
    ...config,
    env: sandboxEnv(env),
    backups: {
      binding: "SANDBOX_BACKUPS",
      prefix: backupPrefix,
      gateway: ctx.exports.DirectoryBackupGateway
    }
  };
}

/**
 * The computer tools' settings, the same on every path into a sandbox.
 *
 * Shared because a partial copy of a config like this has already caused an
 * outage: a path that rebuilt its own without `shell: "bash"` ran its commands
 * under a different shell than every other command in the same container.
 */
export const SANDBOX_TOOLS: ComputerToolsConfig = {
  /**
   * `/bin/sh` is **dash** on Debian, and a model writing shell writes bash. Left
   * unset, a subagent lost two minutes to `${PIPESTATUS[0]}` in a pipeline: dash
   * has no such variable, failed the line with exit 2 after a 58-second `npm
   * run check`, and the model re-ran the whole check a third time under `bash -c`
   * to recover.
   */
  shell: "bash",
  /**
   * Above the plugin's 90-second default, because this deployment starts its
   * installs *early*: a checkout's install is armed as soon as it is cloned, so
   * a command that needs one usually meets the remainder of it. A model that
   * reaches for `npm` immediately meets a fresh ~85-second `npm ci`, and three
   * minutes covers a measured install with room.
   */
  installGateMs: INSTALL_GATE_MS
};

/** A shell for `/repo-github`, `/scratch` and this Worker's own scripts, in the sandbox `name` resolves. */
export function sandboxShell(binding: SandboxNamespace, name: () => string) {
  return sandboxExec({ binding, sandboxName: name, shell: "bash" });
}

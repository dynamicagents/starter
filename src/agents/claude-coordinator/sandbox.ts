import {
  credentialHost,
  type CredentialLease,
  type Lead
} from "@dynamicagents/plugins/claude-code";
import {
  SandboxObjectBase,
  type SandboxObjectConfig
} from "@dynamicagents/plugins/sandbox";
import { CLAUDE_COORDINATOR_SANDBOX_INSTANCE, SANDBOX_ADAPTER } from "@/config";
import { INSTALL_PLAN } from "@/workspace/install-plan";
import { sandboxConfigFor } from "@/workspace/container";
import { claudeCredentials, CREDENTIALS_KEY } from "./claude-code";
import { CLAUDE_COORDINATOR_EGRESS } from "./egress";

/**
 * `claude-coordinator`'s sandbox, bound as `CLAUDE_COORDINATOR_SANDBOX`: one
 * container per caller per repository, whose disk is the checkout, and the
 * Claude Code sessions that run in it.
 *
 * Everything a sandbox does is `@dynamicagents/plugins/sandbox`'s. What is this
 * agent's: the hosts its sessions reach (`./egress.ts`), and the Anthropic
 * credential pool those reach Anthropic with, in this object's own storage —
 * the egress leases from the sandbox a request came from, so the container
 * never holds a credential.
 */
export class ClaudeCoordinatorSandbox
  extends SandboxObjectBase<Env>
  implements CredentialLease
{
  /**
   * Per sandbox, deliberately. Every sandbox draws the same subscription
   * buckets, so the strictly-correct home is one object they all consult; one
   * each costs a wasted `429` per sandbox per rotation, bounded by how many
   * run at once, which is far cheaper than a class, a binding and an RPC on the
   * rotation path.
   */
  readonly #pool = credentialHost({
    storage: this.ctx.storage,
    credentials: () => claudeCredentials(this.env),
    key: CREDENTIALS_KEY
  });

  protected sandboxConfig(): SandboxObjectConfig {
    return sandboxConfigFor(this.env, this.ctx, {
      label: "claude-coordinator-sandbox",
      adapter: SANDBOX_ADAPTER,
      instance: CLAUDE_COORDINATOR_SANDBOX_INSTANCE,
      installPlan: INSTALL_PLAN,
      egress: {
        entrypoint: this.ctx.exports.ClaudeCoordinatorEgress,
        self: "CLAUDE_COORDINATOR_SANDBOX",
        rules: CLAUDE_COORDINATOR_EGRESS
      },
      backupPrefix: "claude-coordinator/"
    });
  }

  // The pool, as `claudeCodeSandboxEgress` leases from it.

  async lead(): Promise<Lead> {
    return this.#pool.lead();
  }

  async spend(id: string, resetAt: number): Promise<Lead> {
    return this.#pool.spend(id, resetAt);
  }

  async reject(id: string): Promise<Lead> {
    return this.#pool.reject(id);
  }

  /**
   * Admit a session: forget the pool's marks, so its first model call asks
   * Anthropic again — `admit` in `@dynamicagents/plugins/claude-code` says why.
   * Called before a session is dispatched; see `admitSession` in `./plugins.ts`.
   */
  async claudeAdmit(): Promise<Lead> {
    return this.#pool.admit();
  }

  /**
   * The Claude Code session a run started here, and the plan it filed — what
   * lets a later run continue that conversation. See `plannedSession` in
   * `./plans.ts`.
   *
   * On this object because the conversation is here: the harness keeps each
   * run's session and the CLI's files for it, so a sandbox that is reclaimed
   * takes the record with the conversation it names. A record found is one
   * whose conversation can be continued.
   *
   * It keeps the plan and its version once it has them: a recovered turn reports
   * the session's handle again, without them.
   */
  async noteSession(runId: string, note: SessionNote): Promise<void> {
    const key = `${SESSION_KEY}${runId}`;
    const filed = note.plan
      ? note
      : await this.ctx.storage.get<SessionNote>(key);
    await this.ctx.storage.put(key, {
      sessionId: note.sessionId,
      ...(note.transcript ? { transcript: note.transcript } : {}),
      ...(filed?.plan ? { plan: filed.plan } : {}),
      ...(filed?.version !== undefined ? { version: filed.version } : {})
    });
  }

  /** A run's session, if this sandbox still holds it. Starts no container. */
  async sessionOf(runId: string): Promise<SessionNote | undefined> {
    return await this.ctx.storage.get<SessionNote>(`${SESSION_KEY}${runId}`);
  }

  /** A session whose conversation turned out to be gone, so none resumes it. */
  async forgetSession(runId: string): Promise<void> {
    await this.ctx.storage.delete(`${SESSION_KEY}${runId}`);
  }
}

/** Where {@link ClaudeCoordinatorSandbox.noteSession} keeps a run's session. */
const SESSION_KEY = "claude-session:";

/** A run's Claude Code session, as its sandbox records it. */
export interface SessionNote {
  sessionId: string;
  /**
   * The transcript its notes went on: the run's own, or the one it carried on
   * — what a run continuing this conversation files on too.
   */
  transcript?: string;
  /** A plan this session filed a version of: a planning run's. */
  plan?: string;
  /** Which version: the sequence of the entry it filed on the plan's page. */
  version?: number;
}

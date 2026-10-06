import {
  claudeCodeSession,
  credentialPool,
  readRateLimitEvent,
  type CredentialState,
  type CredentialStore,
  type Lead,
  type RateLimitInfo
} from "@dynamicagents/plugins/claude-code";
import {
  WorkspaceObjectBase,
  type WorkspaceObjectConfig
} from "@dynamicagents/plugins/workspace";
import {
  CLAUDE_COORDINATOR_WORKSPACE_INSTANCE,
  CLAUDE_CODE_SESSION
} from "@/config";
import { INSTALL_PLAN } from "@/workspace/install-plan";
import { gitIdentity } from "@/workspace/git-identity";
import { claudeCodeConfig, CREDENTIALS_KEY } from "./claude-code";

/**
 * `claude-coordinator`'s workspace, bound as `CLAUDE_COORDINATOR_WORKSPACE`.
 *
 * Everything a workspace does is in `@dynamicagents/plugins/workspace`,
 * shared with `coding`. Two things are this agent's own, and both exist so that the container
 * never holds an Anthropic credential — see `./claude-code.ts`:
 *
 * 1. `egress: { mode: "http-gateway" }`, so every outbound request from the
 *    container is intercepted and handed to a `Fetcher` on this side of the
 *    boundary. That `Fetcher` swaps a real credential in.
 * 2. The credential pool's state, in this object's own storage.
 *
 * **Trusting the interception CA is the other half of (1), and it is not
 * optional.** Interception terminates the container's HTTPS under an ephemeral
 * CA, so a container that does not trust it has no working HTTPS client at all
 * — `npm ci` fails with SELF_SIGNED_CERT_IN_CHAIN and the session reports
 * "Self-signed certificate detected", neither of which mentions egress.
 *
 * That trust is installed by the workspace object in
 * `@dynamicagents/plugins/workspace`, whose `ca-trust` module carries the
 * full reasoning — including why it cannot live in the image's entrypoint, where
 * Cloudflare's own recipe puts it. Changing this mode means reading it.
 */
export class ClaudeCoordinatorWorkspace extends WorkspaceObjectBase {
  /**
   * The credential pool's `{ index → resetAt }` map.
   *
   * **Per workspace, deliberately.** Every workspace draws the same subscription
   * buckets, so the strictly-correct home for this is one shared object that all
   * of them consult. That costs a Durable Object class, a binding, a migration
   * and an RPC on the rotation path; keeping it here costs one wasted `429` per
   * workspace per rotation, bounded by how many workspaces run at once — a
   * fan-out's width. At that width it is the cheaper trade by a wide margin — and
   * if it ever stops being, the `CredentialStore` seam is exactly where a shared
   * object would plug in.
   */
  readonly #credentials: CredentialStore = {
    read: async () =>
      (await this.ctx.storage.get<CredentialState[]>(CREDENTIALS_KEY)) ?? [],
    write: async (states) => {
      await this.ctx.storage.put(CREDENTIALS_KEY, states);
    }
  };

  /**
   * Built once, and only for its `egress()` — this object never starts a
   * session. A sub-agent does that, over RPC, through the workspace runtime.
   */
  readonly #session = claudeCodeSession(claudeCodeConfig(this.env));

  protected workspaceConfig(): WorkspaceObjectConfig {
    return {
      binding: "CLAUDE_COORDINATOR_WORKSPACE",
      label: "claude-coordinator-workspace",
      installPlan: INSTALL_PLAN,
      instance: CLAUDE_COORDINATOR_WORKSPACE_INSTANCE,
      // Above the whole session.
      //
      // The base's default is twenty minutes, and its rule is that the window
      // must exceed the longest command the shell allows — measured from when
      // that command *starts*, because nothing touches the object again while it
      // runs. This agent's longest command is a `claude -p` session that stays
      // detached for its entire timeout, so twenty minutes would put the idle
      // alarm inside a live session and stop the container under it, losing both
      // the work and the cached prefix that bought it.
      //
      // Derived from the session timeout rather than written out, so raising one
      // moves the other. The margin covers the gap between a session ending and
      // its report being written.
      containerIdleMs: CLAUDE_CODE_SESSION.timeoutMs + 5 * 60_000,
      egress: {
        mode: "http-gateway",
        gateway: this.#session.egress(this.#credentials)
      },
      // See `coding`'s workspace for why the binding is named, not read.
      git: { tokenBinding: "GITHUB_TOKEN", author: gitIdentity(this.env) }
    };
  }

  /**
   * Is any credential usable right now, and if not, when? Asked before a
   * session is dispatched — see `admitSession` in `./plugins.ts`, which carries
   * the reason.
   */
  async claudeCredentials(): Promise<Lead> {
    return await this.#session.credentials(this.#credentials);
  }

  /**
   * What the session's own client reported about the bucket it is spending.
   *
   * The pool learns a credential is empty from the gateway, which learns it from
   * a refused request — so the cost of finding out is a refusal. The client
   * announces the same bucket on its stream, ahead of that, which is the one
   * place a credential can be retired *before* something fails.
   *
   * Whether a given reading means empty is the plugin's to decide, and today it
   * decides nothing: the only status ever observed is `allowed`, and treating an
   * unrecognised one as exhaustion would retire a working credential for hours —
   * the same trade that leaves a 403 unclassified. So this is the wiring, live
   * and inert, waiting on a real refusal to name the status that fills it.
   *
   * **It marks whichever credential is leading now, which is an approximation.**
   * The report carries the last reading the session made, so this cannot be a
   * stale one from an earlier session — but a pool that rotated
   * between the reading and this call marks the wrong entry. That is bounded:
   * rotation only happens on a refusal, which is the gateway already retiring
   * the credential this would have retired, and `spend` takes the later of the
   * two resets. Carrying the identity from inside the container is the only
   * exact answer, and the container is deliberately told nothing about which
   * credential it is spending.
   */
  async claudeNoteRateLimit(info: RateLimitInfo): Promise<void> {
    const resetAt = readRateLimitEvent(info);
    // A reset already in the past retires nothing and would only write a row.
    if (resetAt === undefined || resetAt <= Date.now()) return;

    const pool = credentialPool({
      credentials: claudeCodeConfig(this.env).credentials,
      store: this.#credentials
    });
    // Whichever credential the gateway is handing out is the one this session's
    // requests carried, so it is the one the reading is about.
    const lead = await pool.lead();
    if (!lead.ok) return;
    await pool.spend(lead.id, resetAt);
    console.warn(
      "[claude-coordinator-workspace] retiring a credential on the " +
        "client's own bucket reading",
      {
        id: lead.id,
        resetAt: new Date(resetAt).toISOString(),
        status: info.status
      }
    );
  }

  /**
   * The Claude Code session a run started here, and the plan it filed — what
   * lets a later run continue that conversation. See `plannedSession` in
   * `./plans.ts`.
   *
   * On this object rather than the agent's because the conversation is here: a
   * session's transcript is under the workspace mount, in this object's storage
   * — `SESSION_CONFIG_DIR` in `@dynamicagents/plugins/claude-code` — so a
   * workspace that is reclaimed takes the record with the transcript it names.
   * A record found is one whose conversation can be continued.
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
      ...(filed?.plan ? { plan: filed.plan } : {}),
      ...(filed?.version !== undefined ? { version: filed.version } : {})
    });
  }

  /** A run's session, if this workspace still holds it. Starts no container. */
  async sessionOf(runId: string): Promise<SessionNote | undefined> {
    return await this.ctx.storage.get<SessionNote>(`${SESSION_KEY}${runId}`);
  }

  /** A session whose conversation turned out to be gone, so none resumes it. */
  async forgetSession(runId: string): Promise<void> {
    await this.ctx.storage.delete(`${SESSION_KEY}${runId}`);
  }
}

/** Where {@link ClaudeCoordinatorWorkspace.noteSession} keeps a run's session. */
const SESSION_KEY = "claude-session:";

/** A run's Claude Code session, as this workspace records it. */
export interface SessionNote {
  sessionId: string;
  /** A plan this session filed a version of: a planning run's. */
  plan?: string;
  /** Which version: the sequence of the entry it filed on the plan's page. */
  version?: number;
}

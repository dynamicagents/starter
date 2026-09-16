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
} from "@dynamicagents/plugins/computer";
import { CLAUDE_CODE_SESSION } from "@/config";
import { INSTALL_PLAN } from "@/workspace/install-plan";
import { gitIdentity } from "@/workspace/git-identity";
import { claudeCodeConfig, CREDENTIALS_KEY } from "./claude-code";

/**
 * The claude-coder's workspace, bound as `CLAUDE_CODER_WORKSPACE`.
 *
 * Everything a workspace does is in `@dynamicagents/plugins/computer`,
 * shared with the coder. Two things are this agent's own, and both exist so that the container
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
 * That trust is installed by the workspace host in
 * `@dynamicagents/plugins/computer`, whose `ca-trust` module carries the
 * full reasoning — including why it cannot live in the image's entrypoint, where
 * Cloudflare's own recipe puts it. Changing this mode means reading it.
 */
export class ClaudeCoderWorkspaceDO extends WorkspaceObjectBase {
  /**
   * The credential pool's `{ index → resetAt }` map.
   *
   * **Per workspace, deliberately.** Every workspace draws the same subscription
   * buckets, so the strictly-correct home for this is one shared object that all
   * of them consult. That costs a Durable Object class, a binding, a migration
   * and an RPC on the rotation path; keeping it here costs one wasted `429` per
   * workspace per rotation, bounded by `max_instances`. At five instances that
   * is the cheaper trade by a wide margin — and if it ever stops being, the
   * `CredentialStore` seam is exactly where a shared object would plug in.
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
   * session. The facet does that, over RPC, through the workspace runtime.
   *
   * The workspace name thunk is unused on this path and would be wrong here
   * anyway: the name is resolved on the *parent*, from the verified caller, and
   * this object already knows which workspace it is by being it.
   */
  readonly #session = claudeCodeSession(
    claudeCodeConfig(this.env, () => this.ctx.id.toString())
  );

  protected workspaceConfig(): WorkspaceObjectConfig {
    return {
      binding: "CLAUDE_CODER_WORKSPACE",
      label: "claude-coder-workspace",
      installPlan: INSTALL_PLAN,
      // Above the whole session, not above one drain window.
      //
      // The base's default is twenty minutes, and its rule is that the window
      // must exceed the longest command the shell allows — measured from when
      // that command *starts*, because nothing touches the object again while it
      // runs. This agent's longest command is a `claude -p` session that stays
      // detached for its entire timeout, so twenty minutes would put the idle
      // alarm inside a live session.
      //
      // Chunk boundaries re-enter this object and `#touch()` roughly every
      // `windowMs`, which does hide it almost always — but "almost always" is
      // not what that rule promises, and one retried or delayed chunk is enough
      // to stop the container under a running session and lose both the work and
      // the cached prefix that bought it.
      //
      // Derived from the session timeout rather than written out, so raising one
      // moves the other. The margin covers the gap between a session ending and
      // the final chunk unwinding.
      containerIdleMs: CLAUDE_CODE_SESSION.timeoutMs + 5 * 60_000,
      egress: {
        mode: "http-gateway",
        gateway: this.#session.egress(this.#credentials)
      },
      // See the coder's workspace for why the binding is named, not read.
      git: { tokenBinding: "GITHUB_TOKEN", author: gitIdentity(this.env) }
    };
  }

  /**
   * Is any credential usable right now, and if not, when? Asked by the facet
   * before it starts a session — see `./subagent.ts`, which carries the reason.
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
   * The drain reports a reading only to the chunk that observed it, so this
   * cannot be a stale one from an earlier window — but a pool that rotated
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
      credentials: claudeCodeConfig(this.env, () => this.ctx.id.toString())
        .credentials,
      store: this.#credentials
    });
    // Whichever credential the gateway is handing out is the one this session's
    // requests carried, so it is the one the reading is about.
    const lead = await pool.lead();
    if (!lead.ok) return;
    await pool.spend(lead.id, resetAt);
    console.warn(
      "[claude-coder-workspace] retiring a credential on the " +
        "client's own bucket reading",
      {
        id: lead.id,
        resetAt: new Date(resetAt).toISOString(),
        status: info.status
      }
    );
  }
}

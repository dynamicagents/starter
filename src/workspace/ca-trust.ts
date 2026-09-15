import type { Workspace } from "@cloudflare/computer";

/**
 * Making a container able to speak TLS, once there is a CA to trust.
 *
 * Only `egress: { mode: "http-gateway" }` needs this, but it lives on every
 * workspace because the cost of getting it wrong is asymmetric: the trust
 * install against a container with no CA prints one line and exits 0, while a
 * container that missed it fails every later HTTPS connection with an error
 * that names no cause.
 */

/**
 * Install the egress interception CA, and say what was there to install.
 *
 * One shell string rather than a script in the image, because **the image cannot
 * run this at all**, and the reason is ordering rather than preference.
 * Cloudflare's own recipe assumes interception is declared as container
 * configuration, so the runtime mounts the CA before the container starts.
 * `@cloudflare/computer` uses the raw container API, where the only interception
 * hooks are methods called *after* `start()` — so an entrypoint runs strictly
 * before the CA can exist, finds nothing, and reports the container
 * un-intercepted while every later TLS connection fails.
 *
 * The listing comes first and runs unconditionally: when the CA is missing,
 * *what else is in that directory* is the only evidence distinguishing "mounted
 * somewhere else" from "never provisioned", and it costs one line.
 */
export const TRUST_CA_COMMAND = [
  'ls -A /etc/cloudflare/certs 2>&1 || echo "(no /etc/cloudflare/certs)"',
  "CA=/etc/cloudflare/certs/cloudflare-containers-ca.crt",
  'if [ -r "$CA" ]; then',
  // Trailing operators, not leading ones: a newline ends a command in sh, so an
  // `&&` opening the next line is a syntax error rather than a continuation.
  '  install -m 644 "$CA" /usr/local/share/ca-certificates/cloudflare-containers-ca.crt &&',
  "  update-ca-certificates > /dev/null 2>&1 &&",
  '  echo TRUSTED || echo "TRUST FAILED"',
  "else",
  '  echo "NO CA AT $CA"',
  "fi"
].join("\n");

/** How long the trust install may take before it is not going to happen. */
const TRUST_TIMEOUT_MS = 30_000;

export interface ContainerTrustDeps {
  workspace: () => Workspace;
  /** The runtime's own container handle, for the exit this has to hear about. */
  container: () => Container | undefined;
  /** Log prefix and object id, for the one line an operator can see. */
  tag: () => string;
  id: () => string;
}

/**
 * Whether the container this object is talking to has had the CA installed.
 *
 * ## Why the answer is in memory
 *
 * What it describes is a *container*, which does not outlive the isolate in any
 * way worth persisting. A stored `true` would be the exact bug this exists to
 * prevent — a flag surviving the container it describes, and vouching for its
 * replacement.
 *
 * It is wrong only in the safe direction. An isolate that lost it re-runs an
 * idempotent `install -m 644`.
 *
 * ## What clears it
 *
 * **The container's own exit**, watched through `monitor()`. This is the signal
 * that does not depend on anyone noticing: a container replaced underneath a
 * running command — by a reconnect, a relaunch, a crash — exits, and the watch
 * fires whoever caused it. Nothing else here is in a position to know, because
 * most commands run through the stub this object hands out and report their
 * failures to their own caller, not to it.
 *
 * The watch lives in memory beside the flag it clears, which is the right
 * lifetime: an isolate that loses one loses the other, and the replacement
 * starts out untrusted. It is deliberately not held open with `waitUntil` —
 * that would keep an invocation alive for the life of the container.
 *
 * A container seen not running, and a command reporting `EEXEC_LOST`, both call
 * {@link forget} as well. They are cheap, they are strictly earlier in some
 * orderings, and neither is load-bearing on its own.
 */
export class ContainerTrust {
  #trusted = false;

  /** Whether an exit watch is standing for the container now running. */
  #watching = false;

  constructor(private readonly deps: ContainerTrustDeps) {}

  /** Forget that any container was trusted. */
  forget(): void {
    this.#trusted = false;
  }

  /**
   * Watch this container's exit, so its replacement is not trusted on its
   * behalf.
   *
   * Re-armed rather than kept: the promise settles once, for the container it
   * was taken from, so the next {@link ensure} takes a fresh one for whatever is
   * running then.
   *
   * A rejection is an exit too — the runtime reporting the container went away
   * badly — so both settlements clear the flag, and neither is allowed to
   * surface as an unhandled rejection.
   */
  #watch(): void {
    if (this.#watching) return;
    const container = this.deps.container();
    if (!container) return;
    try {
      const done = (): void => {
        this.#watching = false;
        this.forget();
      };
      container.monitor().then(done, done);
      this.#watching = true;
    } catch (err) {
      // No watch, so the flag keeps its other two ways of being cleared. Worth a
      // line because it silently widens the window this class exists to close.
      console.warn(`[${this.deps.tag()}] could not watch the container`, {
        id: this.deps.id(),
        err: String(err)
      });
    }
  }

  /**
   * Trust the CA if this container has not been trusted yet.
   *
   * Called from the workspace's `ready()` path, which is the earliest point that
   * is not too early: the backend's `connect()` has completed, so start and
   * interception have both happened.
   *
   * **Never throws.** A workspace that cannot trust the CA still has a checkout,
   * a shell and a git history, and whatever runs next will say plainly what went
   * wrong — refusing to proceed here would replace a legible TLS error with an
   * opaque one.
   */
  async ensure(): Promise<void> {
    this.#watch();
    if (this.#trusted) return;
    try {
      using handle = await this.deps
        .workspace()
        .runtime.exec(TRUST_CA_COMMAND, {
          cwd: "/",
          encoding: "utf8",
          timeoutMs: TRUST_TIMEOUT_MS
        });
      const result = await handle.result();
      /**
       * Marked on a command that *ran*, not on one that found a CA.
       *
       * The command exits 0 either way — it prints `NO CA AT …` when there is
       * nothing to install — and that case is not worth retrying within a
       * container: interception is configured by the `connect()` already
       * awaited, so a CA absent now stays absent until the container is
       * replaced. Retrying on every call would buy nothing and cost a round trip
       * on the object's hottest path.
       *
       * A throw leaves this false, so an unreachable container is tried again.
       */
      this.#trusted = true;
      // Logged at info once per container, deliberately. The container's own
      // stdout does not reach Workers Observability, so this line is the only
      // place an operator can see whether the container can speak TLS at all —
      // and its absence is itself the answer when a workspace never got this far.
      //
      // Once per container rather than per call is also what makes it readable:
      // on the busiest entry point in the object, a line per call would bury the
      // one that matters under thousands that say the same thing.
      console.info(`[${this.deps.tag()}] container TLS trust`, {
        id: this.deps.id(),
        exitCode: result.exitCode,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
      });
    } catch (err) {
      console.warn(`[${this.deps.tag()}] could not trust the interception CA`, {
        id: this.deps.id(),
        err: String(err)
      });
    }
  }
}

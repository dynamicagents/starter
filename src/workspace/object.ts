import { DurableObject, tracing } from "cloudflare:workers";
// One Durable Object has one alarm, and this object wakes for more reasons than
// that. A `Scheduler` is the multiplexer; what it does *not* own is what this
// object owes on waking, which is the callbacks registered on it below.
import {
  installScheduler,
  namedDeadline,
  type Deadline
} from "@dynamicagents/core/alarm";
// The sibling barrel: the scheduler owns *when* this object wakes, `JobLifecycle`
// owns what the install owes on waking.
import { JobLifecycle, type JobContext } from "@dynamicagents/core/job";
import {
  Workspace,
  type DurableObjectStorageLike,
  type SyncRetryIntent,
  type SyncRetryScheduler,
  type WorkspaceEgressPolicy,
  type WorkspaceOptions,
  type WorkspaceRuntimeExecHandle,
  type WorkspaceStub
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer
} from "@cloudflare/computer/backends/container";
import {
  createGitClient,
  type AuthCallback,
  type GitClient
} from "@cloudflare/computer/git";
import { createCloudflareObserver } from "@cloudflare/computer/observe/cloudflare";
import {
  deriveAdvisories,
  installFingerprint,
  pathExists,
  resolveInstallCommand,
  truncateOutput,
  type InstallPlan,
  type InstallProbe,
  type InstallState,
  type WorkspaceAdvisory
} from "@dynamicagents/plugins/computer";
// The shape `/repo` already defines for exactly this: a git failure is data,
// because it means git answered. A throw on this path means the object was
// unreachable, which is a different thing and must stay distinguishable.
import type { RepoGitResult } from "@dynamicagents/plugins/repo";

/**
 * A workspace: one Durable Object, one container, one repository.
 *
 * **Shared by every agent in this Worker that has a container**, which today is
 * `coder` and `claude-coder`. Each subclasses {@link WorkspaceObjectBase},
 * supplies a {@link WorkspaceObjectConfig}, and inherits everything else. Keep
 * that seam narrow: it is the complete answer to "what is different about this
 * agent's container", and the alternative is a second copy of this file
 * drifting in whichever direction the object nobody redeployed recently went.
 *
 * It lives in `src/workspace/` rather than in either agent's directory because
 * `verify:isolation` fails an agent that imports a sibling's module: the
 * sibling's plugins come with it. Anything two agents share belongs here or at
 * the top level, never inside one of them.
 *
 * `@cloudflare/computer` pairs a SQLite-backed virtual filesystem in *this*
 * object's storage with a container running `computerd`, which mounts it over
 * FUSE at `/workspace`. Commands run against the same tree the Worker reads over
 * RPC, and the tree outlives the container — which is why this replaced
 * `@cloudflare/sandbox`, whose disk died with the container and whose R2
 * snapshot path needed S3 credentials a Workers binding cannot supply.
 *
 * **One repository per object**, because `computer` is strictly 1 DO ↔ 1
 * container: the id derives from caller *and* repository (see `workspaceName`),
 * so two repositories for one caller are two objects and two containers.
 *
 * **It constructs `Workspace` rather than using `withWorkspace`.** The mixin
 * stores the `Workspace` under a module-private symbol the package does not
 * export, so a method on the object cannot reach it — and two things the host is
 * required to do live there and are absent from the `WorkspaceClient` it hands
 * back: `retryPendingSync` (the library "does not own your DO's alarm") and the
 * direct `runtime` access the detached install needs. So this object owns the
 * `Workspace` and implements the one method the mixin otherwise provides,
 * `__getWorkspaceStub`. Callers outside see no difference.
 *
 * ## The rule the install guards all serve
 *
 * `running` is the one install state that **blocks work**: `sb_exec` waits on it
 * and then refuses to run. Every other state is a fact the subagent can act on.
 * So a `running` record must never outlive the command it describes, and the
 * ways it can are not all reachable from one place — the spawn can fail before a
 * drain is attached, a drain can be cut short by an eviction, `getExec` can hand
 * back a handle to a container that never answers, and two installs can displace
 * each other. Each guard below names the one it closes; the staleness bound in
 * `#installState` is the proof that covers the rest.
 */

/** Where every checkout lives, inside the container and in the VFS. */
export const WORKSPACE_DIR = "/workspace";

/**
 * The Durable Object name for one caller's checkout of one repository.
 *
 * Exported because several places must agree on it and none can see the others:
 * the plugin that resolves the stub, the agent that hands it down to subagents,
 * and the cancellation path. A pipe rather than a slash, so the caller half
 * cannot forge a repository boundary by containing one.
 *
 * `repo` is undefined only before the first `repo_clone` or `scratch_open` of a
 * session — what a task works in is model-chosen, so there is genuinely nothing
 * to key on until it has chosen. That window resolves to a caller-level
 * workspace, which is never worked in: `beforeCheckout` sets the repository
 * before any git runs, and `scratch_open` sets its sentinel before anything
 * resolves a name.
 *
 * `repo` is not always a repository. `SCRATCH_REPO` in `./scratch.ts` passes
 * through here as one, which is what keys a scratchpad to its own object and its
 * own container — see that file for why a scratchpad is modelled as a repository
 * whose remote is nowhere.
 */
export function workspaceName(callerKey: string, repo?: string): string {
  return repo ? `${callerKey}|${repo}` : `${callerKey}|<unassigned>`;
}

// --- where the work is ------------------------------------------------------

/**
 * The key the checkout record lives under.
 *
 * Deliberately **not** derived from {@link INSTALL_KEY}: what is on disk and what
 * was installed into it have different lifetimes, and one record cannot answer
 * both. See {@link WorkspaceObjectBase.noteCheckout}.
 */
const CHECKOUT_KEY = "checkout";

/**
 * What is checked out here, recorded by whoever put it there.
 *
 * `kind` is the one field worth arguing for. A scratchpad and a clone are the
 * same shape on disk — a directory with a `.git` in it — and every reader of this
 * record wants the same answer from both. What differs is what may be *said*
 * about them: a scratchpad has no remote, so "nothing was pushed" is a fact
 * rather than a failure. `repo` being absent for one would make that inferrable,
 * but an identity inferred from a missing field is a second meaning for a field
 * that already has one.
 */
interface CheckoutRecord {
  dir: string;
  /** `owner/repo`, absent for a scratchpad. */
  repo?: string;
  kind: "repo" | "scratch";
  at: number;
}

// --- what this object wakes for, and when ----------------------------------

/**
 * The install's job id, which is also the key its state record lives under.
 *
 * Every other key is derived from it by `JobLifecycle`: `install:armed`,
 * `install:last-armed`, `install:context`, and the wake intents `install-run`
 * and `install-watch`. Changing this value renames all of them, which is a
 * storage migration — the specs that read these keys directly would fail first.
 */
const INSTALL_KEY = "install";

/**
 * How long after arming an install before arming another.
 *
 * The bound on a *failing* install. A successful one is self-limiting — it ends
 * `done` with the container up, so `container.running` short-circuits every
 * later call — but a failure lands back on `failed` with the container still
 * down, and `__getWorkspaceStub` is the busiest entry point in the object, so
 * it would re-arm on essentially every tool call. Five minutes is far longer
 * than an install (88s measured), so a broken container retries at roughly the
 * rate a human would and a later task still gets a fresh attempt.
 */
const INSTALL_ARM_COOLDOWN_MS = 5 * 60_000;

/** How often the watchdog checks on a running install. */
const INSTALL_WATCH_MS = 60_000;

/**
 * How far past its own timeout a `running` install is still given the benefit of
 * the doubt. Generous on purpose: declaring a live install dead costs a
 * duplicate `npm ci`, and the margin only has to cover the slack between the
 * runtime killing a command and this object hearing about it.
 */
const INSTALL_STALE_MS = 5 * 60_000;

/**
 * What the install records about itself, alongside the state record.
 *
 * `startedAt` is core's, and it is the generation marker: a drain compares the
 * stamp it captured against the stamp on disk, and a mismatch means it has been
 * superseded. The rest is this install's own — `dir` because a cold container
 * has no caller to ask, `repo` so a repository with an `INSTALL_PLAN` override
 * resolves the same command the second time, `fingerprint` for the skip
 * condition, and `command` so a re-attach can name what it is waiting on.
 */
interface InstallContext extends JobContext {
  dir: string;
  repo?: string;
  fingerprint: string | null;
  command: string;
}

/**
 * Where the idle-reclaim deadline keeps its current schedule id.
 *
 * A schedule is a row the scheduler mints an id for, not a keyed upsert — so
 * "push this deadline back", which `#touch()` does on every single call into
 * this object, is cancel-then-set and needs the id of what stands now. See
 * `namedDeadline`.
 */
const IDLE_RECLAIM_ID = "idle-reclaim-id";

/**
 * How long a workspace survives without being used.
 *
 * A Durable Object is **never** reclaimed by the platform, and a namespace
 * cannot be enumerated from a Worker, so nothing else is coming to clean up.
 * Source-only workspaces are small (6.3 MB for slack-gatekeeper), which makes
 * this hygiene rather than cost control — but unbounded hygiene is still
 * unbounded.
 */
const IDLE_RECLAIM_MS = 7 * 24 * 60 * 60 * 1000;

/** Where the container-idle deadline keeps its current schedule id. */
const CONTAINER_IDLE_ID = "container-idle-id";

/**
 * How long a container stays up after the last command **started**.
 *
 * Ours to schedule: `withWorkspaceContainer` wraps the runtime's raw
 * `ctx.container`, not `@cloudflare/containers`' `Container`, so there is no
 * `sleepAfter` to lean on.
 *
 * **This must exceed the longest command the agent allows**, and breaking that
 * kills work in flight. Measured from when a command *starts*: `#touch()` arms
 * the clock on the way into this object, and a running command touches nothing
 * again until it finishes — `handle.result()` is one long await and the FUSE
 * traffic under it never surfaces as an RPC. Set equal to the computer plugin's
 * `DEFAULT_TIMEOUT_MS`, the two timers race and whichever fires first destroys
 * the container the other depends on. Twenty minutes is double that ceiling;
 * raise it, never lower it, if `sb_exec` is given a longer timeout.
 *
 * **The default, not the policy.** "Longest command" is a fact about the agent,
 * so one whose commands run longer must say so via
 * {@link WorkspaceObjectConfig.containerIdleMs} — `claude-coder` holds a
 * `claude -p` session open for its whole 40-minute timeout.
 */
const CONTAINER_IDLE_MS = 20 * 60_000;

/**
 * Refuse to grow past this, of the 10 GB a Durable Object may hold.
 *
 * Source-only workspaces run at ~6 MB, so this should never fire — which is why
 * it is worth having: if something does start pulling a large tree in, a
 * sentence naming the number beats a write failing somewhere unrelated.
 */
const STORAGE_CAP_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * Install the egress interception CA, and say what was there to install.
 *
 * One shell string rather than a script in the image, because the image cannot
 * run this at all — see `#trustInterceptionCa` on {@link WorkspaceObjectBase},
 * which carries the ordering constraint that puts it there. (Named as text: a
 * `#private` member has no qualified name for `{@link}` to resolve.) The
 * listing comes first and runs unconditionally: when the CA is missing, *what
 * else is in that directory* is the only evidence distinguishing "mounted
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

/**
 * How long a `node_modules` probe is reused before it is asked again.
 *
 * The probe is a container round-trip and its answer only qualifies an advisory
 * that is reported either way, so it is worth much less than it costs on a path
 * that now runs before every tool call. Short enough that an install the
 * subagent ran by hand is reflected within a turn or two.
 */
const TREE_PROBE_TTL_MS = 30_000;

/**
 * The exec id an install runs under.
 *
 * Fixed rather than generated, because the point is to find it again: an
 * isolate that dies mid-drain leaves the command running in the container, and
 * `getExec(id, { resume: "tail" })` is how the next invocation re-attaches
 * instead of starting a second `npm ci` alongside the first.
 */
const INSTALL_EXEC_ID = "dependency-install";

/**
 * Every reason this object wakes, as one map.
 *
 * Written out rather than inferred because two things type against it: the
 * scheduler that registers the callbacks, and the `JobLifecycle` that schedules
 * two of them by name. A name that exists in one and not the other is then a
 * compile error rather than a schedule that is rejected at runtime.
 */
// A `type`, not an `interface`: the scheduler constrains its handler map to a
// `Record<string, …>`, and only a type alias carries the implicit index
// signature that satisfies. An interface here fails with a message that names
// neither cause nor cure.
type WorkspaceWakeHandlers = {
  installRun: () => Promise<void>;
  installWatch: () => Promise<void>;
  idleReclaim: () => Promise<void>;
  containerIdle: () => Promise<void>;
  syncRetry: (payload: SyncRetryIntent) => Promise<void>;
};

/** Where one backend's pending-pull deadline keeps its schedule id. */
const syncRetryIdKey = (backend: string): string => `sync-retry-id:${backend}`;

/**
 * The library's persistence hook, over one deadline per backend.
 *
 * `Workspace` calls this itself: `schedule` after a post-command pull fails,
 * `clear` after one finally succeeds. All this side owns is where the intent
 * lives and when the object wakes to act on it.
 *
 * The whole intent rides in the schedule's **payload** rather than being
 * reconstructed from the row. A schedule stores its time in seconds, so reading
 * `notBefore` back off the row would return a truncated version of what the
 * library wrote — and the library compares that value to its own backoff
 * arithmetic. Carrying it in the payload makes the round trip exact and keeps
 * `attempt`, which a schedule row has nowhere to put at all.
 */
function syncRetryScheduler(
  deadlineFor: (backend: string) => Deadline<SyncRetryIntent>
): SyncRetryScheduler {
  return {
    async get(backend: string): Promise<SyncRetryIntent | undefined> {
      return (await deadlineFor(backend).get())?.payload;
    },
    async schedule(intent: SyncRetryIntent): Promise<void> {
      await deadlineFor(intent.backend).set(new Date(intent.notBefore), intent);
    },
    async clear(backend: string): Promise<void> {
      await deadlineFor(backend).clear();
    }
  };
}

// --- the object -------------------------------------------------------------

/**
 * The container half.
 *
 * `withWorkspaceContainer` adds one method, `getWorkspaceContainer()`, over
 * `this.ctx.container` — the runtime's own container handle. There is no
 * `@cloudflare/containers` `Container` subclass here and so no `sleepAfter`:
 * idle shutdown is this object's job, and it lands on the wake map with
 * everything else.
 */
const WorkspaceContainerBase = withWorkspaceContainer(
  class extends DurableObject<Env> {}
);

/**
 * The three things one workspace object does not share with the other.
 *
 * Everything else about a workspace is identical between agents, which is why
 * this interface is short and why it is worth having at all: a seam this narrow
 * makes "what is different about this agent's container" a question with a
 * complete answer in one place.
 */
export interface WorkspaceObjectConfig {
  /**
   * The wrangler Durable Object binding this class is bound as.
   *
   * Not cosmetic and not derivable: `computerd` dials **back** through it. The
   * backend builds the container's loopback from this name plus the object id,
   * so a wrong one produces a container that starts, mounts nothing and fails
   * at the first command with no mention of a binding.
   */
  binding: string;
  /**
   * Where this workspace's container may send traffic, and through what.
   *
   * `direct` is the plain behaviour: the container's own network position.
   * `http-gateway` routes **everything** through a `Fetcher` this Worker
   * supplies, which is what puts the Worker on the model path — see
   * `@dynamicagents/plugins/claude-code`.
   *
   * **Required in practice, and its absence is silent.** `@cloudflare/computer`
   * 0.2.0 made this a policy defaulting to `{ mode: "none" }`, and the backend
   * derives the container's network flag from it. Omit it and the container
   * comes up with no network at all: the workspace mounts, commands run, and
   * the install dies on a registry it cannot reach with nothing naming egress
   * as the cause.
   */
  egress: WorkspaceEgressPolicy;
  /** How this deployment installs dependencies for this agent's checkouts. */
  installPlan: InstallPlan;
  /** Log prefix — `coder-workspace`, `claude-coder-workspace`. */
  label: string;
  /**
   * How long this agent's container stays up after the last command **started**.
   *
   * A per-agent value because the invariant on {@link CONTAINER_IDLE_MS} — it
   * must exceed the longest command the shell allows — is an invariant about the
   * *agent*, and the two differ by a factor of four. The coder's longest command
   * is a tool call; `claude-coder`'s is a whole `claude -p` session that runs
   * detached for its entire timeout.
   *
   * Omit it for the default. Raise it, never lower it, and raise it whenever the
   * agent's longest command grows.
   */
  containerIdleMs?: number;
}

/**
 * One caller's checkout of one repository, and the container that mounts it.
 *
 * Abstract because a Durable Object class takes no constructor arguments, so
 * per-agent configuration cannot arrive that way. {@link workspaceConfig} is the
 * seam, and it is the shape core's own `RecipeSubagentBase.subagentRuntime`
 * uses for exactly the same reason.
 *
 * ## Why `backend` and `#workspace` are lazy
 *
 * **Base class fields run before subclass fields**, so as plain fields they
 * would read `undefined` from any `workspaceConfig()` that touches a subclass
 * field — which `ClaudeCoderWorkspaceDO`'s does, for its credential store.
 * Memoised getters remove the hazard rather than documenting it, which is what
 * lets a subclass implement the seam however it likes.
 */
export abstract class WorkspaceObjectBase extends WorkspaceContainerBase {
  /**
   * Everything this agent's workspace does differently. Called once, lazily.
   *
   * Read through {@link #cfg}, never directly: an implementation may build
   * something real — `claude-coder`'s constructs its egress gateway — and this
   * is consulted on the busiest path in the object.
   */
  protected abstract workspaceConfig(): WorkspaceObjectConfig;

  #configMemo?: WorkspaceObjectConfig;

  get #cfg(): WorkspaceObjectConfig {
    return (this.#configMemo ??= this.workspaceConfig());
  }

  /** This object's log prefix, so two workspaces stay tellable apart. */
  get #tag(): string {
    return this.#cfg.label;
  }

  /**
   * How long an install may run before it is killed.
   *
   * Read from the plan in three places, which is why it is a getter: the
   * fallback has to be the same number in all three, and a `??` repeated three
   * times is three chances to write a different one.
   */
  /** This agent's container-idle window — see {@link WorkspaceObjectConfig}. */
  get #containerIdleMs(): number {
    return this.#cfg.containerIdleMs ?? CONTAINER_IDLE_MS;
  }

  get #installTimeoutMs(): number {
    return this.#cfg.installPlan.timeoutMs ?? 20 * 60_000;
  }

  /**
   * The one alarm, multiplexed across every reason this object wakes.
   *
   * A callback is registered under a **name**, and a schedule row persists that
   * name rather than a closure: the object is re-created on every wake, so
   * anything captured here would not survive one. Registration therefore happens
   * unconditionally, in a field initializer, every time.
   *
   * `hostOwns` is the acknowledgement that this class defines `alarm()` and
   * `fetch()` itself. A lifecycle installs its handlers only where the host has
   * none, so without saying so here the scheduler would be installed and never
   * fire, with no error anywhere. `alarm()` below calls through, which is what
   * makes the declaration true. **`fetch()` deliberately does not** — it serves
   * `computerd`'s capnweb WebSocket upgrade, and a lifecycle's `fetch` declines
   * any upgrade no installed capability claims.
   */
  readonly #wake = installScheduler<WorkspaceWakeHandlers>(this, {
    hostOwns: ["alarm", "fetch"],
    callbacks: {
      installRun: () => this.#onInstallRun(),
      installWatch: () => this.#onInstallWatch(),
      idleReclaim: () => this.#onIdleReclaim(),
      containerIdle: () => this.#onContainerIdle(),
      syncRetry: (payload: SyncRetryIntent) =>
        this.#onSyncRetry(payload.backend)
    },
    onError: (err: unknown) => {
      console.error(`[${this.#tag}] a scheduled callback failed for good`, {
        id: this.ctx.id.toString(),
        err: String(err)
      });
    }
  });

  /** Reclaim a workspace nobody has touched. Moved forward by every `#touch`. */
  readonly #idleReclaim = namedDeadline({
    storage: this.ctx.storage,
    scheduler: this.#wake.scheduler,
    key: IDLE_RECLAIM_ID,
    callback: "idleReclaim"
  });

  /** Stop a container nobody is using. Moved forward by every `#touch`. */
  readonly #containerIdle = namedDeadline({
    storage: this.ctx.storage,
    scheduler: this.#wake.scheduler,
    key: CONTAINER_IDLE_ID,
    callback: "containerIdle"
  });

  /** One pending-pull deadline per backend, keyed by backend name. */
  #syncRetryDeadline(backend: string): Deadline<SyncRetryIntent> {
    return namedDeadline({
      storage: this.ctx.storage,
      scheduler: this.#wake.scheduler,
      key: syncRetryIdKey(backend),
      callback: "syncRetry"
    });
  }

  /**
   * The dependency install, as a job this object owns through its alarm.
   *
   * `JobLifecycle` is core's, and what it owns is the choreography that is wrong
   * in the same four ways every time: arming before anything runs, one job at a
   * time under a staleness bound, a drain that can outlive its job, and a job
   * nobody is draining. The three timings below are this install's. The **drain
   * loop stays here**, because an install runs to completion and writes a single
   * verdict rather than reporting progress between bounded windows.
   *
   * **The alarm runs the install, and that is not a detail.** An install takes
   * ~85 seconds and must not be owned by the request that noticed it was needed
   * — a drain handed to `ctx.waitUntil` from a gate poll that returns in
   * milliseconds is disposed mid-`npm ci`. An alarm invocation belongs to the
   * object rather than to any caller, so nothing it awaits can be cut short by a
   * response being sent.
   *
   * **Arming writes `running` before anything is running**, which holds the gate
   * shut in the moments before the alarm fires. The alarm then presents the stamp
   * arming wrote to `claim`, which recognises its own placeholder and nothing
   * else — taking over any `running` record instead would be displacement again.
   */
  readonly #install = new JobLifecycle<
    { command: string },
    InstallContext,
    WorkspaceWakeHandlers
  >({
    id: INSTALL_KEY,
    storage: this.ctx.storage,
    scheduler: this.#wake.scheduler,
    run: "installRun",
    watch: "installWatch",
    staleMs: INSTALL_STALE_MS,
    watchMs: INSTALL_WATCH_MS,
    armCooldownMs: INSTALL_ARM_COOLDOWN_MS
  });

  /**
   * The container backend.
   *
   * `container: () => this` hands the backend this object's own container.
   * `workspace` is how `computerd` dials *back* in: the runtime builds a loopback
   * binding from the exported `WorkspaceProxy` class and these two values, which
   * is why `src/index.ts` re-exports it and why dropping that export breaks the
   * container with no compile error.
   *
   * Nothing sets `egressHost`; the default `computer.internal` is the host the
   * container's outbound HTTP is intercepted on, internal to that loopback.
   *
   * The binding name and the egress policy are the subclass's — see
   * {@link WorkspaceObjectConfig}, which carries the warnings that used to live
   * on this comment.
   */
  #backendMemo?: CloudflareContainerBackend;

  get backend(): CloudflareContainerBackend {
    return (this.#backendMemo ??= new CloudflareContainerBackend({
      container: () => this,
      workspace: {
        binding: this.#cfg.binding,
        id: this.ctx.id.toString()
      },
      egress: this.#cfg.egress
    }));
  }

  #workspaceMemo?: Workspace;

  get #workspace(): Workspace {
    return (this.#workspaceMemo ??= new Workspace(this.#workspaceOptions()));
  }

  /**
   * Whether the container this object is talking to has had the CA installed.
   *
   * In memory, and that is correct rather than lazy: what it describes is a
   * *container*, which does not outlive the isolate in any way worth persisting.
   * A stored `true` would be the exact bug this is here to prevent — a flag
   * surviving the container it describes, and vouching for its replacement.
   *
   * Wrong only in the safe direction. An isolate that lost it re-runs an
   * idempotent `install -m 644`; an isolate that kept it across a container
   * replacement is corrected by `#ready` below, which clears it the moment it
   * sees a container that is not running.
   */
  #caTrusted = false;

  /**
   * Set once {@link reclaimIfIdle} has emptied storage, for the few microtasks
   * before the isolate resets. Anything still running on this instance then is
   * describing storage that is gone, and failing because of it is expected.
   */
  #reclaimed = false;

  /**
   * Open the workspace, and make sure the container behind it can speak TLS.
   *
   * **Every path that might start a container goes through here**, which is the
   * fix for a real gap rather than tidiness. The CA install used to hang off
   * `#beginInstall`, so it reached a container only when that container was also
   * due a dependency install — and the two are not the same question:
   *
   * - `#armInstallIfCold` deliberately declines to arm for a `skipped` or `idle`
   *   install state. A repository with nothing to install therefore replaced its
   *   container, ran every later command against an untrusted CA, and had no
   *   install pending to fix it.
   * - `#beginInstall` returns early when an install is already in flight, and
   *   again when the workspace is full — both *before* the old call site. The
   *   full-workspace case is the worst of them: egress is exactly what the agent
   *   needs to dig itself out.
   *
   * Tied to container liveness instead. `ctx.container?.running` is read
   * **before** `ready()`, because `ready()` is what starts a stopped container —
   * afterwards every container looks running and the distinction is gone. That
   * is the same signal `#armInstallIfCold` turns on, for the same reason.
   *
   * Cheap enough to sit on the busiest entry point in the object: at most one
   * extra exec per isolate, plus one per cold container. A warm container costs
   * a boolean.
   *
   * Private, like everything else in here that is not an RPC. On a Durable
   * Object `protected` is a typechecker's opinion and not a runtime boundary —
   * every non-`#` method is reachable over RPC — so a helper that starts
   * containers is spelled `#`.
   */
  async #ready(): Promise<void> {
    if (!this.ctx.container?.running) this.#caTrusted = false;
    await this.#workspace.ready();
    if (!this.#caTrusted) await this.#trustInterceptionCa();
  }

  #workspaceOptions(): WorkspaceOptions {
    return {
      // `ctx.storage.sql.exec` returns a narrower row type than
      // `DurableObjectStorageLike` declares and the two are invariant, so the
      // cast goes through `unknown`. The runtime shapes match; this is the
      // pattern the package's own example uses.
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
      backends: [this.backend],
      // Required, not optional. Without it a post-command pull that fails has
      // nowhere to record itself and nothing to resume it, and the container
      // keeps edits the workspace never sees.
      retryScheduler: syncRetryScheduler((backend) =>
        this.#syncRetryDeadline(backend)
      ),
      // One span per sync push, sync pull, exec spawn and filesystem op, into
      // the same Workers Observability view the rest of this Worker traces to.
      // Needs `observability.traces.enabled` in wrangler.jsonc; without the
      // feature flag `tracing` is undefined and this degrades to a no-op.
      observer: createCloudflareObserver({ tracing }),
      // Git, running **here** rather than in the container.
      //
      // This is what lets the forge token stay on this side of the boundary.
      // `createGitClient` binds isomorphic-git to `provider()` — the local
      // SQLite store, not the wire — so a clone, fetch or push executes next to
      // the data it writes, and the container never holds a credential at all.
      // The alternative it replaces ran credentialed `git` in the container and
      // had to build a disposable git dir per operation to survive the fact that
      // git executes whatever `.git/config` and `.git/hooks` name.
      //
      // Needs `@platformatic/vfs`, an optional peer of `@cloudflare/computer`:
      // the adapter that wraps `provider()` into an isomorphic-git FsClient
      // imports it lazily and throws a named error when it is absent.
      git: createGitClient(),
      // Only the commit-producing subcommands read this, and the three
      // operations driven from here — clone, fetch, push — are not among them.
      // Set anyway so that a `pull` or `merge` added later fails on the merge
      // itself rather than on `MissingIdentityError`, and set to the same pair
      // `/repo` writes into the checkout's own config at clone time (see
      // `author` in each agent's `plugins.ts`), so a commit cannot be
      // attributed differently depending on which side made it.
      defaultGitIdentity: {
        name: this.env.GITHUB_NAME || "da-coder",
        email: this.env.GITHUB_EMAIL
      }
    };
  }

  /**
   * Repair a lost alarm on the way in.
   *
   * The one failure a scheduler cannot defend against from the inside: the
   * runtime retries a throwing `alarm()` a bounded number of times and then
   * stops for good, and a deleted-class migration takes the alarm with the
   * storage. Both leave schedule rows due with nothing coming for them, and the
   * symptom is silence.
   *
   * So every RPC into this object checks. That fully covers `sync-retry`,
   * `install-watch` and `container-idle`, which only matter while somebody is
   * using the workspace. It does **not** cover `idle-reclaim`, which by
   * definition fires when nobody is — that one has the agent's weekly cron
   * poking `reclaimIfIdle` as its backstop.
   */
  async #repairAlarm(): Promise<void> {
    try {
      await this.#wake.start();
      await this.#wake.rearm();
    } catch (err) {
      console.error(`[${this.#tag}] could not repair the alarm`, {
        id: this.ctx.id.toString(),
        err: String(err)
      });
    }
  }

  /**
   * What `getWorkspace(stub)` calls from outside this object.
   *
   * The one piece of `withWorkspace` reimplemented here — see the file comment
   * for why the mixin is not used. `ready()` first, because the stub is only
   * meaningful once the workspace has opened its store.
   */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    // The busiest entry point by far, and therefore the one that keeps both the
    // idle clock and the alarm honest.
    await this.#touch();
    await this.#repairAlarm();
    await this.#armInstallIfCold();
    await this.#ready();
    return this.#workspace.stub();
  }

  /**
   * Clone, fetch and push — the three operations that need the forge token.
   *
   * They live here rather than on the `WorkspaceStub` the plugin already holds
   * because `WorkspaceGitStub` exposes only `cli(argv)` across a Durable Object
   * boundary, and argv cannot carry an `onAuth` callback. Routed through here,
   * the credential is read from *this* object's `env` and never crosses an RPC
   * boundary, never appears in an argument list, and never enters the container.
   *
   * That last clause is the point, and it is why running credentialed `git` in
   * the container is not an option however carefully it is sandboxed: git
   * executes whatever `.git/config` and `.git/hooks` name, the model has a root
   * shell on that filesystem, and even a disposable git dir leaves the token
   * readable through `/proc` for the life of the process. isomorphic-git runs
   * here and has no hooks, no `ext::` transport, no template directory and no
   * credential helpers.
   *
   * Each takes `url` explicitly rather than a remote name: resolving `origin`
   * would read `.git/config`, a workspace file a co-installed shell tool can
   * write.
   */
  async gitClone(req: {
    url: string;
    dir: string;
    allowedHosts: string[];
    branch?: string;
    depth?: number;
  }): Promise<RepoGitResult> {
    return this.#git(req.allowedHosts, async (git, onAuth) => {
      // Spelled out rather than `git.clone`, and the reason is the credential.
      //
      // `clone` is the one network operation the client does not give an
      // `onAuth` callback — it authenticates only through a `headers` option,
      // which means attaching the token to the very first request to a URL the
      // *model* chose. Composing the same work out of `fetch` puts every
      // credentialed request on this side of `onAuth` instead, where the host is
      // checked at the moment the token would be handed over. The cost is four
      // calls instead of one; `clone` is these four.
      await git.init({ dir: req.dir });
      await git.remoteAdd({
        dir: req.dir,
        name: "origin",
        url: req.url,
        force: true
      });
      const fetched = await git.fetch({
        url: req.url,
        dir: req.dir,
        onAuth,
        // `depth: 0` means full history to isomorphic-git, so a caller that
        // asked for nothing gets the shallow default rather than the whole repo.
        depth: req.depth ?? 1,
        singleBranch: true,
        tags: false,
        ...(req.branch ? { ref: req.branch } : {})
      });
      const landed =
        req.branch ?? fetched.defaultBranch?.replace(/^refs\/heads\//, "");
      if (!landed)
        throw new Error(
          `cloned ${req.url} but the remote named no default branch to check out`
        );
      await git.checkout({ dir: req.dir, ref: landed });
      // What a real `git clone` writes and the container's git will look for:
      // without it the branch tracks nothing, and a subagent reaching for a bare
      // `git status` in the shell sees a branch with no upstream.
      await git.configSet({
        dir: req.dir,
        path: `branch.${landed}.remote`,
        value: "origin"
      });
      await git.configSet({
        dir: req.dir,
        path: `branch.${landed}.merge`,
        value: `refs/heads/${landed}`
      });
      return landed;
    });
  }

  async gitFetch(req: {
    url: string;
    dir: string;
    allowedHosts: string[];
    depth?: number;
  }): Promise<RepoGitResult> {
    return this.#git(req.allowedHosts, async (git, onAuth) => {
      const result = await git.fetch({
        url: req.url,
        dir: req.dir,
        onAuth,
        prune: true,
        tags: false,
        singleBranch: false,
        ...(req.depth ? { depth: req.depth } : {})
      });
      return `fetched ${req.url} (default branch ${result.defaultBranch ?? "unknown"})`;
    });
  }

  async gitPush(req: {
    url: string;
    dir: string;
    branch: string;
    allowedHosts: string[];
  }): Promise<RepoGitResult> {
    return this.#git(req.allowedHosts, async (git, onAuth) => {
      const result = await git.push({
        url: req.url,
        dir: req.dir,
        ref: req.branch,
        remoteRef: req.branch,
        onAuth
        // No `force`, ever, and not a knob: `/repo` refuses anything but a plain
        // branch name precisely so that a push cannot be turned into a force
        // push, and this is the other end of that promise.
      });
      // isomorphic-git reports a rejected push in the *result* rather than by
      // throwing — a non-fast-forward comes back `ok: false` with the reason on
      // the ref. Reading only the absence of an exception would report every
      // rejected push as a success, in the one plugin whose entire theme is that
      // a failed command is not a completed operation.
      if (!result.ok) {
        const perRef = Object.entries(result.refs)
          .filter(([, status]) => !status.ok)
          .map(([ref, status]) => `${ref}: ${status.error ?? "rejected"}`)
          .join("; ");
        throw new Error(
          result.error ?? perRef ?? "the remote rejected the push"
        );
      }
      return `pushed ${req.branch} to ${req.url}`;
    });
  }

  /**
   * The shared body: entry-point bookkeeping, the credential, and the translation
   * back into something that survives RPC.
   *
   * A thrown `GitError` loses its prototype crossing a Durable Object boundary,
   * so `instanceof` on the far side is not available and the caller would be left
   * pattern-matching a string. The `code` is lifted here, while the error is
   * still itself, and travels as data.
   */
  async #git(
    allowedHosts: string[],
    body: (git: GitClient, onAuth: AuthCallback) => Promise<string>
  ): Promise<RepoGitResult> {
    await this.#touch();
    await this.#repairAlarm();
    await this.#ready();

    // Bound to the credential rather than checked before the call, which is
    // strictly stronger: this is the moment the token would be handed over, and
    // it sees the URL git actually authenticated against — including one it
    // reached by redirect. A host nobody allowed gets no credential and the
    // request fails unauthenticated, rather than the token being offered to it
    // and *then* the mistake being noticed.
    const onAuth: AuthCallback = (url) => {
      let host: string;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") return {};
        host = parsed.hostname;
      } catch {
        return {};
      }
      if (!allowedHosts.includes(host)) {
        console.warn(`[${this.#tag}] refused to authenticate to a host`, {
          host
        });
        return {};
      }
      return { username: "x-access-token", password: this.env.GITHUB_TOKEN };
    };

    try {
      return { ok: true, detail: await body(this.#workspace.git, onAuth) };
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      return {
        ok: false,
        ...(typeof code === "string" ? { code } : {}),
        message: err instanceof Error ? err.message : String(err)
      };
    }
  }

  /**
   * Start a dependency install the moment we can see one will be needed.
   *
   * The signal is `container.running`, and it is free: `node_modules` lives in
   * the container and dies with it, so a stopped container plus a `done` record
   * is not ambiguous — the tree that record describes is gone. The getter is
   * synchronous, so the warm path costs one boolean and touches no storage.
   *
   * Armed from `__getWorkspaceStub()`, before any command runs, because the
   * model's first minute is README-reading and `git status` — an install armed
   * there runs *through* that minute, where one armed on the first `npm` command
   * charges its full 85 seconds to that command.
   *
   * It writes `running` before anything is running: the alarm has not fired yet,
   * and a `done` record would let an `npm` command through against a tree that
   * is not there. That also makes this self-limiting — the next call sees
   * `running` and stops — so the busiest entry point in the object arms at most
   * once per cold container.
   */
  async #armInstallIfCold(): Promise<void> {
    // Running container: whatever the record says about `node_modules`, it is
    // still true. This is the branch that runs on almost every call.
    if (this.ctx.container?.running) return;

    /**
     * `done` **or** `failed`, matching core's `isRearmable`, and narrowed to the
     * pair that carries a `state.command` — the placeholder needs one, since the
     * gate renders it while the alarm is still pending.
     *
     * **`failed` has to be in there.** Leaving it out means a workspace whose
     * install failed once declines to arm ever again, and one bad install
     * poisons every task after it. Re-driving a failure cannot loop here: this
     * runs once per cold container and writes `running` immediately.
     *
     * `skipped` and `idle` stay out for reasons rather than caution: `skipped`
     * means the resolver found nothing to install, so a missing tree is correct
     * and permanent; `idle` means nothing has ever been installed, so there is
     * no `install:context` naming where to do it — that is `repo_clone`'s job.
     *
     * `#installState()` rather than the lifecycle's raw `read()`, so a `running`
     * record left by a dead isolate is repaired to `failed` here and can arm.
     */
    const state = await this.#installState();
    if (state.state !== "done" && state.state !== "failed") return;

    // Where to install. Written by the install that succeeded before the
    // container went away, and the only record of it — there is no caller here to
    // ask, which is the whole reason `repo` is persisted alongside `dir`.
    const context = await this.#install.context();
    if (!context?.dir) return;

    console.info(`[${this.#tag}] cold container — arming a reinstall`, {
      id: this.ctx.id.toString(),
      dir: context.dir
    });

    // Everything the arming handshake needs — the placeholder write, the stamp
    // the alarm presents to `claim`, the cooldown floor and the run intent — in
    // one call, and unwound as a unit if the intent cannot be scheduled.
    await this.#install.arm({ command: state.command });
  }

  // --- lifecycle ---------------------------------------------------------------

  /**
   * Mark this workspace as in use, and push its reclamation back.
   *
   * Every entry point calls this, which is what makes the idle clock measure
   * *use* rather than "when the agent last said this name". The agent hands a
   * workspace name to a subagent once and then never sees the traffic; the
   * workspace sees all of it.
   */
  async #touch(): Promise<void> {
    const now = Date.now();
    // Everything reaches this object by RPC, which bypasses `fetch` — so this
    // is where the lifecycle gets started, and without it the scheduler's schema
    // is never migrated and the first `set` below runs against nothing. Guarded
    // internally, so calling it on every touch costs one resolved promise.
    await this.#wake.start();
    await this.ctx.storage.put("lastUsedAt", now);
    // Two deadlines *moved*, not two schedules added. This is the hottest path
    // in the object — every entry point calls it — so a bare `scheduler.set`
    // here would leave one row per request, every one of them due.
    await this.#idleReclaim.set(new Date(now + IDLE_RECLAIM_MS));
    await this.#containerIdle.set(new Date(now + this.#containerIdleMs));
  }

  /**
   * Throw this workspace away if nothing has touched it for `maxIdleMs`.
   *
   * Re-checks the clock rather than trusting the caller: the alarm may have been
   * armed a week ago, and a use since then must win. Safe to call from anywhere
   * for the same reason, which is what lets the agent's cron poke it as a
   * backstop without needing to know anything.
   */
  async reclaimIfIdle(
    maxIdleMs: number = IDLE_RECLAIM_MS
  ): Promise<{ reclaimed: boolean; idleMs: number; bytes: number }> {
    const lastUsedAt = await this.ctx.storage.get<number>("lastUsedAt");
    const bytes = this.ctx.storage.sql.databaseSize;

    // Nothing has ever used this object, so there is nothing to reclaim.
    //
    // Load-bearing, not defensive. `lastUsedAt` is written by `#touch()` and
    // removed by the `deleteAll()` below, so an *already reclaimed* workspace
    // reads exactly like a brand new one — and the old `?? 0` turned that into
    // "idle since the epoch", the most idle a workspace can possibly be. The
    // weekly sweep therefore re-reclaimed every workspace it had ever reclaimed,
    // every week, recreating storage just to empty it and logging a reclaim that
    // did not happen.
    if (lastUsedAt === undefined) return { reclaimed: false, idleMs: 0, bytes };

    const idleMs = Date.now() - lastUsedAt;
    if (idleMs < maxIdleMs) return { reclaimed: false, idleMs, bytes };

    console.info(`[${this.#tag}] reclaiming an idle workspace`, {
      id: this.ctx.id.toString(),
      idleDays: Math.round(idleMs / 86_400_000),
      bytes
    });

    await this.#stopContainer();
    // `deleteAll` does not take the alarm with it, so the alarm goes first —
    // otherwise a reclaimed object wakes once more into empty storage.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // It *also* takes the lifecycle's job queue table, which this instance has
    // already created and will not create again — so the next schedule set from
    // this isolate would fail against a table that is gone, and the workspace
    // would stop arming its timers until something evicted it. Reset the isolate
    // instead, as the SDK's own `Agent.destroy()` does: the next call constructs
    // the object fresh on empty storage, and every table comes back with it.
    // Deferred one macrotask so this call still returns its result, and with no
    // alarm retry, so the reset cannot wake the object it has just emptied.
    this.#reclaimed = true;
    setTimeout(() => {
      this.ctx.abort("workspace reclaimed", { retryAlarm: false });
    }, 0);

    return { reclaimed: true, idleMs, bytes };
  }

  /** Stop the container, keeping nothing. The workspace is what persists. */
  async #stopContainer(): Promise<void> {
    try {
      await this.ctx.container?.destroy();
    } catch (err) {
      // Already gone, most likely, and a container that cannot be stopped must
      // not turn a clean reclaim into a failed alarm.
      console.warn(`[${this.#tag}] could not stop the container`, {
        id: this.ctx.id.toString(),
        err: String(err)
      });
    }
  }

  /**
   * Whether this object is out of room, and by how much.
   *
   * Read on **two** paths, and the second is load-bearing. `#beginInstall`
   * consults it because an install is the operation that can move the number
   * meaningfully. {@link advisories} consults it on every call, which is what
   * lets a full workspace reach commands that have nothing to do with
   * dependencies — the write being lost is rarely a dependency's, so a capacity
   * fact delivered only alongside install state reaches everything except what
   * it is about.
   *
   * Cheap enough for that: `databaseSize` is a local property read, not a query.
   */
  #storageHeadroom(): { bytes: number; capBytes: number } | undefined {
    const bytes = this.ctx.storage.sql.databaseSize;
    if (bytes < STORAGE_CAP_BYTES) return undefined;
    return { bytes, capBytes: STORAGE_CAP_BYTES };
  }

  // --- the dependency install ------------------------------------------------

  /** `resolveInstallCommand` reads the checkout through this. */
  #probe(): InstallProbe {
    const fs = this.#workspace.fs;
    return {
      // The plugin's own, which asks for the stub's `exists` and only falls back
      // to `stat` when there is none — the local `WorkspaceFilesystem` here being
      // exactly that case.
      exists: (path) => pathExists(fs, path),
      readFile: (path) => fs.readFile(path, "utf8")
    };
  }

  /**
   * Trust the CA the egress interception presents, once there is one.
   *
   * **This cannot be done in the image's entrypoint**, which is where
   * Cloudflare's own recipe puts it, and the reason is ordering rather than
   * preference. Their recipe assumes interception is declared as container
   * configuration, so the runtime mounts the CA before the container starts.
   * `@cloudflare/computer` uses the raw container API, where the only
   * interception hooks are methods called *after* `start()` — so an entrypoint
   * runs strictly before the CA can exist, finds nothing, and reports the
   * container un-intercepted while every later TLS connection fails.
   *
   * Here is the earliest point that is not too early: `#ready` has awaited the
   * workspace's own `ready()`, which completes the backend's `connect()` —
   * start and interception both. `#ready` is the only caller, and that is the
   * point of it: this used to hang off `#beginInstall`, which meant a container
   * was trusted only when it also happened to be due a dependency install.
   *
   * Idempotent, so the tracking in `#ready` is an optimisation rather than a
   * correctness device — an `install -m 644` against a container that already
   * ran it costs milliseconds. What would cost a session is a flag that
   * outlived the container it describes, which is why the one that exists is in
   * memory and cleared on any container that is not running.
   *
   * Never throws. A workspace that cannot trust the CA still has a checkout, a
   * shell and a git history, and the install about to run will say plainly what
   * went wrong — refusing to start it here would replace a legible TLS error
   * with an opaque one.
   */
  async #trustInterceptionCa(): Promise<void> {
    try {
      using handle = await this.#workspace.runtime.exec(TRUST_CA_COMMAND, {
        cwd: "/",
        encoding: "utf8",
        timeoutMs: 30_000
      });
      const result = await handle.result();
      /**
       * Marked on a command that *ran*, not on one that found a CA.
       *
       * The command exits 0 either way — it prints `NO CA AT …` when there is
       * nothing to install — and that case is not worth retrying within a
       * container: interception is configured by the `connect()` that `#ready`
       * already awaited, so a CA absent now stays absent until the container is
       * replaced. Retrying it on every call would buy nothing and cost a
       * round-trip on the object's hottest path.
       *
       * A throw leaves this false, so an unreachable container is tried again.
       */
      this.#caTrusted = true;
      // Logged at info once per container, deliberately. The container's own
      // stdout does not reach Workers Observability, so this line is the only
      // place an operator can see whether the container can speak TLS at all —
      // and its absence is itself the answer when a workspace never got this far.
      //
      // Once per container rather than per call is also what makes it readable:
      // on the busiest entry point in the object, a line per call would bury the
      // one that matters under thousands that say the same thing.
      console.info(`[${this.#tag}] container TLS trust`, {
        id: this.ctx.id.toString(),
        exitCode: result.exitCode,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
      });
    } catch (err) {
      console.warn(`[${this.#tag}] could not trust the interception CA`, {
        id: this.ctx.id.toString(),
        err: String(err)
      });
    }
  }

  /**
   * Is there a `node_modules` in the container right now?
   *
   * Asked of the **container**, not the workspace, and that is the whole point:
   * `node_modules` is never synced, so `ws.fs` would say no even when a perfectly
   * good tree is sitting there — and would say nothing useful about a tree that
   * has just been thrown away with its container.
   */
  async #dependenciesPresent(dir: string): Promise<boolean> {
    try {
      using handle = await this.#workspace.runtime.exec(
        `test -d "${dir}/node_modules"`,
        { cwd: "/", encoding: "utf8", timeoutMs: 30_000 }
      );
      return (await handle.result()).exitCode === 0;
    } catch {
      // Unreachable container, most likely. Treat as absent: a redundant
      // install costs time, a skipped one costs a confusing failure.
      return false;
    }
  }

  /**
   * Start installing this checkout's dependencies, and return without waiting.
   *
   * Called from `repo_clone` through the repo plugin's `afterCheckout` hook, so
   * it runs inside a model turn and must not block on the install — 225 seconds
   * for slack-gatekeeper, against a chunk step that dies at ten minutes.
   *
   * That caller is a model turn, which lives long enough to hold the drain handed
   * to `ctx.waitUntil` below. **A short-lived caller cannot**, which is why the
   * cold-container path goes through the alarm and {@link #installAwaited} rather
   * than calling this.
   */
  async startInstall(req: {
    dir: string;
    repo?: string;
  }): Promise<InstallState> {
    return this.#beginInstall(req, (handle) => {
      // Drained here, in this object, on nobody's step budget. The watchdog picks
      // it up if this isolate does not survive the command.
      this.ctx.waitUntil(this.#drainInstall(handle));
    });
  }

  /**
   * The same install, drained **inside the caller** rather than after it.
   *
   * For the alarm, which owns no request: nothing it awaits can be cut short by a
   * response being sent, so the drain cannot be disposed out from under an
   * `npm ci` half-way through. Returns once the command has actually finished.
   */
  async #installAwaited(
    req: { dir: string; repo?: string },
    armedAt: number
  ): Promise<InstallState> {
    await this.#beginInstall(req, (handle) => this.#drainInstall(handle), {
      takeOverArmedAt: armedAt
    });
    return this.#installState();
  }

  /**
   * Resolve, guard, spawn — and hand the running command to `own`, which decides
   * whether the drain outlives this call or is awaited within it. That choice is
   * the only difference between the two entry points above, and it is the
   * difference that broke production, so it is the one thing this parameterises.
   */
  async #beginInstall(
    req: { dir: string; repo?: string },
    own: (handle: WorkspaceRuntimeExecHandle<"utf8">) => void | Promise<void>,
    opts?: { takeOverArmedAt?: number }
  ): Promise<InstallState> {
    await this.#touch();
    await this.#ready();

    /**
     * One install at a time — the hazard is displacement.
     *
     * `repo_clone` calls this and a retried chunk calls it again. Every call
     * spawns with the same {@link INSTALL_EXEC_ID}, so without this each would
     * displace the last while the displaced command's drain stayed attached
     * through `ctx.waitUntil` — then wrote *its* outcome over a record
     * describing an install still running perfectly well.
     *
     * `#installState()` rather than the lifecycle's raw `read()`, so a `running`
     * record left by a dead isolate is resolved here rather than blocking a
     * legitimate retry forever.
     *
     * `takeOverArmedAt` is the one exemption, narrow on purpose: the alarm's
     * placeholder is a `running` record for an install that has not started, so
     * the alarm must pass its own guard and only its own. Matching the exact
     * `startedAt` it wrote is what stops that becoming "take over any running
     * install", which is displacement again in a new hat.
     */
    const current = await this.#installState();
    const claim = this.#install.claim(
      current,
      this.#installTimeoutMs,
      opts?.takeOverArmedAt
    );
    if (!claim.ok) {
      console.info(`[${this.#tag}] an install is already in flight`, {
        id: this.ctx.id.toString(),
        command: claim.current.command,
        seconds: Math.round((Date.now() - claim.current.startedAt) / 1000)
      });
      return claim.current;
    }

    /**
     * A full workspace refuses the install and **writes nothing**.
     *
     * Capacity is not an install outcome, and recording it as one costs twice
     * over. `skipped` is the variant meaning "this checkout has nothing to
     * install", so a hard wall about the Durable Object would arrive wearing the
     * label of a routine fact about the repository; and writing any record here
     * erases what the record held, so a real install failure would disappear the
     * moment the object filled up.
     *
     * It travels as its own advisory instead, from {@link advisories}, which
     * reads it fresh on every call and therefore reaches commands that have
     * nothing to do with dependencies.
     */
    const full = this.#storageHeadroom();
    if (full) {
      console.error(
        `[${this.#tag}] refusing to install: the workspace is full`,
        {
          id: this.ctx.id.toString(),
          bytes: full.bytes,
          capBytes: full.capBytes
        }
      );
      return current;
    }

    // The CA is not installed here any more. It moved up into `#ready`, above
    // the two early returns this used to sit below — an install already in
    // flight, and a full workspace — because neither of those means the
    // container can speak TLS. It still lands before the resolver, and now it
    // lands before them too.

    const probe = this.#probe();
    const resolution = await resolveInstallCommand(
      probe,
      req.dir,
      this.#cfg.installPlan,
      req.repo
    );

    if (resolution.kind === "skip") {
      const state: InstallState = {
        state: "skipped",
        reason: resolution.reason
      };
      await this.#install.write(state);
      /**
       * The common branch, and the one whose absence is indistinguishable from
       * never having been called.
       *
       * Every other outcome here leaves a line — an install in flight, a full
       * workspace, a spawn that failed, each end of the drain — so a workspace
       * that skipped and a workspace that never installed read identically in the
       * logs, and any checkout without a `package.json` takes this path. A skip
       * is routine; establishing that one happened should not require an argument
       * from silence.
       */
      console.info(`[${this.#tag}] install skipped`, {
        id: this.ctx.id.toString(),
        dir: req.dir,
        ...(req.repo ? { repo: req.repo } : {}),
        reason: resolution.reason
      });
      return state;
    }

    const fingerprint = await installFingerprint(probe, req.dir, resolution);

    /**
     * The skip condition, and **both halves are required**.
     *
     * A matching fingerprint says the same install would produce the same tree.
     * It does not say the tree is there — the fingerprint is in this object's
     * storage, which is durable, and `node_modules` is in the container, which
     * is not. Skipping on the fingerprint alone would skip exactly the install a
     * cold container needs most, and the symptom is a subagent whose first
     * `import` fails for no visible reason.
     */
    const previous = await this.ctx.storage.get<{ fingerprint: string }>(
      "install:completed"
    );
    if (
      fingerprint &&
      previous?.fingerprint === fingerprint &&
      (await this.#dependenciesPresent(req.dir))
    ) {
      const state: InstallState = {
        state: "done",
        command: resolution.command,
        exitCode: 0,
        finishedAt: Date.now(),
        ms: 0,
        tail: "dependencies already installed for this lockfile"
      };
      await this.#install.write(state);
      return state;
    }

    const startedAt = Date.now();
    const state: InstallState = {
      state: "running",
      command: resolution.command,
      startedAt
    };
    await this.#install.write(state);
    await this.#install.putContext({
      dir: req.dir,
      // Kept so a reinstall the alarm drives — which has no caller to ask —
      // resolves the same command this one did. Without it a repository
      // with an `INSTALL_PLAN` override would silently fall back to the default
      // on every cold container, installing a different tree than the first time.
      ...(req.repo ? { repo: req.repo } : {}),
      fingerprint,
      command: resolution.command,
      startedAt
    });

    /**
     * Armed **before** the spawn — the hazard is an isolate that dies between
     * the two.
     *
     * The record above already says `running`, so from here until something
     * writes a terminal state the gate is shut and the alarm is the only thing
     * that can open it. Arming afterwards leaves a window with nothing scheduled
     * to recover: a `runtime.exec` that threw on the container's WebSocket left
     * a workspace `running` for half an hour, refusing every command.
     *
     * Arming early is free — the handler clears the intent if the record is not
     * `running`, so finishing first costs one wake-up.
     */
    await this.#install.armWatch();

    let handle: WorkspaceRuntimeExecHandle<"utf8">;
    try {
      handle = await this.#workspace.runtime.exec(resolution.command, {
        id: INSTALL_EXEC_ID,
        cwd: req.dir,
        encoding: "utf8",
        timeoutMs: this.#installTimeoutMs
      });
    } catch (err) {
      // The command never started, so nothing will ever drain it and no
      // re-attach can find it. Close the record here: a `failed` install is
      // recoverable — the subagent is told what happened and can run the command
      // itself — where a `running` one that nobody owns is not.
      console.error(`[${this.#tag}] the install could not be started`, {
        id: this.ctx.id.toString(),
        command: resolution.command,
        err: String(err)
      });
      const failed: InstallState = {
        state: "failed",
        command: resolution.command,
        finishedAt: Date.now(),
        error:
          `the install could not be started (${String(err)}). The container ` +
          "was most likely unreachable. Run the command yourself with sb_exec, " +
          "or clone again to retry it."
      };
      await this.#install.write(failed);
      await this.#install.clearWatch();
      return failed;
    }

    await own(handle);

    return state;
  }

  /**
   * Record what was checked out here, and say whether it is actually visible.
   *
   * **The single writer of {@link CHECKOUT_KEY}**, called by the two paths that
   * know a checkout landed: the repo plugin's `afterCheckout` hook, which fires
   * only once a tree is established, and `scratch_open`, which fires once
   * `git init` has exited 0.
   *
   * **This is the canonical explanation of why the checkout is recorded apart
   * from the install**; call sites point here rather than restating it.
   *
   * An install is conditional and a checkout is not. `resolveInstallCommand`
   * skips a checkout it finds nothing to install in — any without a
   * `package.json` — and a path written only as part of an install is therefore
   * missing exactly there. What that costs is not a missing optimisation:
   * {@link checkoutDir} is how a delegated session is told where to work, so a
   * repository can clone perfectly, report itself correctly through the repo
   * tools, and never be worked in.
   *
   * The install keeps its own context, and should. What to re-run on a cold
   * container is a different question from what is on disk, with a different
   * lifetime; one record cannot answer both without one of the answers being
   * wrong somewhere.
   *
   * Returns the probe as well as the path, so a caller learns in one round trip
   * whether the tree is visible rather than discovering it a delegation later.
   */
  async noteCheckout(req: {
    dir: string;
    repo?: string;
    kind: "repo" | "scratch";
  }): Promise<{ dir: string; present: boolean }> {
    await this.#touch();
    const record: CheckoutRecord = {
      dir: req.dir,
      ...(req.repo ? { repo: req.repo } : {}),
      kind: req.kind,
      at: Date.now()
    };
    await this.ctx.storage.put(CHECKOUT_KEY, record);
    const present = await this.#isCheckout(req.dir);
    console.info(`[${this.#tag}] checkout recorded`, {
      id: this.ctx.id.toString(),
      dir: req.dir,
      kind: req.kind,
      ...(req.repo ? { repo: req.repo } : {}),
      present
    });
    return { dir: req.dir, present };
  }

  /**
   * Where the work is — a directory holding a git repository, or nothing.
   *
   * Two callers depend on that being the meaning rather than "a path somebody
   * wrote down once": a Claude Code session takes it as its cwd, and
   * `discardWorkingTree` runs `git reset --hard` in it. Both want the same
   * question answered, and neither can recover from a confident wrong answer.
   *
   * So it is **probed, not remembered**. A record is where to look; `.git` being
   * there is what makes the answer true. That costs one local read of this
   * object's own SQLite — `.git` is durable, since `computerd` excludes only
   * `node_modules` from the sync — and it is what turns a stale record into
   * `undefined` instead of into a session started in a directory that is no
   * longer a checkout.
   *
   * The fallback to the install context is a **migration**, not a second source
   * of truth, and it is a partial one: it reaches a workspace whose install ran,
   * and cannot reach one whose install was skipped, since that is the case with
   * no context to fall back to either. Those answer `undefined` until their next
   * checkout records one — which `repo_clone` does on any tree it can fetch and
   * reset, and cannot do on a tree it refuses to touch because it is dirty. The
   * whole fallback can go once no live workspace predates the record.
   */
  async checkoutDir(): Promise<string | undefined> {
    const record = await this.ctx.storage.get<CheckoutRecord>(CHECKOUT_KEY);
    const dir = record?.dir ?? (await this.#install.context())?.dir;
    if (!dir) return undefined;
    if (await this.#isCheckout(dir)) return dir;
    // Said out loud because the return value cannot say it: a caller reads
    // `undefined` as "nothing has been cloned", which is also the right answer
    // for a workspace nobody ever cloned into. Only this line separates them.
    console.warn(`[${this.#tag}] a recorded checkout is no longer there`, {
      id: this.ctx.id.toString(),
      dir,
      recorded: record ? record.kind : "install-context",
      // The rest of the record, because this line is read during an incident and
      // "the checkout for acme/spike went missing forty minutes ago" is a
      // different investigation from a bare path. It is also what these two
      // fields are *for* — nothing else reads them, and a record carrying state
      // nobody ever looks at is how the last one drifted.
      ...(record?.repo ? { repo: record.repo } : {}),
      ...(record ? { ageMs: Date.now() - record.at } : {})
    });
    return undefined;
  }

  /**
   * Whether `dir` holds a git repository, as this object's own storage sees it.
   *
   * `.git` rather than the directory: an empty directory is not a checkout, and
   * the two callers of {@link checkoutDir} both need git to be there — one to
   * reset the tree, the other to run a session that will commit in it. It is
   * also the one probe a scratchpad and a clone answer identically, which is
   * what lets them share every path below this line.
   */
  async #isCheckout(dir: string): Promise<boolean> {
    try {
      return await pathExists(this.#workspace.fs, `${dir}/.git`);
    } catch (err) {
      // A read of local SQLite that threw says nothing about the tree. Treat it
      // as absent: refusing a delegation costs a round, starting a session in a
      // directory that may not exist costs the run.
      console.warn(`[${this.#tag}] could not probe a checkout`, {
        id: this.ctx.id.toString(),
        dir,
        err: String(err)
      });
      return false;
    }
  }

  /**
   * Everything currently true about this workspace that a caller must not assume
   * away — the array `sb_exec`, `sb_write` and `sb_edit` all consult.
   *
   * The policy is not here. `deriveAdvisories` decides which facts matter and
   * how they are worded; this method gathers what only the object can see and
   * hands it over. That split is why a host cannot get the severity of its own
   * workspace wrong.
   *
   * **Nothing that starts a long job belongs on this path**, and the rule is
   * sharper here than anywhere else in the object because every tool call reads
   * it. `startInstall` in particular must never be reached from here: it hands
   * its drain to `ctx.waitUntil`, whose lifetime is the invocation's, and an
   * invocation on this path is a tool call that returns in milliseconds. The
   * drain outlives its owner, dies mid-`npm ci` with "WritableStream RPC stub
   * was disposed without calling close()", and leaves a half-written tree.
   *
   * Detecting a cold container happens once, in {@link #armInstallIfCold}, off a
   * boolean rather than a container round-trip — and the install runs in the
   * alarm, which owns no request and outlives every RPC.
   */
  async advisories(): Promise<readonly WorkspaceAdvisory[]> {
    const install = await this.#installState();
    const storage = this.#storageHeadroom();
    return deriveAdvisories({
      install,
      ...(storage ? { storage } : {}),
      dependencyTreePresent: await this.#treePresentIfItMatters(install)
    });
  }

  /**
   * The `node_modules` probe, run only when its answer changes anything, and at
   * most once per {@link TREE_PROBE_TTL_MS}.
   *
   * Both bounds are about cost. The probe is a container round-trip, and
   * {@link advisories} is now read before **every** tool call rather than before
   * the dependency-shaped ones — so an unconditional probe would put an exec on
   * the path of every `cat`. It only ever qualifies a `deps-broken` advisory
   * (see `deriveAdvisories`), so outside that state there is nothing to learn,
   * and within it the answer changes about as often as an install finishes.
   *
   * Memoised in memory rather than in storage: a stale `false` costs one
   * sentence of nuance in an advisory that is being reported either way, which
   * is not worth a durable write on this path.
   */
  async #treePresentIfItMatters(install: InstallState): Promise<boolean> {
    if (install.state !== "failed") return false;
    const dir = (await this.#install.context())?.dir;
    if (!dir) return false;

    const now = Date.now();
    const cached = this.#treeProbe;
    if (cached && cached.dir === dir && now - cached.at < TREE_PROBE_TTL_MS) {
      return cached.present;
    }

    const present = await this.#dependenciesPresent(dir);
    this.#treeProbe = { at: now, dir, present };
    return present;
  }

  /** Last {@link #treePresentIfItMatters} answer, for this isolate only. */
  #treeProbe?: { at: number; dir: string; present: boolean };

  /**
   * The install record itself, with its staleness bound and re-attach applied.
   *
   * Split from {@link advisories} so `startInstall` can consult the record
   * without going through the `node_modules` probe, which needs a container and
   * has nothing to say about whether an install may start.
   *
   * Re-attaches on the way past. An isolate reset leaves the record saying
   * `running` with nothing draining it, and without this the state would say
   * `running` forever while the command had long since finished.
   */
  async #installState(): Promise<InstallState> {
    const state = await this.#install.read();

    if (state.state !== "running") return state;

    /**
     * `running` has an expiry — the proof the file header refers to.
     *
     * The command carries a `timeoutMs` the runtime enforces, so past that plus
     * a wide margin a live install is not a possibility: whatever the record
     * says, nobody is coming back with an exit code. Writing `failed` here is
     * not a guess about what happened, it is the only accurate thing left to
     * say — which is what makes it a bound rather than another guard.
     */
    if (this.#install.isStale(state, this.#installTimeoutMs)) {
      const minutes = Math.round((Date.now() - state.startedAt) / 60_000);
      console.error(`[${this.#tag}] abandoning a stale install`, {
        id: this.ctx.id.toString(),
        command: state.command,
        minutes
      });
      const failed: InstallState = {
        state: "failed",
        command: state.command,
        finishedAt: Date.now(),
        error:
          `the install has been running for ${minutes} minutes without ` +
          "reporting, which is past its timeout — it is not going to finish. " +
          "Run the command yourself with sb_exec if you still need it."
      };
      await this.#install.write(failed);
      await this.#install.clearWatch();
      return failed;
    }

    if (!this.#draining) {
      await this.#reattachInstall();
      return await this.#install.read();
    }
    return state;
  }

  /** True while this isolate holds the drain, so the watchdog leaves it alone. */
  #draining = false;

  async #drainInstall(
    handle: WorkspaceRuntimeExecHandle<"utf8">
  ): Promise<void> {
    this.#draining = true;
    const context = await this.#install.context();
    const command = context?.command ?? "(unknown)";
    const startedAt = context?.startedAt ?? Date.now();

    /**
     * Whether this drain still owns the record.
     *
     * The guard in `startInstall` stops two installs overlapping in the first
     * place; this makes it harmless if one ever does. A drain can outlive the
     * command it was watching — `ctx.waitUntil` keeps running after the RPC
     * returns — and the damage a late one does is silent: it writes a verdict
     * about a finished command over a record describing a live one, and every
     * `sb_exec` then reads a result that belongs to nothing.
     *
     * `startedAt` is the generation marker. `#beginInstall` rewrites the context
     * before it spawns, so a drain whose stamp no longer matches has been
     * superseded and has nothing useful left to say. The marker also **latches**:
     * ownership is not recoverable, so a stamp that happens to match again does
     * not hand the record back.
     *
     * Wrapped rather than used bare only to log the transition, and only once —
     * a superseded drain asks this on both the success and the error path.
     */
    const generation = this.#install.generation(startedAt);
    let logged = false;
    const stillMine = async (): Promise<boolean> => {
      if (await generation.stillMine()) return true;
      if (!logged) {
        logged = true;
        console.warn(`[${this.#tag}] discarding a superseded install drain`, {
          id: this.ctx.id.toString(),
          command,
          startedAt,
          current: (await this.#install.context())?.startedAt
        });
      }
      return false;
    };

    try {
      const result = await handle.result();
      // Middle-out rather than a tail cut, and it marks what it dropped: an
      // install's diagnosis is split between the two ends — the first error and
      // the summary that follows it — and a plain `slice(-n)` silently keeps
      // only the half that happens to be last.
      const tail = truncateOutput(result.stdout + result.stderr, 2000);
      if (!(await stillMine())) return;

      if (result.exitCode === 0) {
        // Recorded only on success, and this is what the skip condition reads.
        // A failed install must not leave a fingerprint behind, or the next
        // checkout would decide the tree it never built is already good.
        if (context?.fingerprint) {
          await this.ctx.storage.put("install:completed", {
            fingerprint: context.fingerprint,
            at: Date.now()
          });
        }
        console.info(`[${this.#tag}] install finished`, {
          id: this.ctx.id.toString(),
          command,
          seconds: Math.round((Date.now() - startedAt) / 1000)
        });
        await this.#install.write({
          state: "done",
          command,
          exitCode: 0,
          finishedAt: Date.now(),
          ms: Date.now() - startedAt,
          tail
        });
      } else {
        // Logged, and this line is not optional. This is the *ordinary* way an
        // install fails — the other paths are all exceptional — and it used to
        // write the record and say nothing, so an operator looking at why the
        // subagent was complaining found the complaint and no cause. The tail
        // is the install's own last words; without it the only copy is inside a
        // Durable Object nobody can query.
        console.error(`[${this.#tag}] install failed`, {
          id: this.ctx.id.toString(),
          command,
          exitCode: result.exitCode,
          seconds: Math.round((Date.now() - startedAt) / 1000),
          tail: truncateOutput(tail, 1000)
        });
        await this.#install.write({
          state: "failed",
          command,
          finishedAt: Date.now(),
          exitCode: result.exitCode,
          error: `the install command exited ${result.exitCode}`,
          tail
        });
      }
    } catch (err) {
      // Superseded drains fail here constantly — replacing an exec is what
      // breaks the old handle — so this check matters more on the error path
      // than on the success one.
      if (!(await stillMine())) return;
      // The drain itself broke — the container went away mid-install, most
      // likely. Distinct from a non-zero exit above, and worth telling apart in
      // the logs, because this one says nothing about the repository.
      console.error(`[${this.#tag}] install drain failed`, {
        id: this.ctx.id.toString(),
        command,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        err: String(err)
      });
      await this.#install.write({
        state: "failed",
        command,
        finishedAt: Date.now(),
        error: String(err)
      });
    } finally {
      this.#draining = false;
      handle[Symbol.dispose]();
      // Not if this drain was superseded: the watchdog belongs to whichever
      // install owns the record now, and clearing it here would disarm the one
      // recovery path the *live* install has.
      if (!generation.superseded()) await this.#install.clearWatch();
    }
  }

  /**
   * Pick up an install this isolate did not start.
   *
   * `getExec` with `resume: "tail"` re-opens the stream of a command that is
   * still running in the container — or replays the end of one that finished
   * while nobody was listening, which is the case that would otherwise leave the
   * record stuck at `running` and every `sb_exec` blocked behind it.
   */
  async #reattachInstall(): Promise<void> {
    if (this.#draining) return;
    try {
      const handle = await this.#workspace.runtime.getExec(INSTALL_EXEC_ID, {
        encoding: "utf8",
        resume: "tail"
      });
      this.ctx.waitUntil(this.#drainInstall(handle));
    } catch (err) {
      // The exec is gone entirely — the container was replaced under it. Say so
      // rather than leaving the gate closed forever; the next checkout starts a
      // new install, and `sb_exec` can run in the meantime.
      console.warn(`[${this.#tag}] could not re-attach to the install`, {
        id: this.ctx.id.toString(),
        err: String(err)
      });
      const context = await this.#install.context();
      await this.#install.write({
        state: "failed",
        command: context?.command ?? "(unknown)",
        finishedAt: Date.now(),
        error:
          "the install stopped without reporting — its container was most " +
          "likely replaced. Re-run it with sb_exec, or clone again to restart it."
      });
      await this.#install.clearWatch();
    }
  }

  /**
   * `computerd`'s outbound WebSocket upgrade, on its way back in.
   *
   * The container dials the loopback rather than the other way round, so this
   * object is the server for its own container's capnweb session. Everything
   * else on this object is RPC; this is the only HTTP it speaks.
   */
  override fetch(request: Request): Promise<Response> {
    return this.backend.handleFetch(request);
  }

  /**
   * Every durable wake-up this object has, dispatched from the one alarm.
   *
   * **This must not throw.** The runtime retries a failing alarm handler a
   * bounded number of times and then stops for good — so a throw here would
   * eventually take every *future* wake-up down with it, permanently, and the
   * only symptom is that nothing ever happens again.
   *
   * Nothing else belongs here. Each reason to wake is a registered callback the
   * scheduler dispatches by name, so this method neither matches on keys nor
   * catches per-callback failures — the scheduler retries a failing callback and
   * reports one that fails for good through `onError`. Nor does it sweep for a
   * schedule that neither rescheduled nor cleared itself: a one-shot row is
   * dropped when it runs, so it cannot stay due forever.
   */
  override async alarm(): Promise<void> {
    try {
      await this.#wake.alarm();
    } catch (err) {
      // The idle reclaim ran from this alarm and emptied storage, the job queue
      // with it, so settling the job that ran it fails. That is the reclaim
      // working, and the isolate is about to reset; nothing is left to re-arm.
      if (this.#reclaimed) return;
      console.error(`[${this.#tag}] the alarm failed`, {
        id: this.ctx.id.toString(),
        err: String(err)
      });
      // One missed wake rather than every future one: re-arm from whatever
      // survived, since the throw above is what the runtime counts against the
      // bounded retry that ends in the alarm being abandoned.
      await this.#wake.rearm().catch(() => {});
    }
  }

  /** A backend's pending pull came due. */
  async #onSyncRetry(backend: string): Promise<void> {
    const result = await this.#workspace.retryPendingSync(backend);
    if (result.status !== "exhausted") return;

    // The library leaves the intent stored on this path, so clear it here rather
    // than leaving a deadline nothing will ever act on. Edits made in the
    // container by the command that triggered this pull are gone.
    console.error(`[${this.#tag}] pending sync exhausted`, {
      id: this.ctx.id.toString(),
      backend,
      attempt: result.attempt,
      err: result.error
    });
    await this.#syncRetryDeadline(backend).clear();
  }

  /**
   * The armed reinstall came due.
   *
   * `clearArmed` first and unconditionally: this handler runs for minutes, and
   * the stamp left in place is what a second arming would recognise as its own.
   * `startInstall`'s in-flight guard would catch a double, but the cheaper
   * answer is not to schedule one.
   */
  async #onInstallRun(): Promise<void> {
    const context = await this.#install.context();
    const armedAt = await this.#install.armedAt();
    await this.#install.clearArmed();
    if (!context?.dir || armedAt === undefined) return;

    const state = await this.#installAwaited(
      {
        dir: context.dir,
        ...(context.repo ? { repo: context.repo } : {})
      },
      armedAt
    );
    console.info(`[${this.#tag}] armed reinstall finished`, {
      id: this.ctx.id.toString(),
      dir: context.dir,
      state: state.state
    });
  }

  /** The watchdog: an install still running that nobody is draining. */
  async #onInstallWatch(): Promise<void> {
    const state = await this.#install.read();
    if (state.state !== "running") return;
    // Still running and nobody draining it: this isolate is new since the
    // command started. Re-attach, and come back if it is still going.
    await this.#reattachInstall();
    await this.#install.armWatch();
  }

  /** The idle-reclaim deadline came due. */
  async #onIdleReclaim(): Promise<void> {
    const { reclaimed, idleMs } = await this.reclaimIfIdle();
    // Not idle after all — something used it since this was armed, and that
    // `#touch` already moved the deadline to a row of its own. So there is
    // nothing to re-arm here, and re-arming would create a second one.
    if (reclaimed) return;
    console.info(`[${this.#tag}] idle reclaim deferred`, {
      id: this.ctx.id.toString(),
      idleMinutes: Math.round(idleMs / 60_000)
    });
  }

  /** The container-idle deadline came due. */
  async #onContainerIdle(): Promise<void> {
    // An install still running is "in use" even though nothing has called in —
    // stopping the container under it would throw away the work and leave the
    // gate closed until something noticed.
    const state = await this.#install.read();
    if (state.state === "running") {
      await this.#containerIdle.set(
        new Date(Date.now() + this.#containerIdleMs)
      );
      return;
    }

    // Re-read the clock rather than trusting the alarm, the same way
    // `reclaimIfIdle` does. `#touch` moves the deadline forward, but an alarm
    // already in flight cannot be recalled — so without this a workspace that
    // was used a second ago can still have its container stopped by a wake-up
    // that was scheduled before that use.
    const lastUsedAt = (await this.ctx.storage.get<number>("lastUsedAt")) ?? 0;
    const idleMs = Date.now() - lastUsedAt;
    if (idleMs < this.#containerIdleMs) {
      await this.#containerIdle.set(
        new Date(lastUsedAt + this.#containerIdleMs)
      );
      return;
    }

    await this.#stopContainer();
  }
}

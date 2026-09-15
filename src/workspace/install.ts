import type { Workspace } from "@cloudflare/computer";
import type { WorkspaceRuntimeExecHandle } from "@cloudflare/computer";
import type { Scheduler } from "@dynamicagents/core/alarm";
import { JobLifecycle, type JobContext } from "@dynamicagents/core/job";
import {
  installFingerprint,
  pathExists,
  resolveInstallCommand,
  truncateOutput,
  type InstallPlan,
  type InstallProbe,
  type InstallState
} from "@dynamicagents/plugins/computer";
import type { WorkspaceWakeHandlers } from "./wake.js";

/**
 * Whether a thrown value is the runtime reporting a replaced container.
 *
 * `code` rather than the message: the property the package sets deliberately,
 * and the one that survives a reworded string. What it means here is narrower
 * than "the command failed" — the container that command was running in is gone,
 * so anything this object believed about *that* container is now about nothing.
 */
function execWasLost(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === "EEXEC_LOST";
}

/**
 * The dependency install: when it runs, what it runs, and what it owes on
 * waking.
 *
 * ## The rule every guard here serves
 *
 * `running` is the one install state that **blocks work**: the plugin's gate
 * waits on it and then refuses to run. Every other state is a fact a subagent
 * can act on. So a `running` record must never outlive the command it describes,
 * and the ways it can are not all reachable from one place — the spawn can fail
 * before a drain is attached, a drain can be cut short by an eviction, `getExec`
 * can hand back a handle to a container that never answers, and two installs can
 * displace each other. Each guard below names the one it closes; the staleness
 * bound in {@link InstallJob.state} is the proof that covers the rest.
 *
 * ## What decides that an install is needed
 *
 * The dependency tree is synced into the workspace like everything else, so a
 * container that went away takes none of it with it and a replacement is handed
 * it back. The signal is therefore the **tree**, not the container, and it is a
 * read of the object's own storage rather than a round trip.
 */

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
 * superseded. The rest is this install's own — `dir` because the alarm that
 * re-runs an install has no caller to ask, `repo` so a repository with an
 * `INSTALL_PLAN` override
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
 * The exec id an install runs under.
 *
 * Fixed rather than generated, because the point is to find it again: an
 * isolate that dies mid-drain leaves the command running in the container, and
 * `getExec(id, { resume: "tail" })` is how the next invocation re-attaches
 * instead of starting a second `npm ci` alongside the first.
 */
const INSTALL_EXEC_ID = "dependency-install";

export interface InstallJobDeps {
  storage: DurableObjectStorage;
  scheduler: Scheduler<WorkspaceWakeHandlers>;
  workspace: () => Workspace;
  /** How this deployment installs dependencies for this agent's checkouts. */
  plan: () => InstallPlan;
  /** How long an install may run before it is killed. */
  timeoutMs: () => number;
  /** Set only when the workspace is over its ceiling. */
  headroom: () => { bytes: number; capBytes: number } | undefined;
  /** The object's own entry-point bookkeeping, which an install still owes. */
  touch: () => Promise<void>;
  ready: () => Promise<void>;
  /** Hand a drain to the invocation, for the caller that can hold one. */
  waitUntil: (promise: Promise<unknown>) => void;
  /** Ask the host to finish a pull this install could not. */
  armSync: () => Promise<void>;
  /** A container was replaced, so nothing believed about it still holds. */
  forgetTrust: () => void;
  tag: () => string;
  id: () => string;
}

export class InstallJob {
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
  readonly #job: JobLifecycle<
    { command: string },
    InstallContext,
    WorkspaceWakeHandlers
  >;

  // Built here rather than as a field initializer, which would run before the
  // constructor's own parameter property and read `deps` as undefined.
  constructor(private readonly deps: InstallJobDeps) {
    this.#job = new JobLifecycle({
      id: INSTALL_KEY,
      storage: deps.storage,
      scheduler: deps.scheduler,
      run: "installRun",
      watch: "installWatch",
      staleMs: INSTALL_STALE_MS,
      watchMs: INSTALL_WATCH_MS,
      armCooldownMs: INSTALL_ARM_COOLDOWN_MS
    });
  }

  /**
   * Start a dependency install the moment we can see one will be needed.
   *
   * The signal is the **tree**, not the container: `node_modules` is synced into
   * this object's storage like everything else, so a container that went away
   * takes no dependencies with it and a replacement is handed them back. What is
   * left to detect is the case where the workspace genuinely has no tree — a
   * checkout whose install never ran, one whose pull never finished, or one
   * written before the tree was synced at all — and that is a local read of this
   * object's own SQLite rather than a round trip to a container.
   *
   * Armed from `__getWorkspaceStub()`, before any command runs, because the
   * model's first minute is README-reading and `git status` — an install armed
   * there runs *through* that minute, where one armed on the first `npm` command
   * charges its full 85 seconds to that command.
   *
   * It writes `running` before anything is running: the alarm has not fired yet,
   * and a `done` record would let an `npm` command through against a tree that
   * is not there. That also makes this self-limiting — the next call sees
   * `running` and stops.
   */
  async armIfTreeMissing(): Promise<void> {
    // Where the install went, and the only record of it: there is no caller here
    // to ask, which is why `repo` is persisted alongside `dir`. Nothing to arm
    // for a workspace that has never installed anything — that is `repo_clone`'s
    // job, not this one's.
    const context = await this.#job.context();
    if (!context?.dir) return;

    // The branch that runs on almost every call, and it costs one local read.
    if (await this.treePresent(context.dir)) return;

    /**
     * `done` **or** `failed`, matching core's `isRearmable`, and narrowed to the
     * pair that carries a `state.command` — the placeholder needs one, since the
     * gate renders it while the alarm is still pending.
     *
     * **`failed` has to be in there.** Leaving it out means a workspace whose
     * install failed once declines to arm ever again, and one bad install
     * poisons every task after it. Re-driving a failure cannot loop here: the
     * arming cooldown is the floor under how often that can happen.
     *
     * `skipped` and `idle` stay out for reasons rather than caution: `skipped`
     * means the resolver found nothing to install, so a missing tree is correct
     * and permanent; `idle` means nothing has ever been installed, so there is
     * no `install:context` naming where to do it.
     *
     * `#installState()` rather than the lifecycle's raw `read()`, so a `running`
     * record left by a dead isolate is repaired to `failed` here and can arm.
     */
    const state = await this.state();
    if (state.state !== "done" && state.state !== "failed") return;

    console.info(
      `[${this.deps.tag()}] no dependency tree — arming an install`,
      {
        id: this.deps.id(),
        dir: context.dir
      }
    );

    // Everything the arming handshake needs — the placeholder write, the stamp
    // the alarm presents to `claim`, the cooldown floor and the run intent — in
    // one call, and unwound as a unit if the intent cannot be scheduled.
    await this.#job.arm({ command: state.command });
  }

  /** `resolveInstallCommand` reads the checkout through this. */
  #probe(): InstallProbe {
    const fs = this.deps.workspace().fs;
    return {
      // The plugin's own, which asks for the stub's `exists` and only falls back
      // to `stat` when there is none — the local `WorkspaceFilesystem` here being
      // exactly that case.
      exists: (path) => pathExists(fs, path),
      readFile: (path) => fs.readFile(path, "utf8")
    };
  }

  /**
   * Is this checkout's dependency tree in the workspace?
   *
   * Asked of the **workspace**, which is a read of this object's own SQLite: no
   * container, no round trip, and an answer while a container is starting or
   * gone. That is what lets the busiest path in the object consult it, and what
   * lets an install be armed for a workspace whose container has not run yet.
   *
   * Existence only. A pull that stopped halfway leaves a directory holding part
   * of a tree, and nothing here can tell that from a whole one — which is why
   * the fingerprint is written only once its pull completed, and why the
   * advisory that carries this says which way the ambiguity runs.
   */
  async treePresent(dir: string): Promise<boolean> {
    try {
      return await pathExists(this.deps.workspace().fs, `${dir}/node_modules`);
    } catch (err) {
      // A read of local SQLite that threw says nothing about the tree. Treat it
      // as absent: a redundant install costs time, a skipped one costs a
      // confusing failure.
      console.warn(`[${this.deps.tag()}] could not probe the dependency tree`, {
        id: this.deps.id(),
        dir,
        err: String(err)
      });
      return false;
    }
  }

  /**
   * Where the install last ran, for a caller that needs the path rather than the
   * state — `checkoutDir` falls back to it for a workspace that predates the
   * checkout record.
   */
  async context(): Promise<InstallContext | undefined> {
    return await this.#job.context();
  }

  /**
   * The record exactly as the job wrote it, with no staleness bound applied.
   *
   * {@link state} is what almost everything wants. This is for the one caller
   * that must not repair anything on the way past: the container-idle handler,
   * which only needs to know whether something is running before it destroys the
   * container underneath it.
   */
  async read(): Promise<InstallState> {
    return await this.#job.read();
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
  async start(req: { dir: string; repo?: string }): Promise<InstallState> {
    return this.#beginInstall(req, (handle) => {
      // Drained here, in this object, on nobody's step budget. The watchdog picks
      // it up if this isolate does not survive the command.
      this.deps.waitUntil(this.#drainInstall(handle));
    });
  }

  /**
   * The same install, drained **inside the caller** rather than after it.
   *
   * For the alarm, which owns no request: nothing it awaits can be cut short by a
   * response being sent, so the drain cannot be disposed out from under an
   * `npm ci` half-way through. Returns once the command has actually finished.
   */
  async #awaited(
    req: { dir: string; repo?: string },
    armedAt: number
  ): Promise<InstallState> {
    await this.#beginInstall(req, (handle) => this.#drainInstall(handle), {
      takeOverArmedAt: armedAt
    });
    return this.state();
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
    await this.deps.touch();
    await this.deps.ready();

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
    const current = await this.state();
    const claim = this.#job.claim(
      current,
      this.deps.timeoutMs(),
      opts?.takeOverArmedAt
    );
    if (!claim.ok) {
      console.info(`[${this.deps.tag()}] an install is already in flight`, {
        id: this.deps.id(),
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
    const full = this.deps.headroom();
    if (full) {
      console.error(
        `[${this.deps.tag()}] refusing to install: the workspace is full`,
        {
          id: this.deps.id(),
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
      this.deps.plan(),
      req.repo
    );

    if (resolution.kind === "skip") {
      const state: InstallState = {
        state: "skipped",
        reason: resolution.reason
      };
      await this.#job.write(state);
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
      console.info(`[${this.deps.tag()}] install skipped`, {
        id: this.deps.id(),
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
     * It does not say the tree is here: the two are written at different moments
     * — the fingerprint when an install's pull completes, the tree as that pull
     * lands — and a workspace can hold one without the other, either because it
     * predates the install or because a pull stopped partway. Skipping on the
     * fingerprint alone would skip exactly the install a missing tree needs
     * most, and the symptom is a subagent whose first `import` fails for no
     * visible reason.
     */
    const previous = await this.deps.storage.get<{ fingerprint: string }>(
      "install:completed"
    );
    if (
      fingerprint &&
      previous?.fingerprint === fingerprint &&
      (await this.treePresent(req.dir))
    ) {
      const state: InstallState = {
        state: "done",
        command: resolution.command,
        exitCode: 0,
        finishedAt: Date.now(),
        ms: 0,
        tail: "dependencies already installed for this lockfile"
      };
      await this.#job.write(state);
      return state;
    }

    const startedAt = Date.now();
    const state: InstallState = {
      state: "running",
      command: resolution.command,
      startedAt
    };
    await this.#job.write(state);
    await this.#job.putContext({
      dir: req.dir,
      // Kept so a reinstall the alarm drives — which has no caller to ask —
      // resolves the same command this one did. Without it a repository
      // with an `INSTALL_PLAN` override would silently fall back to the default
      // on every later run, installing a different tree than the first time.
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
    await this.#job.armWatch();

    let handle: WorkspaceRuntimeExecHandle<"utf8">;
    try {
      handle = await this.deps.workspace().runtime.exec(resolution.command, {
        id: INSTALL_EXEC_ID,
        cwd: req.dir,
        encoding: "utf8",
        timeoutMs: this.deps.timeoutMs()
      });
    } catch (err) {
      // The command never started, so nothing will ever drain it and no
      // re-attach can find it. Close the record here: a `failed` install is
      // recoverable — the subagent is told what happened and can run the command
      // itself — where a `running` one that nobody owns is not.
      console.error(`[${this.deps.tag()}] the install could not be started`, {
        id: this.deps.id(),
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
      await this.#job.write(failed);
      await this.#job.clearWatch();
      return failed;
    }

    await own(handle);

    return state;
  }

  /**
   * The dependency-tree probe, run only when its answer changes anything.
   *
   * It qualifies a `deps-broken` advisory and nothing else (see
   * `deriveAdvisories`), so outside that state there is nothing to learn and the
   * question is not asked. What it no longer needs is a cache: the probe reads
   * this object's own storage rather than a container, so the memo it used to
   * carry would save a SQL lookup at the cost of being wrong for a window.
   */
  async treePresentIfItMatters(install: InstallState): Promise<boolean> {
    if (install.state !== "failed") return false;
    const dir = (await this.#job.context())?.dir;
    if (!dir) return false;
    return await this.treePresent(dir);
  }

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
  async state(): Promise<InstallState> {
    const state = await this.#job.read();

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
    if (this.#job.isStale(state, this.deps.timeoutMs())) {
      const minutes = Math.round((Date.now() - state.startedAt) / 60_000);
      console.error(`[${this.deps.tag()}] abandoning a stale install`, {
        id: this.deps.id(),
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
      await this.#job.write(failed);
      await this.#job.clearWatch();
      return failed;
    }

    if (!this.#draining) {
      await this.#reattachInstall();
      return await this.#job.read();
    }
    return state;
  }

  /** True while this isolate holds the drain, so the watchdog leaves it alone. */
  #draining = false;

  async #drainInstall(
    handle: WorkspaceRuntimeExecHandle<"utf8">
  ): Promise<void> {
    this.#draining = true;
    const context = await this.#job.context();
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
    const generation = this.#job.generation(startedAt);
    let logged = false;
    const stillMine = async (): Promise<boolean> => {
      if (await generation.stillMine()) return true;
      if (!logged) {
        logged = true;
        console.warn(
          `[${this.deps.tag()}] discarding a superseded install drain`,
          {
            id: this.deps.id(),
            command,
            startedAt,
            current: (await this.#job.context())?.startedAt
          }
        );
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
        /**
         * Recorded on success **and** only once the tree has crossed.
         *
         * A failed install must not leave a fingerprint behind, or the next
         * checkout would decide the tree it never built is already good — and
         * an install whose pull is still outstanding is the same hazard wearing
         * a zero exit code. `sync.status` is the runtime saying which of those
         * this was; `pending` hands the write to the drain that finishes the
         * pull. See `#promoteFingerprint`.
         */
        const landed = result.sync.status === "complete";
        if (context?.fingerprint && landed) {
          await this.deps.storage.put("install:completed", {
            fingerprint: context.fingerprint,
            at: Date.now()
          });
        }
        // An install writes more than any other command — a dependency tree is
        // tens of thousands of files — so this is the pull most likely to need
        // more than its own bracket, and the one whose absence is felt by every
        // container that is handed the tree afterwards.
        if (!landed) await this.deps.armSync();
        console.info(`[${this.deps.tag()}] install finished`, {
          id: this.deps.id(),
          command,
          synced: landed,
          seconds: Math.round((Date.now() - startedAt) / 1000)
        });
        await this.#job.write({
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
        console.error(`[${this.deps.tag()}] install failed`, {
          id: this.deps.id(),
          command,
          exitCode: result.exitCode,
          seconds: Math.round((Date.now() - startedAt) / 1000),
          tail: truncateOutput(tail, 1000)
        });
        await this.#job.write({
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
      //
      // If it went away, nothing this isolate believes about it holds any more.
      if (execWasLost(err)) this.deps.forgetTrust();
      console.error(`[${this.deps.tag()}] install drain failed`, {
        id: this.deps.id(),
        command,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        err: String(err)
      });
      await this.#job.write({
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
      if (!generation.superseded()) await this.#job.clearWatch();
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
      const handle = await this.deps
        .workspace()
        .runtime.getExec(INSTALL_EXEC_ID, {
          encoding: "utf8",
          resume: "tail"
        });
      this.deps.waitUntil(this.#drainInstall(handle));
    } catch (err) {
      // The exec is gone entirely — the container was replaced under it. Say so
      // rather than leaving the gate closed forever; the next checkout starts a
      // new install, and `sb_exec` can run in the meantime.
      if (execWasLost(err)) this.deps.forgetTrust();
      console.warn(`[${this.deps.tag()}] could not re-attach to the install`, {
        id: this.deps.id(),
        err: String(err)
      });
      const context = await this.#job.context();
      await this.#job.write({
        state: "failed",
        command: context?.command ?? "(unknown)",
        finishedAt: Date.now(),
        error:
          "the install stopped without reporting — its container was most " +
          "likely replaced. Re-run it with sb_exec, or clone again to restart it."
      });
      await this.#job.clearWatch();
    }
  }

  /**
   * Record the fingerprint of an install whose tree has now landed.
   *
   * The skip condition reads this, and what it has to mean is "this object holds
   * the tree that lockfile produces" — not "an install exited 0 somewhere". The
   * two are written at different moments: the install ends when the command
   * exits, the tree arrives when its pull completes. Writing the fingerprint at
   * the first moment would let a later checkout skip the install on the
   * strength of a tree that never finished crossing.
   *
   * So the install writes it only when its own bracket reported the sync
   * complete, and a drain that finishes the job writes it here instead.
   */
  async promoteFingerprint(): Promise<void> {
    const state = await this.#job.read();
    if (state.state !== "done") return;
    const context = await this.#job.context();
    if (!context?.fingerprint) return;
    const previous = await this.deps.storage.get<{ fingerprint: string }>(
      "install:completed"
    );
    if (previous?.fingerprint === context.fingerprint) return;
    await this.deps.storage.put("install:completed", {
      fingerprint: context.fingerprint,
      at: Date.now()
    });
  }

  /**
   * The armed reinstall came due.
   *
   * `clearArmed` first and unconditionally: this handler runs for minutes, and
   * the stamp left in place is what a second arming would recognise as its own.
   * `startInstall`'s in-flight guard would catch a double, but the cheaper
   * answer is not to schedule one.
   */
  async onRun(): Promise<void> {
    const context = await this.#job.context();
    const armedAt = await this.#job.armedAt();
    await this.#job.clearArmed();
    if (!context?.dir || armedAt === undefined) return;

    const state = await this.#awaited(
      {
        dir: context.dir,
        ...(context.repo ? { repo: context.repo } : {})
      },
      armedAt
    );
    console.info(`[${this.deps.tag()}] armed reinstall finished`, {
      id: this.deps.id(),
      dir: context.dir,
      state: state.state
    });
  }

  /** The watchdog: an install still running that nobody is draining. */
  async onWatch(): Promise<void> {
    const state = await this.#job.read();
    if (state.state !== "running") return;
    // Still running and nobody draining it: this isolate is new since the
    // command started. Re-attach, and come back if it is still going.
    await this.#reattachInstall();
    await this.#job.armWatch();
  }
}

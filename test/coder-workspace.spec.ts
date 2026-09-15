import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { makeDoHelpers } from "@dynamicagents/core/testing";
import { getWorkspace } from "@cloudflare/computer";
import type { InstallState } from "@dynamicagents/plugins/computer";
import { INSTALL_PLAN } from "@/workspace/install-plan";
import { TRUST_CA_COMMAND } from "@/workspace/object";
import { SCRATCH_DIR } from "@/workspace/scratch";

/**
 * The install gate, and the two ways it used to hang forever.
 *
 * `running` is the only install state that **blocks work**: `sb_exec` waits on
 * it and then refuses to run anything. Every other state is a fact the subagent
 * can act on — so `running` is the one that must never outlive the command it
 * describes.
 *
 * It did, in production. A `runtime.exec` that threw on the container's
 * WebSocket left the record saying `running` with nothing draining it and no
 * watchdog armed; every `sb_exec` for the next half hour polled the gate, waited
 * ninety seconds and ran nothing, until the chunk hit the ten-minute step
 * timeout and Workflows retried it into the same wall. The task never reached a
 * terminal state and the gatekeeper never got its callback.
 *
 * Both tests below run **without a container**, which is not a limitation here
 * but the point: the pool cannot start one, so `runtime.exec` fails exactly the
 * way it failed in production.
 */

/** A fresh workspace per test — DO storage never leaks between them. */
const { freshStub: freshWorkspace } = makeDoHelpers(env.CODER_WORKSPACE);

/**
 * The same workspace, through a new stub, once a reclaim has reset it.
 *
 * A reclaim resets the isolate after it returns, and a stub connected to an
 * object that reset stays broken — every later call on it throws. A caller in
 * production gets a new stub per request, so this is what one sees.
 */
async function afterReclaim(stub: DurableObjectStub) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  return env.CODER_WORKSPACE.get(stub.id);
}

/** Read the raw install record, bypassing the staleness repair `advisories` applies. */
function storedInstall(stub: DurableObjectStub) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.get<InstallState>("install")
  );
}

/**
 * Put a checkout in the workspace — a directory with a `.git` in it, and nothing
 * else.
 *
 * **Separate from {@link seedNodeCheckout}, and keeping them separate is the
 * point.** A lockfile is what makes the install resolver act, so a fixture that
 * writes one takes the `run` branch; a fixture that does not takes `skip`. A
 * single helper doing both puts every workspace in this file on one of those
 * paths and leaves the other untested — and `skip` is the branch that decides
 * whether a repository can be worked in at all.
 *
 * So the two facts stay apart: this is a checkout, that is a checkout which
 * installs. Reach for the second only where the resolver has to act.
 */
async function seedGitCheckout(stub: DurableObjectStub, dir: string) {
  using ws = await getWorkspace(
    stub as unknown as Parameters<typeof getWorkspace>[0]
  );
  await ws.fs.mkdir(`${dir}/.git`, { recursive: true });
  // `.git` is a directory in a real checkout, but what the workspace probes for
  // is its presence, and a file is what a fixture can create in one call. It is
  // the same question either way: is there a git repository here.
  await ws.fs.writeFile(`${dir}/.git/HEAD`, "ref: refs/heads/main\n");
}

/** A checkout the install resolver will act on: git, plus a lockfile. */
async function seedNodeCheckout(stub: DurableObjectStub, dir: string) {
  await seedGitCheckout(stub, dir);
  using ws = await getWorkspace(
    stub as unknown as Parameters<typeof getWorkspace>[0]
  );
  await ws.fs.writeFile(`${dir}/package.json`, '{"name":"probe"}');
  await ws.fs.writeFile(`${dir}/package-lock.json`, '{"lockfileVersion":3}');
}

describe("the install gate", () => {
  it("reports failed, not running, when the command cannot be started", async () => {
    const stub = freshWorkspace("install-spawn");
    const dir = "/workspace/probe";
    await seedNodeCheckout(stub, dir);

    // The resolver now has a lockfile to act on, so `startInstall` gets all the
    // way to the spawn — where there is no container, which is precisely how it
    // failed in production.
    const state = await stub.startInstall({ dir });

    expect(state.state).toBe("failed");
    if (state.state === "failed") {
      expect(state.command).toBe("npm ci --no-audit --no-fund");
    }

    // And it is written down: a caller reading the record later has to see the
    // same answer this one got, or the gate closes behind it.
    expect((await storedInstall(stub))?.state).toBe("failed");
  });

  it("abandons a running record that is past its own timeout", async () => {
    const stub = freshWorkspace("install-stale");
    const limit = INSTALL_PLAN.timeoutMs ?? 20 * 60_000;

    // Seed the exact state production was stuck in: running, nobody draining
    // it, and long enough ago that the runtime would have killed the command.
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("install", {
        state: "running",
        command: "npm ci --no-audit --no-fund",
        startedAt: Date.now() - limit - 10 * 60_000
      } satisfies InstallState)
    );

    const [advisory] = await stub.advisories();

    expect(advisory?.kind).toBe("deps-broken");
    // The message is load-bearing — it is what the subagent reads instead of
    // waiting, so it has to say the command is not coming back.
    if (advisory?.kind === "deps-broken") {
      expect(advisory.error).toMatch(/not going to finish/);
    }

    // And it is written down, so the next `sb_exec` does not re-derive it.
    expect((await storedInstall(stub))?.state).toBe("failed");
  });

  /**
   * `repo_clone` starts the install, and a retried chunk starts it again —
   * three times in fifty seconds, in the run this test comes from. Each spawn
   * used the same exec id, so it displaced the last, and the displaced
   * command's drain was still attached: it then wrote *its* verdict over a
   * record describing an install that was still running. The subagent read a
   * "dependency install failed" belonging to a command that no longer existed.
   */
  it("resolves a running record before starting another install", async () => {
    const stub = freshWorkspace("install-reentry");
    const dir = "/workspace/probe";
    await seedNodeCheckout(stub, dir);

    const startedAt = Date.now() - 30_000;
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("install", {
        state: "running",
        command: "npm ci --no-audit --no-fund",
        startedAt
      } satisfies InstallState)
    );

    const state = await stub.startInstall({ dir });

    // The invariant: the pre-existing `running` is never simply ignored. It is
    // either confirmed live and handed back, or resolved — and here, with no
    // container to re-attach to, resolved is the honest answer.
    expect(state).not.toMatchObject({ state: "running", startedAt });
    // Whatever it decided, the record agrees. A returned verdict that differs
    // from the stored one is how the subagent ends up reading a result that
    // describes nothing.
    expect((await storedInstall(stub))?.state).toBe(state.state);
    // The guard's live path — returning the in-flight install untouched — needs
    // a real container to reach, since the record is verified rather than
    // trusted. It is covered end to end rather than here.
  });

  it("leaves a young running record alone", async () => {
    const stub = freshWorkspace("install-young");

    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("install", {
        state: "running",
        command: "npm ci --no-audit --no-fund",
        startedAt: Date.now() - 30_000
      } satisfies InstallState)
    );

    // Half a minute in, with no container to re-attach to. The re-attach fails
    // and says so — what must *not* happen is the staleness bound firing early
    // and declaring a healthy install dead thirty seconds after it started.
    const [advisory] = await stub.advisories();
    if (advisory?.kind === "deps-broken") {
      expect(advisory.error).not.toMatch(/not going to finish/);
    }
  });

  /**
   * The counterweight to the staleness bound: `skipped` means the resolver looked
   * and found nothing to install, so a missing `node_modules` is the correct and
   * permanent state rather than a symptom. Nothing should chase it.
   */
  it("leaves a checkout with nothing to install alone", async () => {
    const stub = freshWorkspace("install-skipped");

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("install", {
        state: "skipped",
        reason: "no package.json"
      } satisfies InstallState);
      await state.storage.put("install:context", {
        dir: "/workspace/probe",
        fingerprint: null,
        command: "(none)",
        startedAt: Date.now()
      });
    });

    // `deps-absent`, not silence: a session that finds no `node_modules` should
    // be told the host looked and there was nothing to install, rather than left
    // to wonder whether an install is still coming.
    expect(await stub.advisories()).toEqual([
      { kind: "deps-absent", reason: "no package.json" }
    ]);
  });

  /**
   * A `failed` record is never retried on its own.
   *
   * Re-driving it from the gate would loop rather than recover — the install
   * failed for a reason, and the reason is usually still there. It stays the
   * subagent's to act on, via the warning the gate renders in front of the next
   * command.
   */
  it("does not auto-retry a failed install", async () => {
    const stub = freshWorkspace("install-failed-sticky");

    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("install", {
        state: "failed",
        command: "npm ci --no-audit --no-fund",
        finishedAt: Date.now() - 30_000,
        error: "the container was unreachable"
      } satisfies InstallState)
    );

    // Reported whatever the `node_modules` probe says. That probe is `test -d`,
    // which the wreckage of a half-finished install satisfies just as well as a
    // healthy tree, so it qualifies the advisory rather than deleting it — and
    // the record itself is never rewritten to say something it did not observe.
    const advisories = await stub.advisories();
    expect(advisories.map((a) => a.kind)).toEqual(["deps-broken"]);
    expect((await storedInstall(stub))?.state).toBe("failed");
  });
});

/**
 * Arming the install the moment a cold container is seen.
 *
 * This is the *ordinary* second task, not an edge case. `node_modules` lives in
 * the container and dies with it; the install record lives in this object's
 * storage and does not. So once the container is reclaimed for idleness, a `done`
 * record describes a tree that is gone — and `startInstall` is only ever reached
 * from `repo_clone`, which a follow-up task never calls, because its checkout is
 * already here.
 *
 * That gap cost 99 seconds of `npm ci` inside a round. Closing it by probing from
 * the gate cost far more: the install was started from a poll that returned in
 * milliseconds, its drain died with that invocation, and the half-written tree
 * took a nine-minute task to unpick.
 *
 * So detection is a boolean read here, and the install itself belongs to the
 * alarm. These tests cover the detection; the alarm's own handler needs a
 * container and is covered end to end.
 */
/**
 * Where the work is — the question `checkoutDir()` answers, and the invariants
 * that make its answer worth acting on.
 *
 * Two properties, and each has a test here because each can be lost on its own:
 *
 * - **A checkout is recorded whether or not anything was installed into it.**
 *   The install resolver skips a checkout it finds nothing to do in, and that
 *   says nothing about whether there is a checkout. See `noteCheckout` in
 *   `src/workspace/object.ts` for why the two records are separate.
 * - **The answer is probed, not remembered.** A recorded path is where to look;
 *   `.git` being there is what makes it true. A session's cwd and the
 *   cancellation `git reset --hard` both act on it, and neither recovers from a
 *   confident wrong answer.
 */
describe("where the work is", () => {
  it("reports a checkout the install had nothing to do in", async () => {
    const stub = freshWorkspace("checkout-no-lockfile");
    const dir = "/workspace/spike";
    // A repository with a README and no `package.json` — the exact shape that
    // was permanently undelegatable.
    await seedGitCheckout(stub, dir);

    await stub.noteCheckout({ dir, kind: "repo", repo: "acme/spike" });
    const state = await stub.startInstall({ dir });

    // The install correctly has nothing to do...
    expect(state.state).toBe("skipped");
    // ...and that must not be the same thing as having nowhere to work.
    expect(await stub.checkoutDir()).toBe(dir);
  });

  /**
   * The claim being made is "there is a git repository at this path", not "this
   * path was written down once". Only a probe can support the first, and the
   * difference is what a session's cwd and a `git reset --hard` both depend on.
   */
  it("stops reporting a checkout that is no longer there", async () => {
    const stub = freshWorkspace("checkout-vanished");
    const dir = "/workspace/gone";
    await seedGitCheckout(stub, dir);
    await stub.noteCheckout({ dir, kind: "repo", repo: "acme/gone" });
    expect(await stub.checkoutDir()).toBe(dir);

    using ws = await getWorkspace(
      stub as unknown as Parameters<typeof getWorkspace>[0]
    );
    await ws.fs.rm(`${dir}/.git`, { recursive: true });

    // The record still says `dir`. The answer is `undefined` anyway, because the
    // record is where to look and `.git` is what makes it true.
    expect(await stub.checkoutDir()).toBeUndefined();
  });

  /**
   * The migration path. Workspaces deployed before the checkout record existed
   * hold an install context and nothing else, and they must keep answering until
   * their next clone writes a record — a fix that silently stranded every live
   * checkout would be its own outage.
   */
  it("still answers for a workspace that predates the record", async () => {
    const stub = freshWorkspace("checkout-legacy");
    const dir = "/workspace/legacy";
    await seedGitCheckout(stub, dir);

    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("install:context", {
        dir,
        fingerprint: null,
        command: "npm ci --no-audit --no-fund",
        startedAt: Date.now()
      })
    );

    expect(await stub.checkoutDir()).toBe(dir);
  });

  /**
   * A scratchpad is a repository whose remote is nowhere, and this is the line
   * where that claim has to hold: it has no install to write a context as a side
   * effect — a directory with no `package.json` is exactly what the resolver
   * skips — so without the record it could be created and never delegated into.
   * The feature is a live assertion of the fix.
   */
  it("reports a scratchpad the same way it reports a checkout", async () => {
    const stub = freshWorkspace("checkout-scratch");
    await seedGitCheckout(stub, SCRATCH_DIR);

    const noted = await stub.noteCheckout({
      dir: SCRATCH_DIR,
      kind: "scratch"
    });

    // `present` is the same probe the delegation will make, reported at the
    // moment the scratchpad is opened rather than a delegation later.
    expect(noted).toEqual({ dir: SCRATCH_DIR, present: true });
    expect(await stub.checkoutDir()).toBe(SCRATCH_DIR);
  });

  /** An empty workspace has nowhere to work, and must keep saying so. */
  it("reports nothing for a workspace nothing has been opened in", async () => {
    const stub = freshWorkspace("checkout-empty");
    expect(await stub.checkoutDir()).toBeUndefined();
  });
});

describe("arming a reinstall for a cold container", () => {
  const armed = (stub: DurableObjectStub) =>
    runInDurableObject(stub, (_instance, state) =>
      state.storage.get<number>("install:armed")
    );

  /** A workspace that installed successfully, before its container went away. */
  async function seedInstalled(stub: DurableObjectStub, dir: string) {
    // The checkout has to be here too, or the resolver finds no `package.json`,
    // answers `skip`, and the armed install proves nothing by never reaching a
    // spawn — which is exactly how the first draft of this passed while testing
    // half of what it claimed.
    await seedNodeCheckout(stub, dir);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("install", {
        state: "done",
        command: "npm ci --no-audit --no-fund",
        exitCode: 0,
        finishedAt: Date.now() - 60_000,
        ms: 80_000
      } satisfies InstallState);
      await state.storage.put("install:context", {
        dir,
        fingerprint: "stale",
        command: "npm ci --no-audit --no-fund",
        startedAt: Date.now() - 140_000
      });
    });
  }

  /** Touch the workspace the way anything reaching it does — via the stub hook. */
  async function touchWorkspace(stub: DurableObjectStub) {
    using ws = await getWorkspace(
      stub as unknown as Parameters<typeof getWorkspace>[0]
    );
    void ws;
  }

  /**
   * Wait for the armed install to reach a terminal state.
   *
   * The alarm fires promptly — promptly enough that a first draft of these tests
   * raced it and read `install:armed` after the handler had already consumed it.
   * That is the system working, so these assert the settled outcome rather than a
   * marker that is meant to be transient.
   */
  async function settled(stub: DurableObjectStub, ms = 5_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const state = await storedInstall(stub);
      if (state?.state !== "running") return state;
      if (Date.now() > deadline) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("arms on the first workspace access, and the alarm carries it out", async () => {
    const stub = freshWorkspace("arm-cold");
    await seedInstalled(stub, "/workspace/probe");

    // `getWorkspace` goes through `__getWorkspaceStub`, which is the hook — the
    // earliest point in a task, before any command runs.
    await touchWorkspace(stub);

    // `failed` is the whole assertion. Getting there means the record left
    // `done` (so arming happened) *and* something tried to spawn an install (so
    // the alarm ran it) — and with no container in the pool, a spawn cannot
    // succeed. The old code returned `done` here and let a doomed command run.
    expect((await settled(stub))?.state).toBe("failed");
  });

  /**
   * The bound on retrying, and it has to exist.
   *
   * Arming is naturally once-only for an install that *succeeds*: it leaves
   * `done` with the container up, so the `container.running` check short-circuits
   * everything after. A failing one has no such property — it lands back on
   * `failed` with the container still down, and `__getWorkspaceStub` is the
   * busiest entry point in the object, so without a cooldown it would re-arm on
   * essentially every tool call.
   *
   * This test is the one that caught that: extending arming to `failed` made it
   * fail, which is the whole reason `INSTALL_ARM_COOLDOWN_MS` exists.
   */
  it("does not re-arm again immediately after a failure", async () => {
    const stub = freshWorkspace("arm-cooldown");
    await seedInstalled(stub, "/workspace/probe");

    await touchWorkspace(stub);
    expect((await settled(stub))?.state).toBe("failed");
    const after = await storedInstall(stub);

    // Two more accesses, as a task would make dozens of.
    await touchWorkspace(stub);
    await touchWorkspace(stub);

    // Untouched: no new `running`, and the same terminal record as before.
    expect((await storedInstall(stub))?.state).toBe("failed");
    expect(await storedInstall(stub)).toStrictEqual(after);
    expect(await armed(stub)).toBeUndefined();
  });

  /**
   * A caller's very first task: nothing has ever been installed, so there is no
   * record of *where* to install. `repo_clone` and its `afterCheckout` hook own
   * this case, exactly as they always have.
   */
  /**
   * A failed install must not poison the workspace forever.
   *
   * Arming originally required `done`, and the gap showed up immediately: a run
   * whose install failed left that record behind, the next task declined to arm,
   * and it was rescued only because the parent happened to call `repo_clone`.
   * Without that coincidence the subagent is back to running `npm ci` by hand
   * inside the round — the thing all of this exists to prevent.
   */
  it("arms for a workspace whose last install failed", async () => {
    const stub = freshWorkspace("arm-after-failure");
    const dir = "/workspace/probe";
    await seedNodeCheckout(stub, dir);

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("install", {
        state: "failed",
        command: "npm ci --no-audit --no-fund",
        finishedAt: Date.now() - 60_000,
        error: "the container was unreachable"
      } satisfies InstallState);
      await state.storage.put("install:context", {
        dir,
        fingerprint: "stale",
        command: "npm ci --no-audit --no-fund",
        startedAt: Date.now() - 140_000
      });
    });

    await touchWorkspace(stub);

    /**
     * Asserting `failed` would prove nothing — the record went in `failed` and a
     * version that armed nothing would leave it that way. The *message* is what
     * discriminates: the seeded one is invented by this test, and only a real
     * spawn attempt replaces it with the one `#beginInstall` writes when the
     * container cannot be reached.
     */
    const state = await settled(stub);
    expect(state?.state).toBe("failed");
    if (state?.state === "failed") {
      expect(state.error).toMatch(/could not be started/);
      expect(state.error).not.toMatch(/the container was unreachable$/);
    }
    expect(await armed(stub)).toBeUndefined();
  });

  it("arms nothing when no install has ever run", async () => {
    const stub = freshWorkspace("arm-first-task");

    await touchWorkspace(stub);

    expect(await armed(stub)).toBeUndefined();
    expect((await storedInstall(stub))?.state ?? "idle").toBe("idle");
  });
});

/**
 * Reclaiming, and the weekly loop it used to run forever.
 *
 * `lastUsedAt` is written by `#touch()` and removed by the `deleteAll()` that
 * reclaiming performs — so a workspace that has *already* been reclaimed reads
 * exactly like one that was never used. Defaulting that to `0` made it look
 * idle since the epoch, which is maximally idle: every weekly sweep re-reclaimed
 * every workspace it had ever reclaimed, recreating storage just to empty it
 * again and logging a reclaim that did not happen. Both the candidate table and
 * the RPC work grew for the lifetime of the caller.
 */
describe("reclaiming an idle workspace", () => {
  it("reports nothing to do for a workspace nothing has ever used", async () => {
    const stub = freshWorkspace("never-used");

    const result = await stub.reclaimIfIdle();

    // Not `reclaimed: true` with an epoch-sized `idleMs`, which is what an
    // absent `lastUsedAt` used to produce.
    expect(result.reclaimed).toBe(false);
    expect(result.idleMs).toBe(0);
  });

  it("stays false however long the sweep waits", async () => {
    // The bug was not a threshold being too low — it was a missing record
    // reading as "idle forever", so no `maxIdleMs` could ever make it false.
    const stub = freshWorkspace("never-used-zero-threshold");

    expect((await stub.reclaimIfIdle(0)).reclaimed).toBe(false);
  });

  /**
   * The other half: a workspace that has been used is still reclaimable, so the
   * fix above cannot have been "never reclaim anything".
   */
  it("still reclaims one that was used and then went idle", async () => {
    const stub = freshWorkspace("used-then-idle");
    // `getWorkspace` is the busiest entry point and the one that touches.
    using ws = await getWorkspace(
      stub as unknown as Parameters<typeof getWorkspace>[0]
    );
    await ws.fs.mkdir("/workspace/repo", { recursive: true });

    // A zero threshold stands in for a week having passed.
    expect((await stub.reclaimIfIdle(0)).reclaimed).toBe(true);
    // And once emptied it reports nothing to do rather than reclaiming again,
    // which is the loop this whole describe exists for.
    const reclaimed = await afterReclaim(stub);
    expect((await reclaimed.reclaimIfIdle(0)).reclaimed).toBe(false);
  });
});

/**
 * The CA-trust command, which has no other way to be wrong safely.
 *
 * It is a shell script carried as a string and run in a container the suite
 * cannot reach, so the only failure that matters — it does not parse — would
 * otherwise surface as a workspace with no working TLS and a log line nobody
 * connects to a missing `\` .
 */
describe("the interception CA command", () => {
  const lines = TRUST_CA_COMMAND.split("\n");

  /**
   * A newline ends a command in sh, so an `&&` or `||` opening a line is a
   * syntax error rather than the continuation it looks like. The operators have
   * to trail. This is the exact mistake the first draft made.
   */
  it("never opens a line with a shell operator", () => {
    for (const line of lines) {
      expect(line.trimStart()).not.toMatch(/^(&&|\|\|)/);
    }
  });

  /**
   * The listing runs before, and outside, the `if`. When the CA is missing it is
   * the only evidence separating "mounted somewhere else" from "never
   * provisioned", which is the question the whole step exists to answer.
   */
  it("lists the directory whether or not the CA is there", () => {
    expect(lines[0]).toContain("ls -A /etc/cloudflare/certs");
    expect(TRUST_CA_COMMAND).toContain("NO CA AT");
  });
});

/**
 * When the CA gets installed, and the gap that made it not happen.
 *
 * The trust used to hang off `#beginInstall`, which quietly made it conditional
 * on the container also being due a dependency install. Those are not the same
 * question, and a `skipped` workspace is where they come apart: the resolver
 * found nothing to install, so `#armInstallIfCold` deliberately never arms, so
 * nothing ever calls `#beginInstall` again — and every command in every
 * replacement container runs against an untrusted CA, failing TLS with an error
 * that names no cause.
 *
 * These run **without a container**, like the rest of this file, so the trust
 * command cannot succeed. That is fine and is the point: what regressed was
 * whether it is *attempted*, and an attempt is observable either way.
 */
describe("trusting the interception CA", () => {
  /** Every outcome of the trust step logs; a skipped one logs nothing at all. */
  function attempts(calls: unknown[][]): number {
    return calls.filter(([msg]) =>
      String(msg).includes("trust the interception CA")
    ).length;
  }

  it("happens for a workspace with nothing to install", async () => {
    const stub = freshWorkspace("ca-skipped-install");

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("install", {
        state: "skipped",
        reason: "no package.json"
      } satisfies InstallState);
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      using ws = await getWorkspace(
        stub as unknown as Parameters<typeof getWorkspace>[0]
      );
      void ws;
      expect(attempts(warn.mock.calls)).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * `#beginInstall` returns early when the workspace is full, and the old call
   * site sat below that return — so the one situation where the agent most needs
   * working egress to dig itself out was the one that never got a CA. Reaching
   * the object at all is now enough.
   */
  it("happens before anything that can refuse an install", async () => {
    const stub = freshWorkspace("ca-before-refusals");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      using ws = await getWorkspace(
        stub as unknown as Parameters<typeof getWorkspace>[0]
      );
      void ws;
      // No checkout, no install record, nothing armed — the paths that used to
      // carry the trust are all inert here.
      expect(await storedInstall(stub)).toBeUndefined();
      expect(attempts(warn.mock.calls)).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * What the scheduler rewrite could break quietly, and what a passing suite would
 * not otherwise notice.
 *
 * A schedule is a row the scheduler mints an id for, not a keyed upsert, so
 * moving a deadline leaves a second row unless it cancels the first. `#touch()`
 * runs on every entry point, which makes this the busiest path in the object and
 * the one where an extra row per call compounds fastest.
 *
 * Counted through storage rather than through a scheduler handle, because the
 * count is the durable consequence and a handle would only report what the code
 * under test already believes.
 */
/**
 * The scheduler's rows, read from storage. A schedule is a row in the lifecycle's
 * job queue under the scheduler's capability, its callback name in `fn`. No
 * table at all is no rows: storage that was just wiped has not had the queue
 * recreated yet.
 */
function scheduleRows(
  state: DurableObjectState
): { id: string; callback: string }[] {
  const [table] = state.storage.sql
    .exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_jobs'"
    )
    .toArray();
  if (!table) return [];
  return state.storage.sql
    .exec<{ id: string; callback: string }>(
      "SELECT id, fn AS callback FROM cf_agents_jobs WHERE capability = 'scheduler'"
    )
    .toArray();
}

describe("the idle deadlines, over a scheduler that has no upsert", () => {
  /** The same hook anything reaching this object goes through. */
  async function touch(stub: DurableObjectStub) {
    using ws = await getWorkspace(
      stub as unknown as Parameters<typeof getWorkspace>[0]
    );
    void ws;
  }

  const schedules = (stub: DurableObjectStub) =>
    runInDurableObject(stub, (_instance, state) => scheduleRows(state));

  it("keeps one row per deadline however often the workspace is touched", async () => {
    const stub = freshWorkspace("touch-repeatedly");

    await touch(stub);
    const afterOne = await schedules(stub);

    await touch(stub);
    await touch(stub);
    await touch(stub);
    const afterFour = await schedules(stub);

    // The two idle timers, and no more of them for three further touches.
    expect(afterFour).toHaveLength(afterOne.length);
    const callbacks = afterFour.map((row) => row.callback).sort();
    expect(callbacks).toContain("idleReclaim");
    expect(callbacks).toContain("containerIdle");
  });

  /**
   * Concurrent touches, which is the case that actually happens: several
   * subagents reach one workspace at once, and each entry point moves both
   * deadlines. A move is read-cancel-create-write across several awaits, so if
   * two interleaved they could cancel the same row, create two replacements and
   * keep one id — leaving a schedule nothing can reach.
   *
   * They do interleave: the input gate closes while a storage operation is in
   * flight, not for the stretch between two of them. So `namedDeadline`
   * serializes moves per key, and this is the end-to-end half of proving it —
   * the deterministic unit lives in core, and this shows the object really gets
   * it, through a real Durable Object under concurrent RPCs.
   *
   * Worth having both, because this one passes on timing alone when the
   * serialization is missing. It only failed in a full-suite run.
   */
  it("keeps one row per deadline under concurrent touches", async () => {
    const stub = freshWorkspace("touch-concurrent");

    await Promise.all([
      touch(stub),
      touch(stub),
      touch(stub),
      touch(stub),
      touch(stub),
      touch(stub),
      touch(stub),
      touch(stub)
    ]);

    const rows = await schedules(stub);
    const byCallback = rows.map((row) => row.callback).sort();
    expect(byCallback.filter((c) => c === "idleReclaim")).toHaveLength(1);
    expect(byCallback.filter((c) => c === "containerIdle")).toHaveLength(1);
  });

  it("moves the deadline rather than adding beside it", async () => {
    const stub = freshWorkspace("touch-moves");

    await touch(stub);
    const first = await schedules(stub);
    const firstIdle = first.find((row) => row.callback === "idleReclaim");
    expect(firstIdle).toBeDefined();

    await touch(stub);
    const second = await schedules(stub);
    const secondIdle = second.find((row) => row.callback === "idleReclaim");

    // A different row, not a second one: the id changes because the deadline was
    // cancelled and recreated, and the count does not.
    expect(secondIdle).toBeDefined();
    expect(secondIdle!.id).not.toBe(firstIdle!.id);
    expect(second.filter((row) => row.callback === "idleReclaim")).toHaveLength(
      1
    );
  });

  /**
   * A reclaimed workspace must not wake again, and must still work if it is
   * used again.
   *
   * `deleteAll()` takes the lifecycle's job queue table with it, and an
   * instance that has already created that table will not create it again. So
   * a touch on the same instance after a reclaim schedules against a table that
   * is no longer there, and the workspace stops arming its timers for good. The
   * reclaim resets the isolate so that the next call is a fresh instance, and
   * this test is what pins that the fresh instance schedules.
   */
  it("leaves no schedule behind after a reclaim, and still schedules after one", async () => {
    const stub = freshWorkspace("reclaim-clears");
    await touch(stub);
    expect((await schedules(stub)).length).toBeGreaterThan(0);

    expect((await stub.reclaimIfIdle(0)).reclaimed).toBe(true);
    const reclaimed = await afterReclaim(stub);
    expect(await schedules(reclaimed)).toHaveLength(0);

    await touch(reclaimed);
    const again = (await schedules(reclaimed))
      .map((row) => row.callback)
      .sort();
    expect(again).toContain("idleReclaim");
    expect(again).toContain("containerIdle");
  });
});

/**
 * Booting on what the predecessor left behind, since there is no migration.
 *
 * Deployed objects hold a KV row called `"wake"` carrying every deadline, and a
 * physical alarm armed against it. Nothing reads that row here, so an object
 * upgraded mid-install boots with all of it still on disk: a `running` install
 * record, an `install-run` entry in that row pointing at it, and an alarm that
 * fires once into a handler with no schedule rows behind it.
 *
 * The intent is orphaned — nothing reads that row any more — so the question is
 * not whether the wake-up is lost (it is) but whether the object recovers. It
 * does, through the staleness bound, which is the mechanism that already exists
 * for "the isolate that owned this is gone". An orphaned intent is exactly that
 * case, so the upgrade needs no drain of its own.
 */
describe("an object upgraded mid-install", () => {
  it("recovers a running record whose wake intent the upgrade orphaned", async () => {
    const stub = freshWorkspace("upgraded-mid-install");
    const limit = INSTALL_PLAN.timeoutMs ?? 20 * 60_000;

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("install", {
        state: "running",
        command: "npm ci --no-audit --no-fund",
        startedAt: Date.now() - limit - 10 * 60_000
      } satisfies InstallState);
      // The legacy row, carrying the entry that would have run the install.
      await state.storage.put("wake", {
        "install-run": { key: "install-run", notBefore: Date.now() - 60_000 },
        "install-watch": {
          key: "install-watch",
          notBefore: Date.now() - 30_000
        }
      });
      // And the alarm it armed, already due.
      await state.storage.setAlarm(Date.now() - 1_000);
    });

    // The stale alarm fires into a lifecycle with no schedule rows. It must be a
    // no-op that does not throw: a throwing `alarm()` is retried a bounded number
    // of times and then abandoned, taking every future schedule with it.
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.alarm()).resolves.toBeUndefined();
    });

    // The record is not stranded. `arm()` refuses `running`, so recovery is the
    // staleness bound writing the only accurate thing left to say.
    const [advisory] = await stub.advisories();
    expect(advisory?.kind).toBe("deps-broken");
    expect((await storedInstall(stub))?.state).toBe("failed");

    // And the object schedules again afterwards, rather than being poisoned by
    // what it found.
    using ws = await getWorkspace(
      stub as unknown as Parameters<typeof getWorkspace>[0]
    );
    void ws;
    const rows = await runInDurableObject(stub, (_instance, state) =>
      scheduleRows(state)
    );
    expect(rows.map((row) => row.callback)).toContain("idleReclaim");
  });

  /** The orphaned row is left in place rather than drained. Pinned, not assumed. */
  it("leaves the orphaned row untouched", async () => {
    const stub = freshWorkspace("upgraded-orphan");
    const leftover = {
      "container-idle": { key: "container-idle", notBefore: Date.now() }
    };
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("wake", leftover)
    );

    using ws = await getWorkspace(
      stub as unknown as Parameters<typeof getWorkspace>[0]
    );
    void ws;

    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.get("wake")
      )
    ).toEqual(leftover);
  });
});

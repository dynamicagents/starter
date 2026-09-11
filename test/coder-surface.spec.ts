import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  createAgentRuntime,
  MAX_TOOL_CALL_MS,
  TOOL_CALL_GRACE_MS,
  validateRecipe
} from "@dynamicagents/core";
import type { PluginHost } from "@dynamicagents/core/host";
import {
  SANDBOX_FAMILY,
  type ComputerConfig
} from "@dynamicagents/plugins/computer";
import { REPO_FAMILY } from "@dynamicagents/plugins/repo";
import { BROWSER_FAMILY } from "@dynamicagents/plugins/browser";
import {
  container,
  parentPlugins,
  subagentPlugins
} from "@/agents/coder/plugins";
import { CODER_CONFIG } from "@/config";

/**
 * The coder's tool surface, pinned.
 *
 * This agent is the one in this Worker whose parent and subagent install
 * **different** plugin lists: the parent orchestrates and reviews with git, a
 * browser and read-only eyes on the container, and every edit is delegated to a
 * subagent that holds the shell. That split is enforced by two things a
 * typechecker cannot see — an allowlist of tool *names* passed to
 * `restrictMainAgentTools`, and the fact that `validateRecipe` runs on the
 * **parent** and silently drops any family the parent did not register.
 *
 * Both fail quietly. A renamed tool leaves the parent missing one it thinks it
 * has; a plugin "tidied away" from the parent because the parent never calls it
 * deletes that family from every recipe the subagent runs. Neither breaks a
 * build, and both surface as a confused model mid-task. So they are asserted
 * here, on the assembled runtime, rather than trusted.
 */

/** A host in the shape the plugin lists take, over the test Worker's env. */
const host = (): PluginHost<Env> =>
  ({
    env,
    storage: undefined as unknown as DurableObjectStorage,
    callerKey: () => "test-caller",
    aiGatewayId: CODER_CONFIG.model.aiGatewayId ?? "default"
  }) as PluginHost<Env>;

const parent = () =>
  createAgentRuntime({ config: CODER_CONFIG, plugins: parentPlugins(host()) });

const subagent = () =>
  createAgentRuntime({
    config: CODER_CONFIG,
    plugins: subagentPlugins(host())
  });

const toolNames = async (runtime: ReturnType<typeof parent>) =>
  Object.keys(
    await runtime.mainAgentTools({
      session: { getCompactions: async () => [] } as never
    })
  ).sort();

describe("the main agent's tools", () => {
  /**
   * The exact list, not a subset check. A `toContain` here would pass just as
   * happily if `sb_exec` reappeared, which is the single thing this split
   * exists to prevent.
   */
  it("is git, a browser, and read-only access to the workspace", async () => {
    expect(await toolNames(parent())).toEqual([
      "browser_extract",
      "browser_links",
      "browser_markdown",
      "browser_scrape",
      "repo_clone",
      "repo_commit",
      "repo_diff",
      // The three that read and write the forge's own state. They are the
      // parent's for the same reason the rest of git is: the subagent holds the
      // shell and must not also speak for this agent in public.
      "repo_issue_view",
      "repo_open_pr",
      "repo_pr_comment",
      "repo_pr_view",
      "repo_push",
      "repo_status",
      "sb_exists",
      "sb_ls",
      "sb_read",
      // The parent's other way to answer "where does this task happen" — a
      // scratchpad rather than a checkout. It sits with the parent because it is
      // a workspace *selection*: a subagent holding it could re-point the
      // workspace mid-run. It brings no shell with it; see the case below.
      "scratch_open"
    ]);
  });

  it("has no way to run a command, write a file, or edit one", async () => {
    const names = await toolNames(parent());
    for (const forbidden of ["sb_exec", "sb_write", "sb_edit"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  /**
   * The plugin's own capability block advertises its whole surface. Left in
   * place it would tell the parent it has a shell, and a model told that spends
   * a turn discovering otherwise — then reaches for the obvious workaround,
   * which is doing the work itself.
   */
  it("is not told about the tools it no longer has", () => {
    const capabilities = parent().renderCapabilities();
    expect(capabilities).not.toContain("sb_exec");
    expect(capabilities).toContain("sb_read");
  });
});

describe("the subagent's tools", () => {
  it("registers the shell and the browser, and no git", () => {
    const families = [...subagent().policy.knownToolFamilies].sort();
    expect(families).toEqual([BROWSER_FAMILY, SANDBOX_FAMILY].sort());
    expect(families).not.toContain(REPO_FAMILY);
  });

  /**
   * `RecipeSubagentBase` re-checks `types.validateParams(request.type, …)` on
   * its inbound request, so a subagent whose registry has never heard of `code`
   * fails every execution with `unknown subtask type: code` — before a single
   * model call, and with nothing in the transcript to explain it.
   */
  it("knows the subtask type it is asked to execute", () => {
    expect(subagent().types.keys).toEqual(["code"]);
  });
});

describe("the recipe the parent hands down", () => {
  /**
   * The load-bearing one. `validateRecipe` runs on the parent
   * (`round/agent.ts`) and drops families the *parent* did not register, so the
   * parent must install `sandbox` and `browser` even though it uses almost
   * nothing from them. Deleting either from `parentPlugins` as "unused" would
   * take it away from the subagent instead.
   */
  it("survives validation on the parent with both families intact", () => {
    const runtime = parent();
    const validated = validateRecipe(
      runtime.types.resolveRecipe("code"),
      runtime.policy
    );

    expect(validated.toolFamilies.sort()).toEqual(
      [SANDBOX_FAMILY, BROWSER_FAMILY].sort()
    );
  });

  it("does not lend the subagent the parent's git tools", () => {
    const runtime = parent();
    const validated = validateRecipe(
      runtime.types.resolveRecipe("code"),
      runtime.policy
    );

    // The parent registers `repo` and uses all six of its tools. The recipe
    // must still not name that family: a subagent sharing the parent's checkout
    // must not also share its ability to rewrite the history.
    expect(runtime.policy.knownToolFamilies).toContain(REPO_FAMILY);
    expect(validated.toolFamilies).not.toContain(REPO_FAMILY);
  });
});

describe("the verification rule the subagent runs under", () => {
  /**
   * A production run edited a README, ran `prettier --check` on that one file,
   * and reported the change verified — nothing was installed and the project's
   * own gate never ran. The old wording asked for "the project's own tests and
   * linters", a standard with no command attached.
   *
   * The install half of that is now a mechanism rather than a sentence — the
   * host runs it and `sb_exec` gates on it. The gate half is still prose, so it
   * is still pinned here.
   */
  it("names the gate as commands, not as a goal", () => {
    const soul = subagent().types.resolveRecipe("code").soul;

    // No longer "run npm ci": the host installs before the subagent starts, so
    // the soul's job changed from issuing that command to explaining what to do
    // when it is still running. Asserting the old string would now pin prose
    // that describes a rule the mechanism enforces.
    expect(soul).toContain("Dependencies are installed for you");
    expect(soul).toContain("npm run check");
    expect(soul).toContain("npm test");
  });
});

/**
 * The container settings, which two call sites have to agree on.
 *
 * `agent.ts`'s cancel path used to build its own `ComputerConfig` with only
 * `binding` and `workspaceName`, so a cancellation's `git reset` ran under a
 * different shell than every other command in the same container — `withShell`
 * passes a command through *unwrapped* when no shell is set. It is one exported
 * function now, and this is what stops it being two again.
 */
describe("the container config", () => {
  it("carries the settings every path depends on", () => {
    const config = container(env, () => "caller|owner/repo");

    // `bash`, not the image's dash: a model writing shell writes bash, and a
    // subagent once lost two minutes to `${PIPESTATUS[0]}` failing under dash.
    expect(config.shell).toBe("bash");
    expect(config.cwd).toBe("/workspace");
    expect(config.workspaceName()).toBe("caller|owner/repo");
    // Why the pair must stay under the call's signal: see COMMAND_TIMEOUT_MS in
    // src/workspace/container.ts.
    expect(config.installGateMs).toBeGreaterThan(0);
    expect(config.timeoutMs).toBeGreaterThan(0);
    expect(
      (config.installGateMs ?? Infinity) + (config.timeoutMs ?? Infinity)
    ).toBeLessThan(MAX_TOOL_CALL_MS - TOOL_CALL_GRACE_MS);
  });

  it("is the same shape whichever name it is given", () => {
    const a = container(env, () => "one");
    const b = container(env, () => "two");

    // Everything but the two that legitimately differ per workspace.
    const shape = ({
      workspaceName: _name,
      binding: _binding,
      ...rest
    }: ComputerConfig) => rest;
    expect(shape(a)).toEqual(shape(b));
  });
});

describe("what the main agent asks a person before doing", () => {
  it("holds everything that publishes to GitHub, and nothing else", async () => {
    // The coder is the agent that pushes, so it is the one that has to ask. An
    // allowlist rename that dropped a rule would let a push through unasked.
    const surface = await parent().mainAgentSurface({
      session: { getCompactions: async () => [] } as never
    });

    expect(Object.keys(surface.toolApproval).sort()).toEqual([
      "repo_open_pr",
      "repo_pr_comment",
      "repo_push"
    ]);
  });
});

import { definePlugin, type AgentPlugin } from "@dynamicagents/core";
import {
  SANDBOX_FAMILY,
  WORKSPACE_RUNTIME_KEY
} from "@dynamicagents/plugins/computer";
import { BROWSER_FAMILY } from "@dynamicagents/plugins/browser";

/**
 * The `code` subtask type — a plugin this repo writes rather than installs.
 *
 * Same shape as `reactive/general.ts`, and for the same reason: a subagent soul
 * is an identity, and `validateRecipe` refuses to lend one, so it belongs to the
 * agent that chose it rather than to a library.
 *
 * Unlike reactive's `general`, this type is not an option the parent weighs — it
 * is the *only* way work gets done here. The parent has no shell, no writer and
 * no editor; see `plugins.ts` for why the context economics make that the right
 * shape. The guidance below therefore reads as "how to write a brief", not
 * "whether to delegate".
 */

/**
 * The soul for the code recipe.
 *
 * A subagent has no Session, no durable memory and no view of the parent's
 * conversation, so it is told to work only from its brief. It *does* share the
 * container: the checkout the parent cloned is already there, which is why this
 * says so explicitly rather than letting the subagent clone a second copy.
 *
 * **This is the only place tool guidance can live for a subagent.** Core renders
 * plugin `capability` blocks into the *main* agent's soul and nowhere else, so a
 * subagent sees tool descriptions and this text — nothing more. Anything the
 * executing model must know about how to work here has to be written here.
 */
export const CODE_SUBAGENT_SOUL = [
  "You are a stateless execution subagent working inside a shared workspace. You are given a single, self-contained engineering task with all necessary context supplied inline.",
  "The directory you are given already exists — a repository checkout, or a scratchpad for work that needs no repository. Do not clone or create it. Work in the directory your task names. It is durable and may hold work from an earlier task.",
  "`node_modules` is not: it lives on the container's disk, so a new container reinstalls it, and the file tools cannot see inside it. Use `sb_exec` to read or search there. It is a mount point, so `rm -rf node_modules` fails; `npm ci` clears it itself.",

  // The verification rule, held between two failures that pull opposite ways.
  //
  // Too loose and a standard with no command attached is satisfied by whichever
  // check is cheapest: a run edited a README, ran `prettier --check` on that one
  // file, and reported the change verified while the project's gate never ran.
  //
  // Too tight and it costs more than it catches. Mandating `npm run check` *and*
  // `npm test` on every subtask turned a one-line README edit into 59 minutes —
  // `check` here is five sequential tools including two full `tsc` runs, `npm
  // test` boots workerd, and the subagent ran both twice on half a vCPU, idle for
  // ~85% of the wall clock inside a single `sb_exec`.
  //
  // Hence two branches below, decided by blast radius rather than preference,
  // with CI as the backstop. There is deliberately **no third branch for
  // docs-only changes**: almost no real task is only a README, so it would buy a
  // rare case while adding a judgement call to every common one — and a wrong
  // answer there lands straight back on the first failure.
  "Dependencies are installed for you — the host starts the install when the repository is checked out, picking the command from the lockfile. You do not need to run it. If a command tells you the install is still running, nothing was run: wait a moment and call it again. If a command is prefixed with a warning that the install failed, that command did run and its output is real, but `node_modules` is missing or incomplete — re-run the install command named in the warning yourself before you trust any result that depends on it.",

  "Before you report done, verify your change at a scope that matches it. Which branch applies is decided by the files you edited, not by how confident you feel:",
  "- **Ordinarily:** run `npm run check` if `package.json` defines it, and run the spec that covers each file you touched — `npx vitest run <path to spec>`. Not the whole suite.",
  "A project's `check` script is usually several tools chained with `&&` — type generation, a formatter, a linter, one or more compiler passes. That chain stops at the first failure, so a non-zero exit tells you *that* something failed and never *which*, and the tools after it did not run at all. Read the output to find out. Exit 0 is the only outcome the code alone settles; anything else you have to look at.",
  "- **You changed something that reaches past the files you edited** — a shared type, an exported signature, a config or build file, a dependency: run the full `npm test` as well. This is the branch for a change whose blast radius you cannot see from the diff.",
  "To find the spec for a file, look for a co-located `*.spec.ts` next to it first (`src/round/turn.ts` → `src/round/turn.spec.ts`), then a similarly-named one under `test/`. If a file you changed has no spec, say so by name rather than escalating to the full suite or quietly running nothing.",
  "Running the full suite when the narrow branch applies is a real cost, not caution: it is minutes of container time per attempt, and it is what CI is for. Running a narrower check than the branch you are in is worse — that is reporting a change as verified when it was not.",
  "Say which branch you took, which commands you ran, and which specs. `npm test` was deliberately not run is a fine thing to report; it is silence about it that is not.",
  "If a check fails, fix it or stop and say exactly where you stopped and what the failure was. A change reported as done with a failing check costs the reviewer far more than an honest failure.",

  "Complete exactly that task and return a concise, factual result: what you changed, which files, and the commands you ran with their real outcomes.",
  "Your result is raw material, not a reply: a parent agent composes it into the change a reviewer eventually sees. You are never speaking to a user. No greeting, no preamble, no restating the task.",
  "Do not commit, push, or open a pull request — the parent owns the git history. Leave your changes in the working tree. You may read history with `git status`, `git diff` and `git log` through the shell.",
  "You have no memory of past conversations and no access to any conversation beyond the references provided. Do not ask follow-up questions; work only from what you are given.",
  "Never fabricate a tool result or a test outcome. The parent reads the diff against your report, and a report that does not match it is worse than no report."
].join("\n");

export interface CodeConfig {
  /**
   * The workspace name, resolved on the **parent**.
   *
   * Derived from the verified caller and the repository, and it must be read
   * here rather than inside the subagent: core gives a subagent execution a
   * `callerKey` thunk that throws ("a subagent execution has no caller
   * identity"), by design. See {@link resolveRuntime} below.
   */
  workspaceName: () => string;
}

export function code(config: CodeConfig): AgentPlugin {
  return definePlugin({
    key: "code",

    /**
     * Hand each subtask the container its parent is working in.
     *
     * This runs on the parent agent — core dispatches `resolveRuntime` to the
     * plugin that **declared** the subtask type, which is this one — so
     * `workspaceName()` resolves here and would throw in the facet. Whatever
     * this returns arrives at every tool family as `ToolFamilyContext.runtime`,
     * and `@dynamicagents/plugins/computer` reads the key back out of it with
     * `workspaceNameFromRuntime`.
     *
     * Without this, every delegated `code` subtask fails at its first tool call
     * with the caller-identity error, while the checkout it was told to work in
     * sits in a container it cannot name. The soul says "the repository checkout
     * already exists in the sandbox — do not clone it again"; this is what makes
     * that sentence true.
     *
     * It is deliberately not a subtask `param`: those are declared in the schema
     * below and rendered to the delegating model, so a container key there would
     * be model-authored — and a model naming another caller's key would get that
     * caller's container.
     */
    // Annotated rather than inferred: without it TypeScript narrows the
    // plugin's runtime generic to this one key, and every *other* family's
    // builder then fails to accept a plain `SubtaskRuntime`.
    resolveRuntime: async (): Promise<Record<string, unknown>> => ({
      [WORKSPACE_RUNTIME_KEY]: config.workspaceName()
    }),

    // There is deliberately **no `onAbort`** here, and it is worth saying so
    // because adding one looks like an obvious omission.
    //
    // `onAbort` fires per *subtask*, not per task, and every subtask of this
    // agent shares one container with the parent round. Tearing that container
    // down because one delegated subtask was cancelled would take the container
    // out from under the round that delegated it and every sibling still
    // running. Only a task-level moment can safely act, and `agent.ts` owns the
    // one that does: `onTaskCanceled`, which resets the working tree rather than
    // destroying anything — see `discardWorkingTree` in
    // `src/workspace/lifecycle.ts` for why that is the cleanup that survives.

    subtaskType: {
      key: "code",
      description:
        "A self-contained engineering task inside the existing checkout: implement a change, investigate a failure, or read an unfamiliar area and report how it works.",
      // No params, and resist adding one. Nothing here would read it:
      // `renderSubagentPrompt` builds its message from budget, task, references
      // and dependency results, so a param never reaches the subagent's prompt,
      // and the computer plugin takes the workspace off `runtime` rather than
      // off params — see `resolveRuntime` above. A required model-authored field
      // that nothing consumes can only fail a round; the subagent learns the
      // directory from prose in the brief, which is why its soul says "Work in
      // the directory your task names."
      //
      // `null` rather than an omitted key: the contract spells this case out —
      // "Required params for this type, or null when it takes none" — and
      // `validateParams` then refuses any param sent for this type, so a stray one
      // cannot ride along unread looking meaningful.
      params: null,
      recipe: {
        key: "code",
        version: 1,
        soul: CODE_SUBAGENT_SOUL,
        // Named families, not imported tools: `validateRecipe` drops any family
        // no installed plugin registered, so this degrades rather than breaks if
        // a plugin is uninstalled.
        //
        // **`repo` is deliberately absent.** A subagent sharing the parent's
        // checkout must not also share its history, and the previous "read-only
        // inspection" justification did not survive contact: the family arrives
        // whole or not at all, so `repo_commit` and `repo_push` were on the table
        // with nothing but prose between them and the model. `git status` and
        // `git diff` through `sb_exec` give the same information and carry no
        // credential.
        //
        // Both families here must also be registered by the *parent*'s plugin
        // list, because `validateRecipe` runs there first. See `plugins.ts`.
        toolFamilies: [SANDBOX_FAMILY, BROWSER_FAMILY],
        enabled: true,
        // Longer than the baseline: a subagent that has to boot a container and
        // run a test suite spends real time before it produces anything.
        limits: { maxTurns: 40, maxWallMs: 45 * 60_000 },
        // Wide, because a build log plus the file being edited is a lot of
        // context and a subagent that prunes its own transcript re-runs the
        // build to remember what failed.
        historyWindow: 96,
        // Worth the footer here, unlike `general`: these runs are slow and
        // expensive enough that knowing what one cost is actionable.
        reportMetrics: true
      },

      // A function, because core injects the live control-tool names rather than
      // letting prompt copy hard-code them and drift.
      //
      // Keep this consistent with the parent's surface in `plugins.ts`: the
      // parent has no shell, so copy that suggests doing the work itself would
      // send the model looking for tools it does not have.
      delegationGuidance: ({ delegateTool, finalReplyTool }) =>
        [
          `Every code change goes through a \`code\` subtask. You have no shell, no editor and no way to write a file — \`${delegateTool}\` is how work happens, and it is not a fallback for work that is too large.`,
          "Write the brief as you would for a capable engineer who has never seen this conversation: the goal, the constraints, and how to know it worked. Subagents cannot read your history, so anything that matters must be inline or in the references you select.",
          // Explicit because the brief is the *only* channel that carries it. A
          // subagent left to guess opens with `find / -maxdepth 3 -iname
          // README.md`, searching the filesystem root for its own repository.
          //
          // Both openers are named, because either can be the answer: a task
          // that needs no repository still needs somewhere to run.
          "State the working directory in the brief — the path `repo_clone` reported, e.g. `/workspace/slack-gatekeeper`, or the one `scratch_open` reported. A subagent that is not told where to work will go looking for it.",
          "Prefer one well-scoped subtask over several. Subagents share one checkout, so two of them editing the same files conflict rather than parallelise — split only along genuinely independent lines, such as investigating a failure in one module while another area is being read.",
          `Use \`${finalReplyTool}\` when the work is delivered and the pull request is open, or when you have to report honestly that it is not.`
        ].join("\n")
    }
  });
}

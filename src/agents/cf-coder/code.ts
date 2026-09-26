import type { SubAgentSpec } from "@dynamicagents/core";
import {
  WORKSPACE_RUNTIME_KEY,
  workspaceName
} from "@dynamicagents/plugins/workspace";
import { z } from "zod";
import { activeRepo } from "@/workspace/active-repo";

/**
 * The `code` sub-agent — a spec this repo writes rather than installs.
 *
 * Not an option the parent weighs: it is the *only* way work gets done here.
 * The parent has no shell, no writer and no editor; see `plugins.ts` for why the
 * context economics make that the right shape. The description below therefore
 * reads as "how to write a brief", not "whether to delegate".
 */

/**
 * The sub-agent's soul.
 *
 * It has no view of the parent's conversation, so it is told to work only from
 * its brief. It *does* share the container: the checkout the parent cloned is
 * already there, which is why this says so explicitly rather than letting it
 * clone a second copy.
 *
 * **This is the only place tool guidance can live for it** beyond the computer
 * plugin's own block. Anything the executing model must know about how to work
 * here has to be written here.
 */
export const CODE_SOUL = [
  "You are a sub-agent working inside a shared workspace. You are given a single, self-contained engineering task with all necessary context supplied inline.",
  "The directory you are given already exists — a repository checkout, or a scratchpad for work that needs no repository. Do not clone or create it. Work in the directory your task names. It is durable and may hold work from an earlier task.",
  "`node_modules` is not: it lives on the container's disk, so a new container reinstalls it, and the file tools cannot see inside it. Use `bash` to read or search there. It is a mount point, so `rm -rf node_modules` fails; `npm ci` clears it itself.",

  // The verification rule, held between two failures that pull opposite ways.
  //
  // Too loose and a standard with no command attached is satisfied by whichever
  // check is cheapest: a run edited a README, ran `prettier --check` on that one
  // file, and reported the change verified while the project's gate never ran.
  //
  // Too tight and it costs more than it catches. Mandating `npm run check` *and*
  // `npm test` on every run turned a one-line README edit into 59 minutes —
  // `check` here is five sequential tools including two full `tsc` runs, `npm
  // test` boots workerd, and the sub-agent ran both twice on half a vCPU, idle for
  // ~85% of the wall clock inside a single shell command.
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
  "You have no memory of past conversations and no access to any conversation beyond what the task says. Do not ask follow-up questions; work only from what you are given.",
  "Never fabricate a tool result or a test outcome. The parent reads the diff against your report, and a report that does not match it is worse than no report."
].join("\n");

/**
 * **Detached.** An implementation run boots a container, installs and runs a
 * test suite, and can outlast the fifteen minutes a turn may last; an awaited
 * run caught by the cut comes back "interrupted". So the call returns at once
 * and the result arrives as a later turn.
 */
export const CODE: SubAgentSpec<{ task: string }> = {
  name: "code",
  description: [
    "A self-contained engineering task inside the existing checkout: implement a change, investigate a failure, or read an unfamiliar area and report how it works.",
    "Every code change goes through this. You have no shell, no editor and no way to write a file — it is how work happens, and it is not a fallback for work that is too large.",
    "Write the task as you would for a capable engineer who has never seen this conversation: the goal, the constraints, and how to know it worked. The sub-agent cannot read your history, so anything that matters must be in the task.",
    // Explicit because the task is the *only* channel that carries it. A
    // sub-agent left to guess opens with `find / -maxdepth 3 -iname README.md`,
    // searching the filesystem root for its own repository.
    "State the working directory in the task — the path `repo_clone` reported, e.g. `/workspace/slack-gatekeeper`, or the one `scratch_open` reported. A sub-agent that is not told where to work will go looking for it.",
    "Prefer one well-scoped task over several. Sub-agents share one checkout, so two of them editing the same files conflict rather than parallelise — split only along genuinely independent lines, such as investigating a failure in one module while another area is being read."
  ].join("\n"),
  inputSchema: z.object({
    task: z
      .string()
      .describe(
        "The engineering task, with the working directory and everything needed to do it"
      )
  }),
  soul: CODE_SOUL,
  detached: true,
  formatInput: (input) => input.task,

  /**
   * Hand the run the container its parent is working in.
   *
   * On the parent, where the caller and the active repository are known, and
   * never in the run's input: the parent's model writes that, and a workspace
   * name there would let it name another caller's container.
   *
   * There is deliberately **no `settle`**. Every run shares one container with
   * the parent, so tearing it down for one run would take it out from under
   * the parent and every sibling. Only a task-level moment can safely act, and
   * `agent.ts` owns the one that does: `onTaskCanceled`.
   */
  prepare: async ({ parent }) => ({
    [WORKSPACE_RUNTIME_KEY]: workspaceName(
      parent.callerKey(),
      activeRepo(parent.storage).get()
    )
  })
};

import type { AgentPlugin, CoreConfigOverrides } from "@dynamicagents/core";
import type { PluginHost } from "@dynamicagents/core/host";
import {
  RoundAgentBase,
  type RoundPolicy,
  type SubagentClass
} from "@dynamicagents/core/round";
import { CODER_CONFIG } from "@/config";
import { roundPolicy } from "@/round-policy";
import { activeRepo } from "@/workspace/active-repo";
import { discardWorkingTree, sweepIdleWorkspaces } from "@/workspace/lifecycle";
import { workspaceName } from "@dynamicagents/plugins/computer-host";
import { parentPlugins } from "./plugins";
import { soulPrompt } from "./soul";
import { CoderSubagent } from "./subagent";

/** This agent's log prefix and workspace label. */
const LABEL = "coder";

/**
 * The coder agent.
 *
 * A delegating round agent like `reactive`: the loop, the durable Subtask rows
 * and the subagent execution are all `@dynamicagents/core/round`, and the model pair
 * is core's Workers AI default like every other agent here.
 *
 * What makes it the odd one out is the container underneath — so the overrides
 * below are all lifecycle, not inference: a weekly reclaim sweep for workspaces
 * nothing is calling into, and a working-tree reset when a task is cancelled.
 */
export class CoderAgent extends RoundAgentBase<Env> {
  protected agentConfig(): CoreConfigOverrides {
    return CODER_CONFIG;
  }

  /**
   * The **parent's** list, which is not the subagent's — see `plugins.ts`. This
   * agent orchestrates and reviews; it has git, a browser and read-only eyes on
   * the container, and no way to change a file.
   */
  protected agentPlugins(host: PluginHost<Env>): AgentPlugin[] {
    return parentPlugins(host);
  }

  protected agentSoul(capabilities: string): string {
    return soulPrompt(capabilities);
  }

  /** The words the loop says — shared with the other round agents. */
  protected roundPolicy(): RoundPolicy {
    return roundPolicy;
  }

  protected subagentClass(): SubagentClass {
    return CoderSubagent;
  }

  /**
   * Register the workspace reclaim sweep alongside core's own cleanup cron.
   *
   * A **backstop**, not the mechanism. Each workspace arms its own `idle-reclaim`
   * alarm on every use, and that is what normally fires — exactly seven days
   * after the last touch, with no registry and no help from here.
   *
   * What this covers is the one case the workspace cannot cover itself. A
   * throwing `alarm()` is retried a bounded number of times and then dropped
   * permanently, and `idle-reclaim` is the only intent that cannot heal on the
   * next RPC, because by definition nothing is calling in. So once a week this
   * pokes every workspace this caller has ever used and lets each decide.
   *
   * `super.onStart()` first: core registers its own weekly task cleanup there,
   * and both schedules coexist.
   */
  override async onStart(): Promise<void> {
    await super.onStart();
    const existing = await this.listSchedules({ type: "cron" });
    if (!existing.some((s) => s.callback === "reclaimIdleWorkspaces")) {
      // Sunday 02:00 UTC — an hour after core's, so the two never contend for
      // the same instance.
      await this.schedule("0 2 * * 0", "reclaimIdleWorkspaces", {});
    }
  }

  /**
   * Cron handler, delegating to the shared sweep.
   *
   * The body is in `@/workspace/lifecycle.ts` because `claude-coder` owes its
   * workspaces exactly the same thing, and a sweep whose whole job is to decide
   * *not* to act is the wrong code to have two copies of.
   */
  async reclaimIdleWorkspaces(): Promise<void> {
    await sweepIdleWorkspaces({
      host: this.pluginHost(),
      binding: this.env.CODER_WORKSPACE,
      label: LABEL
    });
  }

  /**
   * Discard a cancelled task's half-finished edits — without discarding the
   * workspace.
   *
   * The reasoning, and the reversal that produced it, is on
   * `discardWorkingTree` in `@/workspace/lifecycle.ts`. All that belongs here is
   * which workspace: the caller's, for the repository they were working on.
   */
  protected override async onTaskCanceled(taskId: string): Promise<void> {
    await super.onTaskCanceled(taskId);
    const active = activeRepo(this.pluginHost());
    const repo = active.get();
    await discardWorkingTree({
      binding: this.env.CODER_WORKSPACE,
      name: workspaceName(this.identityKeyOrTask(taskId), repo),
      repo,
      label: LABEL
    });
  }

  /**
   * The caller key, resilient to being called before a caller is known.
   *
   * `plugins.ts` keys workspaces on the verified caller, and cancellation can
   * arrive on an instance that has not served a turn yet — where `callerKey`
   * throws. Falling back to the task id is wrong-but-harmless: it addresses a
   * workspace nobody has ever used rather than someone else's.
   */
  private identityKeyOrTask(taskId: string): string {
    try {
      return this.pluginHost().callerKey();
    } catch {
      return taskId;
    }
  }
}

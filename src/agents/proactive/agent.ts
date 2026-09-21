import type { AgentPlugin, CoreConfigOverrides } from "@dynamicagents/core";
import type {
  GatekeeperIdentity,
  TurnPushContext
} from "@dynamicagents/core/a2a";
import { DynamicAgent, type PluginHost } from "@dynamicagents/core/host";
import { parseTurn, sessionMessage } from "@dynamicagents/core/agent";
import { noReplyTool, NO_REPLY_TOOL_NAME } from "@dynamicagents/plugins/triage";
import { MAX_STEPS, PROACTIVE_CONFIG } from "@/config";
import { proactive } from "./definition";
import { soulPrompt } from "./soul";
import { plugins } from "./plugins";
import { runTurn, type TurnOutcome } from "./loop";

/** User-facing text when a turn fails for an unexpected (non-transient) reason. */
const UNEXPECTED_REPLY =
  "Sorry — something went wrong while I was working on that.";

/**
 * The proactive agent: sees every message, decides whether each one is for it,
 * answers in a single turn.
 *
 * ## Why this file matters more than its size suggests
 *
 * It is the **second consumer**, and the evidence that core stopped at the right
 * place. Everything it shares with the round agents — the runtime built once per
 * instance, `AgentDB` over plugin stores, the session with its displacement
 * fan-out, the model pair, the task lifecycle — is `DynamicAgent`, and it is
 * shared because two genuinely different agents both needed it, not because one
 * happened to be written that way.
 *
 * Everything it does *not* share is the evidence: no `@dynamicagents/core/round` at
 * all. No Workflow round loop, no subagent facet, no delegation, no round budget,
 * and a turn that is allowed to end in silence. `npm run verify:isolation` asserts
 * that absence on the built module graph — this agent's bundle must not contain
 * core's delegation engine.
 *
 * The outer Worker reaches this DO with a single native Cloudflare RPC call —
 * `stub.converse(...)` — not HTTP: the DO is a private implementation detail of
 * the Worker, never exposed over the network.
 */
export class ProactiveAgent extends DynamicAgent<Env> {
  protected agentConfig(): CoreConfigOverrides {
    return { ...PROACTIVE_CONFIG, agentName: proactive.tenant };
  }

  protected agentPlugins(host: PluginHost<Env>): AgentPlugin[] {
    return plugins(host);
  }

  protected agentSoul(capabilities: string): string {
    return soulPrompt(capabilities);
  }

  /**
   * Answer one turn for this caller and return how it ended: a reply to deliver,
   * a deliberate `no_reply`, or `failed`. The workflow maps those onto the three
   * terminal Task shapes.
   *
   * ## Where a turn can decline
   *
   * **The gate, here.** Every plugin declaring `shouldHandleTurn` is consulted
   * before anything expensive is built or called, and the answers are AND-ed. The
   * user message is appended *first* — deliberately — so a message the agent
   * declines is still read into history: it follows the channel whether or not it
   * speaks, and the next message's gate needs this one for context.
   *
   * **The `no_reply` tool, in the loop.** The late counterpart: look something up,
   * then conclude there is nothing worth adding. The gate judges the message; the
   * tool judges what looking into it turned up.
   *
   * The union is returned whole rather than collapsed to a scalar: DO RPC
   * intersects every *object* return with `Disposable`, but that bound applies to
   * what a `step.do(...)` **returns**, not to what an RPC hands back inside one.
   * The workflow projects this union onto a fresh object literal within its step.
   *
   * `runTurn` never throws — it reports failure as `failed` rather than rejecting
   * — so this rejects only on a genuine RPC/transport fault.
   */
  async converse(
    text: string,
    identity: GatekeeperIdentity,
    push?: TurnPushContext
  ): Promise<TurnOutcome> {
    const session = this.getSession(identity);

    // Append **before** the gate, so a message the agent declines is still read
    // into history. The gate then judges a history that already includes the
    // message being judged — which is what makes an otherwise unclassifiable turn
    // ("yes", "thanks", "and the second one?") classifiable at all.
    await session.appendMessage(sessionMessage("user", text));
    const history = await session.getHistory();

    if (!(await this.runtime.shouldHandleTurn({ history }))) {
      return { kind: "no_reply" };
    }

    return runTurn({
      session,
      history,
      systemSuffix: this.callerContext(identity),
      tools: {
        ...(await this.runtime.mainAgentTools({ session })),
        // The late decline. Contributed here rather than by the plugin's
        // `mainAgentTools`, because whether it is on the call changes *within* a
        // turn — it is withdrawn the moment the agent speaks — and a plugin's
        // tool surface is resolved once, before the turn starts.
        [NO_REPLY_TOOL_NAME]: noReplyTool
      },
      models: this.modelPair({
        phase: "round",
        taskId: push?.taskId,
        channel: parseTurn(text)?.channel
      }),
      maxSteps: MAX_STEPS,
      unexpectedReply: UNEXPECTED_REPLY,
      // This agent runs exactly one turn per task, so the bare step index is a
      // safe notification key. An agent with rounds must include the round.
      onContent: push ? this.push(push).stream(String) : undefined
    });
  }
}

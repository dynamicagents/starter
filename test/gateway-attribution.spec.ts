import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AgentPlugin } from "@dynamicagents/core";
import type { TurnPushContext } from "@dynamicagents/core/a2a";
import type { PluginHost } from "@dynamicagents/core/host";
import { sessionMessage, type ModelPair } from "@dynamicagents/core/agent";
import { mockModel } from "@dynamicagents/core/testing";
import { reactive } from "@/agents/reactive/definition";
import { proactive } from "@/agents/proactive/definition";
import { arcPlayer } from "@/agents/arc-player/definition";
import { cfCoder } from "@/agents/cf-coder/definition";
import { claudeCoder } from "@/agents/claude-coder/definition";
import { plugins as proactivePlugins } from "@/agents/proactive/plugins";

/**
 * What AI Gateway is told about this Worker's model calls, observed on the
 * agents themselves.
 *
 * Every agent shares one gateway and one model pair, so the `agent` key is the
 * only thing in a log row that says which of them spent it. Losing it breaks
 * nothing: calls still succeed and the rows simply stop being attributable. So
 * each link is asserted where it is made — the name each Durable Object builds,
 * the plugins that forward it, and the turn that tags its own call.
 */

const TURN =
  '<turn from="Ada" id="U1" channel="C1" at="2026-09-17T10:00:00Z">anyone around?</turn>';

/** The host a Durable Object hands its plugins. `pluginHost` is protected. */
const hostOf = (instance: unknown) =>
  (instance as { pluginHost(): PluginHost<Env> }).pluginHost();

describe("the name each agent's calls are logged under", () => {
  it.each([reactive, proactive, arcPlayer, cfCoder, claudeCoder])(
    "is $tenant's tenant",
    async (definition) => {
      const stub = definition.resolveAgent(env, {
        key: `gateway-attribution:${definition.tenant}`
      });
      const name = await runInDurableObject(
        stub,
        (instance) => hostOf(instance).agentName
      );

      expect(name).toBe(definition.tenant);
    }
  );

  /**
   * A facet resolves its own config, and a subagent's calls are most of a
   * delegating agent's spend. The facet bindings exist only in this pool — see
   * `vitest.config.ts`.
   */
  it.each([
    ["REACTIVE_SUBAGENT", reactive.tenant],
    ["ARC_PLAYER_SUBAGENT", arcPlayer.tenant],
    ["CF_CODER_SUBAGENT", cfCoder.tenant],
    ["CLAUDE_CODER_SUBAGENT", claudeCoder.tenant]
  ])("is the parent's tenant on %s", async (binding, tenant) => {
    const namespace = (
      env as unknown as Record<string, DurableObjectNamespace>
    )[binding];
    const stub = namespace.get(namespace.idFromName("gateway-attribution"));
    const name = await runInDurableObject(
      stub,
      (instance) =>
        (
          instance as unknown as {
            subagentRuntime(): { agentName?: string };
          }
        ).subagentRuntime().agentName
    );

    expect(name).toBe(tenant);
  });
});

/**
 * A binding that records what each call asked of AI Gateway and answers like
 * the platform would: vectors for an embedding, a triage verdict for a chat.
 */
const recording = () => {
  const gateways: unknown[] = [];
  const AI = {
    run: async (
      _model: string,
      inputs: { text?: string[] },
      options: { gateway?: unknown }
    ) => {
      gateways.push(options.gateway);
      return inputs.text
        ? { data: inputs.text.map(() => [0, 0, 0]) }
        : {
            response: JSON.stringify({
              for_other_people: false,
              for_another_agent: false,
              can_contribute: true,
              should_reply: true,
              reason: "asked the room"
            })
          };
    }
  } as unknown as Ai;
  const VECTORIZE = {
    upsert: async () => ({}),
    query: async () => ({ count: 0, matches: [] })
  };
  return { AI, VECTORIZE, gateways };
};

/**
 * The agent's own host, over a recording `AI`. The pool's real binding cannot
 * reach a model and rejects outside any promise a spec can await, so nothing
 * here may touch it. The runtime is memoized over the host it was first built
 * with, hence the reset.
 */
const recordOn = (
  instance: unknown,
  bindings: ReturnType<typeof recording>
) => {
  const seams = instance as {
    pluginHost(): PluginHost<Env>;
    _runtime?: unknown;
  };
  const host = seams.pluginHost();
  const recorded: PluginHost<Env> = {
    ...host,
    env: {
      ...host.env,
      AI: bindings.AI,
      VECTORIZE: bindings.VECTORIZE
    } as unknown as Env,
    // Recall's namespace; no caller is verified in this pool.
    callerKey: () => "caller"
  };
  seams.pluginHost = () => recorded;
  seams._runtime = undefined;
  return recorded;
};

describe("the proactive agent's calls, at the binding", () => {
  it("tags recall's embeddings through the host the agent builds", async () => {
    const stub = proactive.resolveAgent(env, {
      key: "gateway-attribution:recall"
    });
    const gateways = await runInDurableObject(stub, async (instance) => {
      const bindings = recording();
      const recall = proactivePlugins(recordOn(instance, bindings)).find(
        (p: AgentPlugin) => p.key === "recall"
      );
      await recall?.onMessagesDisplaced?.([sessionMessage("user", TURN)]);
      return bindings.gateways;
    });

    expect(gateways).toEqual([
      { id: "default", metadata: { agent: "proactive", phase: "embed" } }
    ]);
  });

  it("tags a turn's gate, its compaction model and its own call", async () => {
    const identity = { key: "gateway-attribution:turn", name: "tester" };
    const push: TurnPushContext = {
      taskId: "task-1",
      contextId: "ctx-1",
      pushUrl: "https://gatekeeper.test/push",
      pushToken: "token",
      jku: "https://agent.test/.well-known/jwks.json"
    };
    const stub = proactive.resolveAgent(env, identity);

    const seen = await runInDurableObject(stub, async (instance) => {
      const bindings = recording();
      recordOn(instance, bindings);
      const pairs: unknown[] = [];
      const model = mockModel({ text: "hello" });
      const seams = instance as unknown as {
        modelPair(correlation?: unknown): ModelPair;
        push(): unknown;
      };
      // The pair is observed here rather than at the binding: what a
      // correlation becomes on the wire is core's, and asserted there.
      seams.modelPair = (correlation) => {
        pairs.push(correlation);
        return {
          primary: () => model,
          fallback: () => model,
          primaryId: () => "@cf/test/primary",
          fallbackId: () => "@cf/test/fallback"
        } as unknown as ModelPair;
      };
      // Captured rather than posted: there is no gatekeeper in this pool.
      seams.push = () => ({ stream: () => undefined });

      await instance.converse(TURN, identity, push);
      return { gateways: bindings.gateways, pairs };
    });

    expect(seen.gateways).toEqual([
      {
        id: "default",
        metadata: { agent: "proactive", phase: "triage", channel: "C1" }
      }
    ]);
    expect(seen.pairs).toEqual([
      { phase: "compaction" },
      { phase: "round", taskId: "task-1", channel: "C1" }
    ]);
  });
});

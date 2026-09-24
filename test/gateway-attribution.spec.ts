import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AgentPlugin } from "@dynamicagents/core";
import type { PluginHost } from "@dynamicagents/core/host";
import { sessionMessage } from "@dynamicagents/core/agent";
import { reactive } from "@/agents/reactive/definition";
import { cfCoder } from "@/agents/cf-coder/definition";
import { claudeCoder } from "@/agents/claude-coder/definition";
import { plugins as reactivePlugins } from "@/agents/reactive/plugins";

/**
 * What AI Gateway is told about this Worker's model calls, observed on the
 * agents themselves.
 *
 * Every agent shares one gateway and one model pair, so the `agent` key is the
 * only thing in a log row that says which of them spent it. Losing it breaks
 * nothing: calls still succeed and the rows simply stop being attributable. So
 * each link is asserted where it is made — the name each Durable Object builds,
 * and the plugins that forward it.
 */

const TURN =
  '<turn from="Ada" id="U1" channel="C1" at="2026-09-17T10:00:00Z">anyone around?</turn>';

/** The host a Durable Object hands its plugins. `pluginHost` is protected. */
const hostOf = (instance: unknown) =>
  (instance as { pluginHost(): PluginHost<Env> }).pluginHost();

describe("the name each agent's calls are logged under", () => {
  it.each([reactive, cfCoder, claudeCoder])(
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
 * the platform would for an embedding.
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
      return { data: (inputs.text ?? []).map(() => [0, 0, 0]) };
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

describe("the reactive agent's calls, at the binding", () => {
  it("tags recall's embeddings through the host the agent builds", async () => {
    const stub = reactive.resolveAgent(env, {
      key: "gateway-attribution:recall"
    });
    const gateways = await runInDurableObject(stub, async (instance) => {
      const bindings = recording();
      const recall = reactivePlugins(recordOn(instance, bindings)).find(
        (p: AgentPlugin) => p.key === "recall"
      );
      await recall?.onMessagesDisplaced?.([sessionMessage("user", TURN)]);
      return bindings.gateways;
    });

    expect(gateways).toEqual([
      { id: "default", metadata: { agent: "reactive", phase: "embed" } }
    ]);
  });
});

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { LanguageModel } from "ai";
import { generic } from "@/agents/generic/definition";
import { coding } from "@/agents/coding/definition";
import { anthropicCoding } from "@/agents/anthropic-coding/definition";

/**
 * What AI Gateway is told about this Worker's model calls, observed at the
 * binding.
 *
 * Every agent shares one gateway, so the `agent` key is the only thing in a log
 * row that says which of them spent it, and `phase` whether it was a turn, a
 * sub-agent or compaction. Losing either breaks nothing: calls still succeed
 * and the rows simply stop being attributable. So each class's real
 * `getModel()` is driven against a binding that records what it was asked.
 */

type V3 = Extract<LanguageModel, { specificationVersion: "v3" }>;

/** A binding that records what each call asked of AI Gateway. */
function recordingAI() {
  const gateways: unknown[] = [];
  const AI = {
    run: async (
      _model: string,
      _inputs: unknown,
      options: { gateway?: unknown }
    ) => {
      gateways.push(options.gateway);
      return {
        response: "ok",
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      };
    }
  } as unknown as Ai;
  return { AI, gateways };
}

/** Swap the object's `AI`, build a model with `build`, and make one call. */
async function gatewayOf(
  instance: unknown,
  build: (instance: never) => LanguageModel
): Promise<unknown> {
  const seams = instance as { env: Env };
  const real = seams.env;
  const { AI, gateways } = recordingAI();
  seams.env = { ...real, AI };
  try {
    const model = build(instance as never) as V3;
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    });
  } finally {
    seams.env = real;
  }
  return gateways[0];
}

const PARENTS = [generic, coding, anthropicCoding];

/** An agent's own object, by tenant. `resolveAgent` hands back its RPC shape. */
function parentStub(tenant: string, key: string) {
  const namespaces: Record<string, DurableObjectNamespace> = {
    [generic.tenant]: env.GenericAgent as unknown as DurableObjectNamespace,
    [coding.tenant]: env.CodingAgent as unknown as DurableObjectNamespace,
    [anthropicCoding.tenant]:
      env.AnthropicCodingAgent as unknown as DurableObjectNamespace
  };
  const ns = namespaces[tenant]!;
  return ns.get(ns.idFromName(key));
}

describe("an agent's calls", () => {
  it.each(PARENTS)("are $tenant's turns", async (definition) => {
    const stub = parentStub(
      definition.tenant,
      `gateway-attribution:${definition.tenant}`
    );
    const gateway = await runInDurableObject(stub, (instance) =>
      gatewayOf(instance, (agent: { getModel(): LanguageModel }) =>
        agent.getModel()
      )
    );
    expect(gateway).toEqual({
      id: "default",
      metadata: { agent: definition.tenant, phase: "turn" }
    });
  });

  it.each(PARENTS)(
    "are $tenant's compaction, with no task",
    async (definition) => {
      const stub = parentStub(
        definition.tenant,
        `gateway-attribution:compaction:${definition.tenant}`
      );
      const gateway = await runInDurableObject(stub, (instance) =>
        gatewayOf(instance, (agent: { compactionModel(): LanguageModel }) =>
          agent.compactionModel()
        )
      );
      expect(gateway).toEqual({
        id: "default",
        metadata: { agent: definition.tenant, phase: "compaction" }
      });
    }
  );
});

/**
 * A sub-agent's calls are most of a delegating agent's spend. The facet
 * bindings exist only in this pool — see `vitest.config.ts`. The Claude Code
 * sub-agents are absent: their model is a session, not a Workers AI call.
 */
describe("a sub-agent's calls", () => {
  it.each([
    ["GENERIC_GENERAL", "GenericChild", generic.tenant],
    ["CODING_CHILD", "CodingChild", coding.tenant]
  ])("are the parent's, as %s", async (binding, subAgent, tenant) => {
    const namespace = (
      env as unknown as Record<string, DurableObjectNamespace>
    )[binding]!;
    const stub = namespace.get(namespace.idFromName("gateway-attribution"));
    const gateway = await runInDurableObject(stub, (instance) =>
      gatewayOf(instance, (agent: { getModel(): LanguageModel }) =>
        agent.getModel()
      )
    );
    expect(gateway).toEqual({
      id: "default",
      metadata: { agent: tenant, phase: "subagent", subAgent }
    });
  });
});

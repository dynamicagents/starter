import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { LanguageModel } from "ai";
import { generic } from "@/agents/generic/definition";
import { coding } from "@/agents/coding/definition";
import { claudeCoordinator } from "@/agents/claude-coordinator/definition";
import { CLAUDE_COORDINATOR, CODING, GENERIC } from "@/config";

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

/** What one model call asked of the binding. */
interface Dispatch {
  model: string;
  gateway: unknown;
  /**
   * `returnRawResponse`, which only the catalog arm sets, and the prefix-cache
   * key, which only the Workers AI arm sends. Between them they are the whole
   * of what says which arm built the model: both arms pass the model id
   * through untouched and both pass a `gateway`, so neither of those tells
   * them apart. Each arm is wrong in its own silent way without these — a slug
   * on the Workers AI arm reaches a provider nothing serves, and a `@cf/` id on
   * the catalog arm still works but routes off its own re-sent prefix.
   */
  raw: boolean;
  affinity: unknown;
}

/**
 * A binding that records what each call asked of AI Gateway.
 *
 * Both of `src/model.ts`'s arms land here, and they want different answers: a
 * Workers AI id is called for its parsed output, while a catalog slug is
 * dispatched with `returnRawResponse` and parsed by an `@ai-sdk` provider, so
 * for that one the binding has to answer an HTTP response in the provider's own
 * wire format. No `cf-aig-run-id` on it, deliberately — the header is what puts
 * the delegate's resumable-stream engine in the path, and a resume has nothing
 * to do with what this spec is watching.
 */
function recordingAI() {
  const calls: Dispatch[] = [];
  const AI = {
    run: async (
      model: string,
      _inputs: unknown,
      options: {
        gateway?: unknown;
        returnRawResponse?: boolean;
        extraHeaders?: Record<string, string>;
      }
    ) => {
      const raw = options.returnRawResponse === true;
      calls.push({
        model,
        gateway: options.gateway,
        raw,
        affinity: options.extraHeaders?.["x-session-affinity"]
      });
      if (!raw) {
        return {
          response: "ok",
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        };
      }
      return Response.json({
        id: "chatcmpl-attribution",
        object: "chat.completion",
        created: 0,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      });
    }
  } as unknown as Ai;
  return { AI, calls };
}

/** Swap the object's `AI`, build a model with `build`, and make one call. */
async function callOf(
  instance: unknown,
  build: (instance: never) => LanguageModel
): Promise<Dispatch | undefined> {
  const seams = instance as { env: Env };
  const real = seams.env;
  const { AI, calls } = recordingAI();
  seams.env = { ...real, AI };
  try {
    const model = build(instance as never) as V3;
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    });
  } finally {
    seams.env = real;
  }
  return calls[0];
}

/** What one call told the gateway about itself. */
async function gatewayOf(
  instance: unknown,
  build: (instance: never) => LanguageModel
): Promise<unknown> {
  return (await callOf(instance, build))?.gateway;
}

const PARENTS = [generic, coding, claudeCoordinator];

/** An agent's own object, by tenant. `resolveAgent` hands back its RPC shape. */
function parentStub(tenant: string, key: string) {
  const namespaces: Record<string, DurableObjectNamespace> = {
    [generic.tenant]: env.GenericAgent as unknown as DurableObjectNamespace,
    [coding.tenant]: env.CodingAgent as unknown as DurableObjectNamespace,
    [claudeCoordinator.tenant]:
      env.ClaudeCoordinatorAgent as unknown as DurableObjectNamespace
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
 * Which of `src/model.ts`'s two arms each agent's turn takes.
 *
 * The id is read at the binding rather than off the built model, because for a
 * catalog slug the model's own `modelId` is the provider-native half (`gpt-…`)
 * and it is the whole slug that has to arrive for AI Gateway to route it. The
 * id alone would not catch an arm chosen wrongly, though — both arms pass it
 * through untouched — so what pins the arm is `Dispatch`'s other two fields,
 * one of which each arm sets and the other not.
 */
describe("an agent's turn model", () => {
  it.each([
    [generic.tenant, GENERIC, false],
    [coding.tenant, CODING, false],
    [claudeCoordinator.tenant, CLAUDE_COORDINATOR, true]
  ])(
    "reaches the binding as %s's configured id",
    async (tenant, tuning, catalog) => {
      const stub = parentStub(tenant, `turn-model:${tenant}`);
      const dispatch = await runInDurableObject(stub, (instance) =>
        callOf(instance, (agent: { getModel(): LanguageModel }) =>
          agent.getModel()
        )
      );
      expect(dispatch).toMatchObject({
        model: tuning.modelId,
        raw: catalog,
        affinity: catalog ? undefined : expect.any(String)
      });
    }
  );
});

describe("an agent's compaction", () => {
  it.each([
    [generic.tenant, GENERIC],
    [coding.tenant, CODING],
    [claudeCoordinator.tenant, CLAUDE_COORDINATOR]
  ])("runs %s on its compaction model", async (tenant, tuning) => {
    const stub = parentStub(tenant, `compaction-model:${tenant}`);
    const modelId = await runInDurableObject(
      stub,
      (instance) =>
        (instance as unknown as { compactionModel(): V3 }).compactionModel()
          .modelId
    );
    expect(modelId).toBe(tuning.compactionModelId);
  });
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

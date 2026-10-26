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
  /**
   * Which method on the binding the call arrived on: the Workers AI arm's id
   * is dispatched through `run`, while the catalog arm's slug goes down AI
   * Gateway's provider-native path, which is the binding's own `fetch`. It is
   * the transport each arm chose for the id it was given, so it separates the
   * two for the ids this Worker configures, and `returnRawResponse` no longer
   * does: that is set on every `run` whatever the id.
   *
   * It is **not** on its own enough to catch an id sent down the wrong arm. A
   * `@cf/` id handed to the catalog arm still arrives on `run`, because the
   * transport reads the id rather than the arm that built it. What catches that
   * is {@link Dispatch.affinity} against {@link Dispatch.cacheKey}: each arm
   * sends the object's name in its own place and neither sends the other's, so
   * a mismatch leaves both empty. Each arm is wrong in its own silent way
   * without that pair. A slug on the Workers AI arm reaches a provider nothing
   * serves, and a `@cf/` id on the catalog arm still answers but routes off its
   * own re-sent prefix, which is why `expectConfiguredId` asserts all of these
   * together rather than any one of them.
   */
  via: "run" | "fetch";
  /**
   * The configured id as the arm spells it to the gateway: whole on `run`, and
   * on the native path the provider taken from the route rejoined to the body's
   * own half, because between them they are what AI Gateway routes on.
   */
  model: string;
  gateway: unknown;
  affinity: unknown;
  /**
   * The catalog arm's prefix-cache key, which an `openai/*` slug sends in the
   * Responses body as `prompt_cache_key` rather than as a header.
   */
  cacheKey: unknown;
}

/**
 * The route the provider-native path addresses, as the binding's own `fetch`
 * spells it: `/ai-gateway/gateways/<id>/<provider>/<endpoint>`. The gateway id
 * and the provider are in the path and nowhere else, so they are read back from
 * it rather than from the body.
 */
function nativeRoute(url: string): {
  gateway: string;
  provider: string;
  endpoint: string;
} {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const at = parts.indexOf("gateways");
  return {
    gateway: decodeURIComponent(parts[at + 1] ?? ""),
    provider: parts[at + 2] ?? "",
    endpoint: parts.slice(at + 3).join("/")
  };
}

/**
 * A binding that records what each call asked of AI Gateway.
 *
 * Both of `src/model.ts`'s arms land here, on different methods and in
 * different wire formats, and each has to be answered in the one its caller
 * parses. A Workers AI id arrives on `run` with `returnRawResponse`, so that
 * answer is an HTTP response carrying Chat Completions. A catalog slug arrives
 * on `fetch`, against the gateway's provider-native route, and is answered in
 * the provider's own format: Responses for an `openai/*` slug, whose body
 * carries `input`. No `cf-aig-run-id` on either, deliberately: the header is
 * what puts the delegate's resumable-stream engine in the path, and a resume
 * has nothing to do with what this spec is watching.
 */
function recordingAI() {
  const calls: Dispatch[] = [];
  const AI = {
    run: async (
      model: string,
      inputs: Record<string, unknown>,
      options: {
        gateway?: unknown;
        extraHeaders?: Record<string, string>;
      }
    ) => {
      calls.push({
        via: "run",
        model,
        gateway: options.gateway,
        affinity: options.extraHeaders?.["x-session-affinity"],
        cacheKey: inputs.prompt_cache_key
      });
      return Response.json(
        "input" in inputs
          ? {
              id: "resp_attribution",
              object: "response",
              created_at: 0,
              status: "completed",
              model,
              output: [
                {
                  type: "message",
                  id: "msg_attribution",
                  role: "assistant",
                  status: "completed",
                  content: [
                    { type: "output_text", text: "ok", annotations: [] }
                  ]
                }
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
            }
          : {
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
            }
      );
    },
    fetch: async (url: string, init: RequestInit) => {
      const { gateway, provider } = nativeRoute(url);
      const headers = new Headers(init.headers);
      const body = JSON.parse(String(init.body ?? "{}")) as {
        model?: string;
        prompt_cache_key?: unknown;
      };
      const metadata = headers.get("cf-aig-metadata");
      calls.push({
        via: "fetch",
        model: `${provider}/${body.model ?? ""}`,
        // Rebuilt as the options object the other arm passes, because what this
        // spec is about is the attribution and not the transport: the id comes
        // from the route and the metadata from the header the gateway reads it
        // from. Another `cf-aig-*` option arriving would go unnoticed here, and
        // attribution moving off this header would not.
        gateway: {
          id: gateway,
          ...(metadata === null
            ? {}
            : { metadata: JSON.parse(metadata) as unknown })
        },
        affinity: headers.get("x-session-affinity") ?? undefined,
        cacheKey: body.prompt_cache_key
      });
      return Response.json({
        id: "resp_attribution",
        object: "response",
        created_at: 0,
        status: "completed",
        model: body.model,
        output: [
          {
            type: "message",
            id: "msg_attribution",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "ok", annotations: [] }]
          }
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
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

/**
 * That a call arrived as the id it was configured with, over the arm that id
 * names.
 *
 * The id is read at the binding rather than off the built model, because for a
 * catalog slug the model's own `modelId` is the provider-native half (`gpt-…`)
 * and it is the whole slug that has to arrive for AI Gateway to route it. The
 * id alone would not catch an arm chosen wrongly, though, since every arm
 * passes it through untouched. What catches that is the whole object asserted
 * at once, and the pair that carries the object's name is the part that bites:
 * {@link Dispatch.via} says which transport the id took, and
 * {@link Dispatch.affinity} against {@link Dispatch.cacheKey} says which arm
 * asked for it. Measured against the mismatch rather than assumed: forcing a
 * `@cf/` id onto the catalog arm leaves `via` reading `run`, and it is the
 * empty affinity that fails.
 */
function expectConfiguredId(
  dispatch: Dispatch | undefined,
  {
    modelId,
    name,
    catalog
  }: { modelId: string; name: string; catalog: boolean }
): void {
  expect(dispatch).toMatchObject({
    model: modelId,
    via: catalog ? "fetch" : "run",
    // The object's name on whichever arm, each in its own spelling.
    affinity: catalog ? undefined : name,
    cacheKey: catalog ? name : undefined
  });
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

/** Which arm of `src/model.ts` each agent's turn takes. */
describe("an agent's turn model", () => {
  it.each([
    [generic.tenant, GENERIC, false],
    [coding.tenant, CODING, false],
    [claudeCoordinator.tenant, CLAUDE_COORDINATOR, true]
  ])(
    "reaches the binding as %s's configured id",
    async (tenant, tuning, catalog) => {
      const name = `turn-model:${tenant}`;
      const stub = parentStub(tenant, name);
      const dispatch = await runInDurableObject(stub, (instance) =>
        callOf(instance, (agent: { getModel(): LanguageModel }) =>
          agent.getModel()
        )
      );
      expectConfiguredId(dispatch, { modelId: tuning.modelId, name, catalog });
    }
  );
});

/**
 * And which arm its compaction takes, which each agent chooses for itself: a
 * Workers AI turn may summarize on a larger Workers AI model, and a catalog
 * turn may summarize on the slug it already runs. So the arm is spelled per
 * agent here rather than inherited from the turn above.
 */
describe("an agent's compaction model", () => {
  it.each([
    [generic.tenant, GENERIC, false],
    [coding.tenant, CODING, false],
    [claudeCoordinator.tenant, CLAUDE_COORDINATOR, true]
  ])(
    "reaches the binding as %s's configured id",
    async (tenant, tuning, catalog) => {
      const name = `compaction-model:${tenant}`;
      const stub = parentStub(tenant, name);
      const dispatch = await runInDurableObject(stub, (instance) =>
        callOf(instance, (agent: { compactionModel(): LanguageModel }) =>
          agent.compactionModel()
        )
      );
      expectConfiguredId(dispatch, {
        modelId: tuning.compactionModelId,
        name,
        catalog
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

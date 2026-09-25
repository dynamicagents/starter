import { createA2AWorker, type MountedAgent } from "@dynamicagents/core/worker";
import type {
  AgentManifest,
  PlainTask,
  TaskAgent
} from "@dynamicagents/core/a2a";
import { Artifacts, handleArtifactRoute } from "@dynamicagents/core/artifacts";
import type { SpikeReactive } from "./agent";
import { SPIKE_TENANTS, type SpikeEnv } from "./env";

/**
 * The spike Worker: core's A2A edge in front of a Think agent, plus a handful
 * of debug routes so a deployed run can be driven and inspected without a
 * gatekeeper.
 *
 * The tenants are mounted **by hand** rather than with `defineAgent`, which
 * requires a Workflow binding: on Think there is no Workflow. What replaces it
 * is `startTurn` calling straight into the object, where a durable submission
 * takes over.
 */

// The Durable Object classes, resolved by name at runtime. `SpikeGeneral` is a
// facet: it needs no binding and no migration tag in production, only this
// export — but it does need a test-only binding, which `vitest.spike.config.ts`
// declares.
export { SpikeReactive } from "./agent";
export { SpikeGeneral } from "./child";
export { Artifacts };

const manifest: AgentManifest = {
  name: "da-think-spike",
  description:
    "The Think migration spike: the reactive agent on @cloudflare/think, behind " +
    "core's A2A edge. It runs a rule-based model and takes no real traffic.",
  version: "0.1.0",
  /**
   * `pushNotifications: false`, and the agent pushes anyway — **core owns
   * delivery**, and this field is what stops the a2a-js request handler from
   * having an opinion about it.
   *
   * Given `true`, `DefaultRequestHandler` stores the caller's push config in
   * its own in-memory store and fires a notification of its own for every event
   * it processes, fire-and-forget, carrying whatever task the executor
   * published. A dispatch retry publishes the task as it stands, so a redelivered
   * `messageId` on a finished task makes the handler re-send the terminal
   * snapshot — a second `completed` callback for one task, from a sender that
   * signs none of it.
   *
   * The real fix is a no-op `pushNotificationSender` as the handler's sixth
   * constructor argument, which only core can pass. Until it does, this is the
   * same effect reached from the one field a consumer controls. Core's own
   * `requirePushConfig` still refuses a send with nowhere to call back, so the
   * accept-and-notify contract is unchanged.
   */
  capabilities: { streaming: false, pushNotifications: false, extensions: [] },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: []
};

/**
 * One Durable Object per tenant per caller.
 *
 * The tenant is in the name, not just the namespace: every tenant here resolves
 * through the one `SpikeReactive` binding, so without it two scenarios run by
 * the same caller identity would share an object — and a turn queue.
 */
function objectFor(env: SpikeEnv, tenant: string, key: string) {
  return env.SpikeReactive.get(
    env.SpikeReactive.idFromName(`${tenant}/${key}`)
  );
}

const tenants: MountedAgent<SpikeEnv>[] = SPIKE_TENANTS.map((tenant) => ({
  tenant,
  manifest,
  resolveAgent(env, identity): TaskAgent {
    if (!identity.key) {
      throw new Error("identity.key is required to route to the agent DO");
    }
    // Cast, and the cast is the point: a `DurableObjectStub<SpikeReactive>` is
    // the RPC type mapping applied over every member `Think` brings with it,
    // and comparing that to `TaskAgent` exceeds TypeScript's instantiation
    // depth. `_implementsTaskAgent` below is where the check actually happens,
    // on the plain class, which is cheap and catches the same mistake.
    return objectFor(env, tenant, identity.key) as unknown as TaskAgent;
  },
  startTurn(env, turn) {
    if (!turn.identity.key) {
      throw new Error("identity.key is required to start a turn");
    }
    return objectFor(env, tenant, turn.identity.key).startTurn(turn);
  },
  /**
   * Present so the edge accepts a message on an existing task at all — core
   * refuses one for an agent that cannot resume a run. Empty because there is
   * no run to wake: `answerTask` has already submitted the answer as the next
   * turn, and Think's FIFO queue orders it.
   */
  async resumeTurn() {}
}));

/**
 * The structural check the cast in `resolveAgent` gives up.
 *
 * Declared on the class rather than on its stub: the agent's own type is a
 * cheap comparison, while the stub's is the same shape run through Cloudflare's
 * RPC type mapping, which on a `Think` subclass is deep enough to defeat the
 * compiler. A method that stops matching the A2A surface still fails here.
 */
const _implementsTaskAgent = (agent: SpikeReactive): TaskAgent => agent;
void _implementsTaskAgent;

const a2a = createA2AWorker<SpikeEnv>({ manifest, agents: tenants });

/**
 * Drive and inspect the spike without a gatekeeper.
 *
 * Core's origin allowlist is https-only, which is right — a local gatekeeper
 * can never be trusted — so a local end-to-end run has to reach the agent below
 * the edge. These routes are that, and they are gated on a secret: the spike is
 * a Worker on the public internet, and they read and write task state.
 */
async function debugRoute(
  request: Request,
  env: SpikeEnv,
  url: URL
): Promise<Response | null> {
  if (!url.pathname.startsWith("/spike/debug/")) return null;
  const token = env.SPIKE_DEBUG_TOKEN;
  if (!token || url.searchParams.get("token") !== token) {
    return new Response("not found", { status: 404 });
  }
  const name = url.searchParams.get("name") ?? "debug";
  const agent = objectFor(env, "spike", name);

  switch (url.pathname) {
    case "/spike/debug/accept": {
      const body = await request.json<{ text: string; pushUrl: string }>();
      const taskId = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      const accepted: PlainTask = await agent.beginTask({
        messageId,
        taskId,
        contextId: taskId
      });
      await agent.startTurn({
        messageId,
        taskId: accepted.id,
        contextId: accepted.contextId,
        text: body.text,
        identity: { key: name, name },
        pushUrl: body.pushUrl,
        pushToken: "spike-debug",
        jku: `${url.origin}/.well-known/jwks.json`
      });
      return Response.json({ taskId: accepted.id });
    }
    case "/spike/debug/task": {
      const taskId = url.searchParams.get("taskId") ?? "";
      return Response.json({ task: await agent.getTask(taskId) });
    }
    case "/spike/debug/cancel": {
      const taskId = url.searchParams.get("taskId") ?? "";
      return Response.json({ task: await agent.cancelTask(taskId) });
    }
    case "/spike/debug/inspect": {
      const taskId = url.searchParams.get("taskId") ?? undefined;
      return new Response(await agent.inspect(taskId), {
        headers: { "content-type": "application/json" }
      });
    }
    default:
      return new Response("not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: SpikeEnv): Promise<Response> {
    const url = new URL(request.url);
    return (
      (await debugRoute(request, env, url)) ??
      (await handleArtifactRoute(request, env)) ??
      a2a(request, env)
    );
  }
} satisfies ExportedHandler<SpikeEnv>;

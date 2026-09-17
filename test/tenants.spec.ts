import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
// The Worker `env` the pool builds from wrangler.jsonc, plus the test secrets
// seeded in vitest.config.ts. From `cloudflare:workers`, not `cloudflare:test` —
// the latter's `env` is deprecated.
import { env } from "cloudflare:workers";
import { AGENT_CARD_PATH, A2A_PROTOCOL_VERSION } from "@a2a-js/sdk";
import {
  AGENT_ORIGIN,
  GATEKEEPER_ORIGIN,
  TEST_AGENT_PRIVATE_JWK,
  gatekeeperPublicJwks,
  makeGatekeeperToken
} from "@dynamicagents/core/testing";
import worker from "@/index";

/**
 * Five agents, one Worker, one endpoint.
 *
 * This is the file that pins the architecture the rest of the repo assumes.
 * Every assertion here is about a fact that is *only* true because the agents
 * share a deployment — a single-agent Worker gets all of it for free from
 * `createA2AWorker` and has nothing to check.
 */

const TENANTS = [
  "reactive",
  "proactive",
  "arc-player",
  "coder",
  "claude-coder"
] as const;

const get = (path: string) =>
  worker.fetch(new Request(`${AGENT_ORIGIN}${path}`), env);

const rpc = async (body: unknown, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request(`${AGENT_ORIGIN}/a2a`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "A2A-Version": A2A_PROTOCOL_VERSION,
        ...headers
      },
      body: JSON.stringify(body)
    }),
    env
  );

const sendMessage = (tenant: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "SendMessage",
  params: { tenant }
});

const getExtendedCard = (tenant: string) => ({
  jsonrpc: "2.0",
  id: 2,
  method: "GetExtendedAgentCard",
  params: { tenant }
});

/**
 * A gatekeeper token authorizing one tenant at this deployment's endpoint — with a
 * real caller identity, as a gatekeeper always mints.
 */
const tokenFor = (tenant: string) =>
  makeGatekeeperToken({ audience: `${AGENT_ORIGIN}/a2a`, tenant });

/**
 * The same, minus the caller `key`. Used only where a spec wants the call to
 * die *after* verification: it proves the token itself was accepted, since a
 * rejected one never reaches the identity check.
 */
const keylessTokenFor = (tenant: string) =>
  makeGatekeeperToken({
    audience: `${AGENT_ORIGIN}/a2a`,
    tenant,
    identity: { name: "anonymous" }
  });

beforeAll(() => {
  // The gatekeeper's public JWKS, so a token can actually be verified. Everything
  // else is refused before it reaches the network.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    if (url === `${GATEKEEPER_ORIGIN}/.well-known/jwks.json`) {
      return new Response(gatekeeperPublicJwks(), {
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("not found", { status: 404 });
  });
});

afterAll(() => vi.unstubAllGlobals());

describe("discovery", () => {
  it("serves one signed stub card at the well-known path", async () => {
    // One card per origin, because a well-known URI is per-authority (RFC 8615)
    // and A2A registered this path with IANA. Serving an agent's card here would
    // make that agent the one every gatekeeper pinned, for all of them.
    const res = await get(`/${AGENT_CARD_PATH}`);
    expect(res.status).toBe(200);

    const card = await res.json<{
      name: string;
      capabilities: { extendedAgentCard: boolean };
      supportedInterfaces: { url: string; tenant: string }[];
      signatures: { protected: string }[];
    }>();

    // It describes the deployment, not an agent, and names no tenant.
    expect(card.name).toBe("da-starter");
    expect(card.supportedInterfaces[0].tenant ?? "").toBe("");
    expect(card.supportedInterfaces[0].url).toBe(`${AGENT_ORIGIN}/a2a`);
    // …and advertises the only route to a real agent's card.
    expect(card.capabilities.extendedAgentCard).toBe(true);

    const header = JSON.parse(
      atob(card.signatures[0].protected.replace(/-/g, "+").replace(/_/g, "/"))
    );
    expect(header.jku).toBe(`${AGENT_ORIGIN}/.well-known/jwks.json`);
    expect(header.alg).toBe("EdDSA");
  });

  it("serves one public JWKS for the whole deployment", async () => {
    const res = await get("/.well-known/jwks.json");
    expect(res.status).toBe(200);

    const body = await res.json<{ keys: Record<string, unknown>[] }>();
    expect(body.keys[0].kid).toBe(TEST_AGENT_PRIVATE_JWK.kid);
    // The private half must never be served.
    expect(body.keys[0]).not.toHaveProperty("d");
  });

  it("404s a path the Worker does not serve", async () => {
    expect((await get("/nope")).status).toBe(404);
    // The old layout answered here; nothing should now.
    expect((await get("/reactive/a2a")).status).toBe(404);
  });
});

describe("per-tenant cards", () => {
  it.each(TENANTS)("returns %s its own signed card", async (tenant) => {
    // The only way to get an agent's card, and what a gatekeeper registers from.
    const res = await rpc(getExtendedCard(tenant), {
      authorization: `Bearer ${await tokenFor(tenant)}`
    });
    const body = await res.json<{
      result: {
        name: string;
        supportedInterfaces: { url: string; tenant: string }[];
        signatures: { protected: string }[];
      };
    }>();

    expect(body.result.supportedInterfaces[0].tenant).toBe(tenant);
    // Every tenant answers on the one endpoint — that is what tenant is for.
    expect(body.result.supportedInterfaces[0].url).toBe(`${AGENT_ORIGIN}/a2a`);

    // Signed by the deployment's single key, which the gatekeeper pinned from the
    // stub card. A different key here would fail verification at registration.
    const header = JSON.parse(
      atob(
        body.result.signatures[0].protected
          .replace(/-/g, "+")
          .replace(/_/g, "/")
      )
    );
    expect(header.jku).toBe(`${AGENT_ORIGIN}/.well-known/jwks.json`);
  });

  it("gives each tenant a distinct identity", async () => {
    const names = await Promise.all(
      TENANTS.map(async (tenant) => {
        const res = await rpc(getExtendedCard(tenant), {
          authorization: `Bearer ${await tokenFor(tenant)}`
        });
        return (await res.json<{ result: { name: string } }>()).result.name;
      })
    );
    // One identity per agent. Sharing one would make them indistinguishable to
    // a gatekeeper registering them. Counted off `TENANTS` rather than a literal,
    // which is what went stale when the fourth agent arrived.
    expect(new Set(names).size).toBe(TENANTS.length);
  });
});

describe("tenant isolation", () => {
  it("accepts a token minted the way the real gatekeeper mints one", async () => {
    // slack-gatekeeper signs `aud` as the registered endpoint and carries the
    // registered tenant as a claim. Both have to line up.
    for (const tenant of TENANTS) {
      const res = await rpc(sendMessage(tenant), {
        // No `key`, so the call dies one step *after* verification.
        authorization: `Bearer ${await keylessTokenFor(tenant)}`
      });
      // 400, not 401: the token verified and the tenant matched, and the
      // keyless identity is what stopped it. A 401 would mean the tenant check
      // rejected a legitimate call.
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/identity missing key/);
    }
  });

  it("refuses a token minted for a sibling tenant", async () => {
    // The isolation this design buys, and the thing the audience cannot express
    // — every tenant shares one endpoint and therefore one `aud`, so only the
    // tenant claim separates them.
    const res = await rpc(sendMessage("proactive"), {
      authorization: `Bearer ${await tokenFor("reactive")}`
    });
    expect(res.status).toBe(401);
  });

  it("refuses a token carrying no tenant claim", async () => {
    // A gatekeeper too old to scope its tokens. Treating this as a wildcard would
    // reopen the replay above for every such caller.
    const res = await rpc(sendMessage("reactive"), {
      authorization: `Bearer ${await tokenFor("")}`
    });
    expect(res.status).toBe(401);
  });

  it("refuses a request naming no tenant", async () => {
    const res = await rpc(
      { jsonrpc: "2.0", id: 1, method: "SendMessage", params: {} },
      { authorization: `Bearer ${await tokenFor("reactive")}` }
    );
    const body = await res.json<{ error: { message: string } }>();
    expect(body.error.message).toMatch(/params\.tenant is required/);
  });

  it("refuses a tenant this Worker does not serve", async () => {
    const res = await rpc(sendMessage("ghost"), {
      authorization: `Bearer ${await tokenFor("ghost")}`
    });
    const body = await res.json<{ error: { message: string } }>();
    expect(body.error.message).toMatch(/unknown tenant 'ghost'/);
  });

  it("refuses an unauthenticated call", async () => {
    const res = await rpc(sendMessage("reactive"));
    expect(res.status).toBe(401);
  });

  it("404s a POST to a path that is not the RPC endpoint", async () => {
    const res = await worker.fetch(
      new Request(`${AGENT_ORIGIN}/not-a-real-endpoint`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sendMessage("reactive"))
      }),
      env
    );
    expect(res.status).toBe(404);
  });
});

import type { SpikeReactive } from "./agent";

/**
 * The bindings the spike Worker declares, in `wrangler.spike.jsonc`.
 *
 * It extends `Cloudflare.Env` because the Agents SDK constrains every agent to
 * it (`class Agent<Env extends Cloudflare.Env>`), and that interface is
 * generated from `wrangler.jsonc` — the deployment this repo actually ships.
 * The spike deploys its own Worker, so the bindings it adds are declared here
 * rather than regenerated: nothing in `src/spike/` reads a binding it did not
 * name below.
 */
export interface SpikeEnv extends Cloudflare.Env {
  /** One instance per verified caller, keyed by tenant and `identity.key`. */
  SpikeReactive: DurableObjectNamespace<SpikeReactive>;
  /**
   * Selects the rule-based streaming model in `fake-model.ts`. Set on the
   * deployed spike too: it takes no real traffic, so it runs no real model.
   */
  SPIKE_FAKE_MODEL?: string;
  /**
   * The bearer of the `/spike/debug/*` routes. Absent, every debug route 404s
   * — the spike is a Worker on the public internet and the debug routes read
   * and write task state.
   */
  SPIKE_DEBUG_TOKEN?: string;
}

/**
 * The tenants the spike mounts, one Durable Object each.
 *
 * A turn queue is per object and first-in-first-out, so two scenarios sharing
 * one object serialize — the second waits for the first, and a push from the
 * first lands while the second is watching. One tenant per scenario is what
 * keeps them independent; the deployed spike gets the same isolation from the
 * `name` its debug-accept route takes.
 */
export const SPIKE_TENANTS = [
  "spike",
  "spike-accept",
  "spike-redeliver",
  "spike-ask",
  "spike-answer",
  "spike-foreign",
  "spike-timeout",
  "spike-cancel",
  "spike-error",
  "spike-bg",
  "spike-bg-cancel",
  "spike-bg-two",
  "spike-checkback"
] as const;

export type SpikeTenant = (typeof SPIKE_TENANTS)[number];

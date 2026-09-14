import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { resolveConfig } from "@dynamicagents/core";
import {
  runHandleTask,
  type HandleTaskParams,
  type NonRecoverableKind,
  type TaskVerdict
} from "@dynamicagents/core/round";
import { CODER_CONFIG } from "@/config";
import { failureCopy, roundPolicy } from "@/round-policy";
import { coder } from "./definition";

/**
 * What an operator is told when a credential is refused.
 *
 * These are the only failures in this agent that no amount of retrying fixes and
 * that only a human can clear, so they get real words instead of a stack trace.
 * Kept next to the handler rather than in `round-policy.ts` because that file is
 * shared with the agents that have no credential of their own to reject.
 *
 * ## One of these is barely reachable, and that is the honest thing to write
 *
 * `NonRecoverableKind` is core's, and it names the authorities that can sit
 * between a round and a model: the AI Gateway and the provider. This Worker
 * reaches Workers AI through the `AI` binding, which the platform
 * authenticates — there is no model credential here at all, so the `credential`
 * arm below describes something that should not be able to happen, and its copy
 * says so rather than sending an operator to rotate a secret that does not exist.
 *
 * The `Record` stays total because core made it total on purpose: a kind added
 * or removed upstream must fail to compile here rather than fall through to
 * silence.
 */
const CREDENTIAL_COPY: Record<NonRecoverableKind, string> = {
  credential: [
    "I could not reach the model: the provider rejected the credential.",
    "",
    "That is unexpected here. This agent calls Workers AI through the `AI` binding, which Cloudflare authenticates for the Worker — there is no model API key in this deployment to expire or be revoked, so there is nothing for an operator to rotate.",
    "",
    "That makes this almost certainly a platform-side fault rather than a configuration one. Worth checking, in order:",
    "",
    "  1. The Cloudflare status page, for a Workers AI or AI Gateway incident.",
    "  2. Whether the account still has Workers AI enabled and is not past a billing limit.",
    "  3. `npm run cf -- ai --since 1h` — the AI Gateway log records what the request actually returned.",
    "",
    "Then send this request again. Nothing was changed in the repository."
  ].join("\n"),

  "gateway-credential": [
    "I could not reach the model: the AI Gateway rejected the request before it got there.",
    "",
    "That is the AI Gateway's own authentication, not the model's — the model never saw this request. It happens when the AI Gateway has Authenticated Gateway switched on, because the `AI` binding does not send a `cf-aig-authorization` token.",
    "",
    "An operator has two options, and the first is usually right:",
    "",
    "  1. Turn Authenticated Gateway off for this gateway (AI Gateway → the gateway → Settings). Requests from the binding are already authenticated as this account's Worker.",
    "  2. Or point the agent at a different gateway by changing `aiGatewayId` in src/config.ts.",
    "",
    "Then send this request again. Nothing was changed in the repository."
  ].join("\n"),

  "unknown-credential": [
    "I could not reach the model: something on the path refused the request, and the response did not say which.",
    "",
    "There are two authorities left on this path, and it is one of them. Checking in order, cheapest first:",
    "",
    "  1. The AI Gateway — if Authenticated Gateway is on for this gateway, turn it off; the `AI` binding does not send a gateway token.",
    "  2. Workers AI itself — check the Cloudflare status page and that the account has Workers AI enabled and is within its limits.",
    "",
    "The AI Gateway log is the fastest way to tell them apart, because it records the status the request actually came back with:",
    "",
    "    npm run cf -- ai --since 1h",
    "",
    "Then send this request again. Nothing was changed in the repository."
  ].join("\n")
};

/** The coder agent's task workflow: core's orchestration, its own binding. */
export class CoderWorkflow extends WorkflowEntrypoint<Env, HandleTaskParams> {
  /**
   * No `catch` here, deliberately: `runHandleTask` guards itself. A transient
   * fault that never stops being one would otherwise leave the Task in `working`
   * with the user told nothing, and a per-agent recovery is the kind an agent
   * can be written without.
   */
  async run(
    event: Readonly<WorkflowEvent<HandleTaskParams>>,
    step: WorkflowStep
  ): Promise<TaskVerdict> {
    return await runHandleTask(event.payload, step, {
      resolveAgent: (identity) => coder.resolveAgent(this.env, identity),
      config: resolveConfig(CODER_CONFIG),
      policy: roundPolicy,
      // Core owns the signal and the delivery — including the guarded write that
      // doubles as the cancellation check — and asks the host only for the
      // words. Which is the right split: this file knows what the secrets are
      // called and core cannot.
      //
      // Only the credential kinds get words here. `exhausted` means the models
      // were tried and could not do it, which is a thing that happened to one
      // request rather than a thing an operator can fix, and
      // `roundPolicy.copy.taskFailed` already says it — so it takes the
      // `undefined` fallback rather than a worse paraphrase. `unanswered` takes
      // the words every round agent here shares.
      failureCopy: (kind, detail) => {
        if (kind === "exhausted" || kind === "unanswered")
          return failureCopy(kind);
        console.error("[coder] credential refused", {
          taskId: event.payload.taskId,
          kind,
          detail
        });
        return CREDENTIAL_COPY[kind];
      },
      signingKey: this.env.A2A_SIGNING_KEY,
      // Names this agent in the abandoned-task log line. Five agents share this
      // Worker and therefore one log stream.
      label: "coder"
    });
  }
}

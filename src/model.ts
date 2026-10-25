import { isPlatformTransientError } from "agents";
import type { ChatErrorClassification } from "@cloudflare/think";
import type { LanguageModel } from "ai";
import {
  catalogModel,
  gatewayLogFields,
  workersAIModel,
  type GatewayCorrelation
} from "@dynamicagents/core/model";

/**
 * The one model an agent or a sub-agent runs, as its `getModel()` returns it.
 *
 * One function for every class here, because what each call tells AI Gateway
 * about itself has to be spelled the same way everywhere or a log filter on it
 * silently misses the classes that spelled it differently. Both arms below are
 * handed the same fields, so a catalog slug's log row groups beside a Workers
 * AI one rather than beside nothing.
 *
 * Which arm is the id's to say, and the split is the one `@dynamicagents/core/model`
 * draws between its providers: a leading `@` is a Workers AI id, anything else
 * is the `"<provider>/<model>"` slug AI Gateway's provider catalog lists.
 * Both reach the gateway over the same `AI` binding, so neither needs a
 * credential this deployment would have to hold.
 *
 * `sessionAffinity` is the object's name on both arms: every call an object
 * makes re-sends one history, so anything finer routes a call away from the
 * prefix it is about to re-send. Workers AI routes on it, and an `openai/*`
 * slug sends it as OpenAI's prompt-cache key.
 */
export function agentModel(
  env: Env,
  model: { modelId: string; name: string },
  correlation: GatewayCorrelation
): LanguageModel {
  const log = gatewayLogFields(correlation);
  return model.modelId.startsWith("@")
    ? workersAIModel(env, {
        modelId: model.modelId,
        sessionAffinity: model.name,
        ...log
      })
    : catalogModel(env, {
        slug: model.modelId,
        sessionAffinity: model.name,
        ...log
      });
}

/**
 * A turn the platform cut, as Think's error classification spells it, or
 * `undefined` for an error this deployment has nothing to add about.
 *
 * Every class here answers `classifyChatError` with
 * `transientChatError(error) ?? super.classifyChatError(error)`, and the reason
 * it is one function rather than a condition written out six times is the one
 * {@link agentModel} gives: a class that spelled this differently would fail a
 * turn its siblings continue, and nothing would say so.
 *
 * ## Why core does not do this
 *
 * Think hands a turn's stream error to `classifyChatError` and continues the
 * turn only for `"transient"` or `"rate_limit"`; anything else, `undefined`
 * included, ends it. Core answers with the bundled context-overflow classifier
 * alone, deliberately: the errors a dropped connection arrives as belong to the
 * provider and the platform a deployment chose, and core matching them on every
 * tenant's behalf is the line it does not cross. This is that deployment.
 *
 * Without this, a stream that dies mid-answer ends its turn and fails its step
 * job, and the work resumes through the workflow's retry of the whole step
 * rather than through a continuation. The partial answer is what that costs,
 * and for a long coding step it is minutes of model calls and tool runs.
 *
 * ## The shape is the platform's, not the provider's
 *
 * There is no OpenAI-specific string to match: a disconnect is a transport
 * failure, and what surfaces is the runtime's message for a connection that
 * died. `isPlatformTransientError` is the predicate `agents` maintains for
 * exactly that family — connection lost, an isolate the platform superseded, a
 * storage reset, and anything carrying the runtime's own retryable flag — and it
 * reads an `Error`, a string, and a `cause` chain, which is all three shapes
 * Think may hand a classifier. Matching strings here instead would put a copy of
 * that list in this repo, to go stale on the next runtime message.
 *
 * It applies to every class rather than only the one whose id names an
 * `openai/*` slug. A model id is a config value (`src/config.ts`), so an agent
 * moved onto a slug tomorrow would otherwise lose this silently, and a turn cut
 * by the platform is worth continuing whichever provider answered it.
 *
 * ## What it costs, accepted
 *
 * A **fatal** error whose message matches this family is now retried: Think
 * continues the turn up to `chatRecovery.maxAttempts`, waiting a second and
 * doubling to thirty, before ending it with the terminal message. So a
 * permanently broken connection costs that budget before the step job fails and
 * the workflow retries it. The trade is deliberate: the budget is bounded and a
 * dropped stream is common, while an error that both looks like a disconnect and
 * is permanent is neither.
 */
export function transientChatError(
  error: unknown
): ChatErrorClassification | undefined {
  return isPlatformTransientError(error) ? "transient" : undefined;
}

/**
 * The task a sub-agent's turn is for. Core stamps it on the dispatch's
 * `turnMetadata`, where Think keeps it for a recovered turn too.
 */
export function turnTask(metadata: unknown): string | undefined {
  const taskId = (metadata as { taskId?: unknown } | undefined)?.taskId;
  return typeof taskId === "string" ? taskId : undefined;
}

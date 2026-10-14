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
 * The task a sub-agent's turn is for. Core stamps it on the dispatch's
 * `turnMetadata`, where Think keeps it for a recovered turn too.
 */
export function turnTask(metadata: unknown): string | undefined {
  const taskId = (metadata as { taskId?: unknown } | undefined)?.taskId;
  return typeof taskId === "string" ? taskId : undefined;
}

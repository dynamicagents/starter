import type { LanguageModel } from "ai";
import {
  gatewayLogFields,
  workersAIModel,
  type GatewayCorrelation
} from "@dynamicagents/core/model";

/**
 * The one model an agent or a sub-agent runs, as its `getModel()` returns it.
 *
 * One function for every class here, because what each call tells AI Gateway
 * about itself has to be spelled the same way everywhere or a log filter on it
 * silently misses the classes that spelled it differently.
 *
 * `sessionAffinity` is the object's name: every call an object makes re-sends
 * one history, so anything finer routes a call away from the prefix it is about
 * to re-send.
 */
export function agentModel(
  env: Env,
  model: { modelId: string; name: string },
  correlation: GatewayCorrelation
): LanguageModel {
  return workersAIModel(env, {
    modelId: model.modelId,
    sessionAffinity: model.name,
    ...gatewayLogFields(correlation)
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

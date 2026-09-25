import type { UIMessage } from "ai";
import type { HitlOption } from "@dynamicagents/core/a2a";

/**
 * What a finished turn amounts to, read back out of the session.
 *
 * Think has no "final reply" tool: a turn ends when the model stops calling
 * tools, and what the caller gets is whatever the assistant said. Which
 * assistant messages count is the part worth writing down — a recovered turn is
 * **two or more** assistant messages (the persisted partial, then the
 * continuation), so the turn is every assistant message after the user message
 * that started it, not the last one.
 */

/** A question the turn ended on, still waiting for its answer. */
export interface PendingAsk {
  toolCallId: string;
  question: string;
  options: HitlOption[];
}

export interface TurnOutcome {
  /** Everything the assistant said this turn — what a progress push carries. */
  text: string;
  /**
   * The text after the last tool part — what settles the task.
   *
   * Not the whole turn: the sentences before a tool call are the model
   * narrating what it is about to do, and they have already been pushed as
   * progress by the `onChunk` flush.
   */
  reply: string;
  ask?: PendingAsk;
}

/**
 * Read one task's turn out of the session.
 *
 * The turn starts at the last user message stamped with this task id. Think
 * persists `metadata.turnMetadata` on the submitted user message precisely so a
 * recovered or continued turn can re-resolve it from durable history.
 */
export function readTurn(messages: UIMessage[], taskId: string): TurnOutcome {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    if (taskIdOf(message) === taskId) {
      start = i;
      break;
    }
  }
  const turn = messages
    .slice(start + 1)
    .filter((message) => message.role === "assistant");

  const parts = turn.flatMap((message) => message.parts);
  const lastTool = lastToolIndex(parts);
  return {
    text: textOf(parts).trim(),
    reply: textOf(parts.slice(lastTool + 1)).trim(),
    ask: pendingAsk(parts)
  };
}

function taskIdOf(message: UIMessage): string | undefined {
  const metadata = message.metadata as
    { turnMetadata?: { taskId?: unknown } } | undefined;
  const taskId = metadata?.turnMetadata?.taskId;
  return typeof taskId === "string" ? taskId : undefined;
}

type Part = UIMessage["parts"][number];

function textOf(parts: Part[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("");
}

function lastToolIndex(parts: Part[]): number {
  let index = -1;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].type.startsWith("tool-") || parts[i].type === "dynamic-tool") {
      index = i;
    }
  }
  return index;
}

/**
 * The `ask_user` call the turn ended on, if any.
 *
 * `ask_user` has no `execute`, so the turn ends with the call unanswered and
 * Think completes the submission — that is the documented pattern, not a
 * failure. A settled part is a question somebody already answered.
 */
function pendingAsk(parts: Part[]): PendingAsk | undefined {
  for (const part of parts) {
    if (part.type !== "tool-ask_user") continue;
    const call = part as {
      toolCallId?: string;
      state?: string;
      input?: { question?: unknown; options?: unknown };
    };
    if (call.state === "output-available" || call.state === "output-error") {
      continue;
    }
    const question =
      typeof call.input?.question === "string" ? call.input.question : "";
    if (!question) continue;
    return {
      toolCallId: call.toolCallId ?? "",
      question,
      options: readOptions(call.input?.options)
    };
  }
  return undefined;
}

function readOptions(value: unknown): HitlOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const option = entry as { id?: unknown; label?: unknown };
    return typeof option?.id === "string" && typeof option.label === "string"
      ? [{ id: option.id, label: option.label }]
      : [];
  });
}

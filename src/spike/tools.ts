import { tool, type Tool } from "ai";
import { z } from "zod";

/**
 * The tools both sides of the spike share.
 *
 * The delegating ones — `general_long` and `check_back` — are not here: each
 * closes over the agent that owns the work ledger, so they are built as methods
 * on it in `agent.ts`.
 */

/**
 * Ask the caller something.
 *
 * **No `execute`, deliberately.** The turn ends with the call unanswered, the
 * submission completes, and the answer arrives as the next user message —
 * Think's documented pattern. `needsApproval` would park the submission as
 * pending instead, which is a different lifecycle and not this one.
 */
export function askUserTool(): Tool {
  return tool({
    description:
      "Ask the caller a question and stop. The answer arrives as their next message.",
    inputSchema: z.object({
      question: z.string().min(1),
      options: z
        .array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
        .optional()
    })
  });
}

/** Wait, interruptibly. A tool that can hang owns its own abort. */
export function waitTool(description: string): Tool {
  return tool({
    description,
    inputSchema: z.object({ seconds: z.number().min(0).max(3600) }),
    execute: async ({ seconds }, { abortSignal }) => {
      await sleep(seconds * 1000, abortSignal);
      return { waited: seconds };
    }
  });
}

/**
 * The child's own wait, which also reports a durable milestone.
 *
 * `persist: true` is what makes the note survive: `onProgress` on the parent is
 * best-effort and is not replayed after an eviction, so the persisted milestone
 * is the copy the finish path replays through the transcript.
 */
export function sleepTool(
  report: (milestone: { key: string; text: string }) => Promise<void>
): Tool {
  return tool({
    description: "Do a piece of long work.",
    inputSchema: z.object({ seconds: z.number().min(0).max(3600) }),
    execute: async ({ seconds }, { abortSignal, toolCallId }) => {
      await report({
        key: `sleep:${toolCallId}`,
        text: `sleeping for ${seconds}s`
      });
      await sleep(seconds * 1000, abortSignal);
      return { slept: seconds };
    }
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

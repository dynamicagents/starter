import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream } from "ai";

/**
 * A rule-based streaming model, so the spike's behaviour is a property of the
 * lifecycle rather than of an inference.
 *
 * **`doStream`, not `doGenerate`.** Think calls `streamText`, so a model with
 * only `doGenerate` is never asked anything — the whole turn fails on a
 * missing implementation rather than running the scripted steps.
 *
 * A rule reads the **last user message** and whether a tool result has come
 * back since it. That second half is what ends a turn: a rule emits its tool
 * call on the first pass and plain text (or nothing) on the second, so a
 * scripted turn converges instead of calling the same tool forever.
 *
 * Anything a rule does not claim is echoed back verbatim. That is what makes a
 * follow-up turn work without a rule of its own: a detached run's completion
 * and a `check_back` wake both arrive as ordinary user messages, and the reply
 * the gatekeeper gets is the text they carried.
 */

/** The provider-level prompt, read off the mock rather than imported. */
type Prompt = Parameters<MockLanguageModelV3["doStream"]>[0]["prompt"];
type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

/** Zeroed usage, satisfying the result shape without pretending to measure. */
const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 }
};

interface ToolCall {
  toolName: string;
  input: unknown;
}

interface Step {
  text?: string;
  calls?: ToolCall[];
  /** Emit a stream error instead of content — the failed-task path. */
  error?: string;
}

export function spikeFakeModel(): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    provider: "spike",
    modelId: "spike-fake",
    doStream: async ({ prompt }) => ({
      stream: simulateReadableStream<StreamPart>({
        chunks: chunksFor(resolve(prompt), call++),
        initialDelayInMs: 0,
        chunkDelayInMs: 0
      })
    })
  });
}

/** What the model does this step, from the last user message and what followed. */
function resolve(prompt: Prompt): Step {
  const text = lastUserText(prompt).trim();
  const answered = hasToolResult(prompt);

  if (text === "boom") return { error: "the spike model was told to fail" };

  const bg2 = match(text, "bgdelegate2:");
  if (bg2 !== undefined) {
    if (answered) return {};
    const [first, second] = bg2.split("|");
    return {
      text: "Started two in the background.",
      calls: [
        { toolName: "general_long", input: { task: first } },
        { toolName: "general_long", input: { task: second } }
      ]
    };
  }

  const bg = match(text, "bgdelegate:");
  if (bg !== undefined) {
    if (answered) return {};
    return {
      text: "Started in the background.",
      calls: [{ toolName: "general_long", input: { task: bg } }]
    };
  }

  const checkback = match(text, "checkback:");
  if (checkback !== undefined) {
    if (answered) return {};
    return {
      text: "Checking back shortly.",
      calls: [
        {
          toolName: "check_back",
          input: { seconds: Number(checkback), why: "spike" }
        }
      ]
    };
  }

  const wait = match(text, "wait:");
  if (wait !== undefined) {
    if (answered) return { text: `waited ${wait}` };
    return {
      calls: [{ toolName: "spike_wait", input: { seconds: Number(wait) } }]
    };
  }

  const ask = match(text, "ask:");
  if (ask !== undefined && !answered) {
    return {
      calls: [
        {
          toolName: "ask_user",
          input: {
            question: ask,
            options: [
              { id: "yes", label: "Yes" },
              { id: "no", label: "No" }
            ]
          }
        }
      ]
    };
  }

  // The child's rule. `sleep:<n>` is the task a `general_long` dispatch carries.
  const sleep = match(text, "sleep:");
  if (sleep !== undefined) {
    if (answered) return { text: `child did: sleep:${sleep}` };
    return {
      calls: [{ toolName: "spike_sleep", input: { seconds: Number(sleep) } }]
    };
  }

  const echo = match(text, "echo:");
  if (echo !== undefined) return { text: echo };

  return { text };
}

function match(text: string, prefix: string): string | undefined {
  return text.startsWith(prefix) ? text.slice(prefix.length) : undefined;
}

function lastUserText(prompt: Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i];
    if (message.role !== "user") continue;
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join("");
  }
  return "";
}

/** Whether a tool has answered since the last user message. */
function hasToolResult(prompt: Prompt): boolean {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const role = prompt[i].role;
    if (role === "user") return false;
    if (role === "tool") return true;
  }
  return false;
}

function chunksFor(step: Step, call: number): StreamPart[] {
  const chunks: StreamPart[] = [{ type: "stream-start", warnings: [] }];
  if (step.error !== undefined) {
    chunks.push({ type: "error", error: new Error(step.error) });
    chunks.push({
      type: "finish",
      usage: USAGE,
      finishReason: { unified: "error", raw: undefined }
    });
    return chunks;
  }

  if (step.text) {
    const id = `t${call}`;
    chunks.push({ type: "text-start", id });
    chunks.push({ type: "text-delta", id, delta: step.text });
    chunks.push({ type: "text-end", id });
  }

  const calls = step.calls ?? [];
  calls.forEach((toolCall, index) => {
    const id = `c${call}-${index}`;
    const input = JSON.stringify(toolCall.input);
    chunks.push({
      type: "tool-input-start",
      id,
      toolName: toolCall.toolName
    });
    chunks.push({ type: "tool-input-delta", id, delta: input });
    chunks.push({ type: "tool-input-end", id });
    chunks.push({
      type: "tool-call",
      toolCallId: id,
      toolName: toolCall.toolName,
      input
    });
  });

  chunks.push({
    type: "finish",
    usage: USAGE,
    finishReason: {
      unified: calls.length > 0 ? "tool-calls" : "stop",
      raw: undefined
    }
  });
  return chunks;
}

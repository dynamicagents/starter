import { Think, type ThinkModel, type TurnConfig } from "@cloudflare/think";
import type {
  AgentToolLifecycleResult,
  AgentToolMilestone,
  AgentToolProgressSnapshot,
  AgentToolRunInfo
} from "agents";
import { hasToolCall, tool, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import { createWorkersAI } from "workers-ai-provider";
import { Task, TaskState } from "@a2a-js/sdk";
import {
  HITL_REQUEST_TYPE,
  SelfOrigin,
  buildCompletedTask,
  buildFailedTask,
  buildInputRequiredTask,
  createPushChannel,
  taskStateLabel,
  type AcceptedTurn,
  type AnsweredTask,
  type HitlRequestData,
  type HumanReply,
  type PlainTask,
  type PushChannel,
  type TaskListPage,
  type TaskListQuery,
  type TurnPushContext,
  type TurnWake
} from "@dynamicagents/core/a2a";
import {
  assertArtifactsBound,
  settleTranscript,
  transcribeNote
} from "@dynamicagents/core/artifacts";
import { SpikeGeneral } from "./child";
import type { SpikeEnv } from "./env";
import { spikeFakeModel } from "./fake-model";
import { readTurn } from "./outcome";
import { SpikeTasks, isTerminalState } from "./tasks";
import { askUserTool, waitTool } from "./tools";

/**
 * The reactive agent on Think, behind core's unchanged A2A edge.
 *
 * What the spike is proving is one sentence: **a task can outlive the turn that
 * started it.** A sub-agent that may run past Think's fifteen-minute turn is
 * dispatched detached, the parent turn ends at once, the A2A task stays
 * `working` because the work ledger says it has open work, and a follow-up turn
 * — submitted by the detached run's own `onFinish` — is what settles it.
 *
 * Three rules hold that together, and each is a thing that broke first:
 *
 *  - **A raw Durable Object RPC does not start Think's lifecycle.** `this.session`
 *    is undefined until something does, so every method core's executor or the
 *    Worker calls begins by starting it.
 *  - **`onSubmissionStatus` is not a delivery channel.** It fires inside the turn
 *    slot and its errors are only logged, so it does the guarded write and hands
 *    the callback to a durable queue.
 *  - **Cancellation is decided by the guarded write, never by a probe.** A read
 *    then an act reopens the window where a cancel lands and the gatekeeper
 *    still gets a `completed`.
 */

/** The user-facing strings. In the real thing these live in starter's copy. */
const COPY = {
  failed: "Something went wrong on my side. Nothing was changed.",
  emptyReply: "I finished, but had nothing to say.",
  questionExpired: "Nobody answered in time, so I stopped."
} as const;

/** What `onCheckBack` is handed by the schedule it was created with. */
interface CheckBackWake {
  taskId: string;
  workId: string;
  seconds: number;
  why: string;
}

/** What the delivery outbox carries. Strings and JSON — it crosses a queue. */
interface DeliveryJob {
  taskId: string;
  state: string;
  task: unknown;
}

export class SpikeReactive extends Think<SpikeEnv> {
  /**
   * A re-attaching parent gives up on a silent child after this. `Infinity`
   * because the gatekeeper's own hour is the only bound this design wants: a
   * detached child that says nothing for two minutes is normal.
   */
  static options = { agentToolReattachNoProgressTimeoutMs: Infinity };

  maxSteps = Infinity;
  chatRecovery = { maxRecoveryWork: Infinity };
  /** just-bash is 1.8 MB in the bundle, and no spike rule shells out. */
  workspaceBash = false as const;

  private readonly ledger = new SpikeTasks((strings, ...values) =>
    this.sql(strings, ...values)
  );
  /** Learned from the `jku` every turn carries; never configured. */
  private readonly origin = new SelfOrigin();
  /** Assistant text seen this step, flushed when the step's first tool starts. */
  private buffered = "";
  private flushedThisStep = false;

  // --- Think -----------------------------------------------------------------

  getModel(): ThinkModel {
    return this.env.SPIKE_FAKE_MODEL
      ? spikeFakeModel()
      : createWorkersAI({ binding: this.env.AI })("@cf/zai-org/glm-4.6");
  }

  getSystemPrompt(): string {
    return "You are the spike agent. Answer the caller, delegating long work to the background.";
  }

  override getTools(): ToolSet {
    return {
      general_long: this.generalLongTool(),
      check_back: this.checkBackTool(),
      ask_user: askUserTool(),
      spike_wait: waitTool("Wait, in this turn, before answering.")
    };
  }

  /**
   * Both of these end the turn the moment the tool is called: `ask_user` has no
   * `execute` and is waiting for a person, and `check_back` has already
   * scheduled its own wake. Without them the loop would run another step on a
   * turn that is finished.
   */
  override beforeTurn(): TurnConfig {
    return { stopWhen: [hasToolCall("ask_user"), hasToolCall("check_back")] };
  }

  /**
   * Push the sentences the model wrote *before* a tool call, at the moment the
   * tool starts.
   *
   * `onStepEnd` fires after the step's tools have finished, which is too late
   * for a tool that takes minutes: the caller would watch an agent say nothing
   * and then answer. The first `tool-call` chunk is the earliest point at which
   * the text is known to be complete.
   */
  override async onChunk(ctx: {
    chunk: { type: string; text?: string };
  }): Promise<void> {
    const chunk = ctx.chunk;
    if (chunk.type === "text-delta") {
      this.buffered += chunk.text ?? "";
      return;
    }
    if (chunk.type !== "tool-call" || this.flushedThisStep) return;
    this.flushedThisStep = true;
    const text = this.buffered.trim();
    this.buffered = "";
    if (!text) return;
    const taskId = this.turnTaskId();
    if (!taskId) return;
    await this.push(taskId, text, "step");
  }

  override onStepEnd(): void {
    this.buffered = "";
    this.flushedThisStep = false;
  }

  /**
   * An interrupted `ask_user` becomes the question as plain text.
   *
   * The default repair flips a dangling call to an errored tool result, which
   * the model reads as a tool that broke. This one is not broken: it is a
   * question that was asked, and the next user message answers it.
   */
  protected override repairInterruptedToolPart(
    part: UIMessage["parts"][number]
  ): UIMessage["parts"][number] {
    if (part.type === "tool-ask_user") {
      const input = (part as { input?: { question?: unknown } }).input;
      if (typeof input?.question === "string") {
        return { type: "text", text: input.question };
      }
    }
    return super.repairInterruptedToolPart(part);
  }

  /** A canceled task's interrupted turn is not continued. */
  override async onChatRecovery(): Promise<{ continue: boolean } | void> {
    const taskId = this.turnTaskId();
    if (!taskId) return;
    if (this.ledger.row(taskId)?.state === "canceled") {
      return { continue: false };
    }
  }

  override async onStart(): Promise<void> {
    await super.onStart();
    // A wiring fault with a name: every sub-agent note is filed on the task's
    // transcript, so the binding is required rather than optional.
    assertArtifactsBound(this.env);
    // A crash between settling a task and queueing its callback leaves the row
    // flagged; the sweep is what turns that into a delivery.
    for (const pending of this.ledger.pendingDeliveries()) {
      const task = this.ledger.get(pending.taskId);
      if (task) await this.enqueueDelivery(pending.taskId, task);
    }
  }

  // --- the A2A surface core calls -------------------------------------------

  /**
   * Record (or reuse) the `submitted` task. Idempotent on `messageId`.
   *
   * `__unsafe_ensureInitialized` is the first line of every one of these, and
   * it is not defensive: a native RPC lands on the object without Think's
   * lifecycle having started, so `this.session` — and the submission ledger
   * under it — does not exist yet.
   */
  async beginTask(input: {
    messageId: string;
    taskId: string;
    contextId: string;
  }): Promise<PlainTask> {
    await this.__unsafe_ensureInitialized();
    const row = this.ledger.accept(input);
    return this.ledger.get(row.taskId)!;
  }

  /**
   * Start the durable turn for an accepted task.
   *
   * Idempotent in the way that actually happens: a dispatch retry arrives with
   * the same `messageId`, finds the submission already bound, and does nothing.
   * Think's own `idempotencyKey` closes the narrower race underneath.
   */
  async startTurn(turn: AcceptedTurn): Promise<void> {
    await this.__unsafe_ensureInitialized();
    this.origin.note(turn.jku);
    const row = this.ledger.row(turn.taskId);
    if (!row || row.submissionId) return;
    this.ledger.bindTurn({
      taskId: turn.taskId,
      text: turn.text,
      push: {
        taskId: turn.taskId,
        contextId: turn.contextId,
        pushUrl: turn.pushUrl,
        pushToken: turn.pushToken,
        jku: turn.jku
      },
      identity: turn.identity
    });
    const submission = await this.runTurn({
      mode: "submit",
      input: userMessage(turn.messageId, turn.text, {
        taskId: turn.taskId,
        contextId: turn.contextId
      }),
      idempotencyKey: turn.messageId,
      metadata: { taskId: turn.taskId }
    });
    this.ledger.bindSubmission(turn.taskId, submission.submissionId);
  }

  async getTask(taskId: string): Promise<PlainTask | null> {
    await this.__unsafe_ensureInitialized();
    return this.ledger.get(taskId);
  }

  /**
   * The a2a-js `TaskStore` write path. A `canceled` state routes to the same
   * interruption `cancelTask` takes — the SDK's own cancel branch writes the
   * canceled task through here rather than calling the executor, so the two
   * have to converge or a cancel from the wire stops nothing.
   */
  async saveTask(task: Task): Promise<boolean> {
    await this.__unsafe_ensureInitialized();
    if (task.status?.state === TaskState.TASK_STATE_CANCELED) {
      return (await this.markCanceled(task.id, task)) !== null;
    }
    return this.ledger.save(task);
  }

  async cancelTask(taskId: string): Promise<PlainTask | null> {
    await this.__unsafe_ensureInitialized();
    return this.markCanceled(taskId);
  }

  async listTasks(query: TaskListQuery): Promise<TaskListPage> {
    await this.__unsafe_ensureInitialized();
    return this.ledger.list(query);
  }

  /**
   * Record a person's reply to a question this task asked, and submit it as the
   * next turn.
   *
   * There is no run to wake: the answer is a user message, and Think's FIFO
   * turn queue is what orders it behind anything still running. So the `wake`
   * this hands back is always `null`.
   */
  async answerTask(input: {
    taskId: string;
    messageId: string;
    reply: HumanReply;
  }): Promise<AnsweredTask> {
    await this.__unsafe_ensureInitialized();
    const { taskId, messageId, reply } = input;
    const row = this.ledger.row(taskId);
    if (!row) return { task: null, wake: null };
    if (!row.request || row.request.requestId !== reply.requestId) {
      console.warn("[spike] a reply names no question of this task", {
        taskId,
        requestId: reply.requestId
      });
      return { task: this.ledger.get(taskId), wake: null };
    }

    if (reply.kind === "timeout") {
      // From the queue, not inline. Failing the task here would make the SDK
      // refuse the very message reporting the expiry: it loads the task first
      // and a terminal one takes no messages.
      await this.queue("expireTask", { taskId, requestId: reply.requestId });
      return { task: this.ledger.get(taskId), wake: null };
    }

    if (this.ledger.resume(taskId) === null) {
      return { task: this.ledger.get(taskId), wake: null };
    }
    const answer =
      reply.answer.text ??
      row.request.options?.find((option) => option.id === reply.answer.optionId)
        ?.label ??
      reply.answer.optionId ??
      "";
    await this.runTurn({
      mode: "submit",
      input: userMessage(`answer:${messageId}`, answer, {
        taskId,
        contextId: row.contextId
      }),
      idempotencyKey: `answer:${messageId}`,
      metadata: { taskId }
    });
    return { task: this.ledger.get(taskId), wake: null };
  }

  /**
   * Kept so the Worker's canceled-task wake finds a method rather than a throw
   * — a Durable Object stub answers `typeof stub.humanWake === "function"` for
   * a method that does not exist, and only fails when it is called.
   *
   * Always `null`: there is no run parked on a question to wake. A turn ends at
   * `ask_user`, and the answer starts a new one.
   */
  async humanWake(_taskId: string): Promise<TurnWake | null> {
    await this.__unsafe_ensureInitialized();
    return null;
  }

  /**
   * What the ledger holds for a task: the row, its work, its deliveries, and
   * the terminal status of every run it dispatched.
   *
   * The delivery rows are the evidence on a deployed spike, where no push sink
   * is reachable; the run statuses are how a cancel is checked, since "the task
   * is canceled" and "the child stopped" are two different facts.
   *
   * JSON rather than the shape itself: the `PlainTask` in it would cross the
   * RPC boundary through Cloudflare's type mapping, and on a `Think` subclass
   * that comparison already costs more instantiation depth than the compiler
   * has. A debug surface is the right place to pay a `JSON.parse` for that.
   */
  async inspect(taskId?: string): Promise<string> {
    await this.__unsafe_ensureInitialized();
    const row = taskId ? this.ledger.row(taskId) : null;
    const open = taskId ? this.ledger.openWorkRows(taskId) : [];
    const runs: { runId: string; status: string }[] = [];
    for (const work of taskId ? this.ledger.workRows(taskId) : []) {
      if (work.kind !== "detached") continue;
      const child = await this.dynamicAgents.get(SpikeGeneral, work.workId);
      const inspection = await child.inspectAgentToolRun(work.workId);
      runs.push({
        runId: work.workId,
        status: inspection?.status ?? "unknown"
      });
    }
    return JSON.stringify({
      task: taskId ? this.ledger.get(taskId) : null,
      row: row
        ? { state: row.state, pendingDelivery: row.pendingDelivery }
        : null,
      work: (taskId ? this.ledger.workRows(taskId) : []).map((work) => ({
        workId: work.workId,
        kind: work.kind,
        open: open.some((candidate) => candidate.workId === work.workId)
      })),
      runs,
      deliveries: this.ledger.deliveries(taskId)
    });
  }

  // --- settlement ------------------------------------------------------------

  /**
   * The submission ledger's view of a turn, turned into the task lifecycle.
   *
   * Keyed on `metadata.taskId`: a submission without one is not a task's turn
   * and is none of this agent's business.
   */
  protected override async onSubmissionStatus(submission: {
    submissionId: string;
    status: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const taskId = submission.metadata?.taskId;
    if (typeof taskId !== "string") return;

    if (submission.status === "running") {
      if (this.ledger.markWorking(taskId) === "canceled") {
        await this.cancelSubmission(submission.submissionId, "task canceled");
      }
      return;
    }
    if (submission.status === "completed") {
      await this.settleCompleted(taskId);
      return;
    }
    if (submission.status === "error" || submission.status === "skipped") {
      await this.finish(
        taskId,
        buildFailedTask(taskId, this.contextOf(taskId), COPY.failed)
      );
    }
    // `aborted` is a guarded no-op: the cancel that caused it already settled
    // the row, and anything written here would be written over it.
  }

  /**
   * What a completed turn means for the task, in this order:
   *
   *  1. a question is pending → park, and the caller is asked;
   *  2. work is still open → this was an interim turn; push what it said and
   *     leave the task `working`;
   *  3. otherwise the turn is the answer.
   *
   * The order is the whole design: without (2) a detached dispatch would settle
   * the task the moment the parent turn ended, and the child's result would
   * arrive on a task the gatekeeper had already closed.
   */
  private async settleCompleted(taskId: string): Promise<void> {
    const row = this.ledger.row(taskId);
    if (!row || isTerminalState(row.state)) return;

    // The async read, not the synchronous `messages` getter: that one is empty
    // on a cold object, and a turn recovered after an eviction is exactly when
    // this runs on one.
    const outcome = readTurn(await this.getMessages(), taskId);

    if (outcome.ask) {
      const request: HitlRequestData = {
        type: HITL_REQUEST_TYPE,
        requestId: `${taskId}:${outcome.ask.toolCallId}`,
        requestKind: "choice",
        prompt: outcome.ask.question,
        options: outcome.ask.options,
        allowFreeform: true
      };
      const parked = buildInputRequiredTask(taskId, row.contextId, request);
      if (!this.ledger.park(parked, request)) return;
      await this.enqueueDelivery(taskId, parked);
      return;
    }

    if (this.ledger.openWork(taskId) > 0) {
      if (outcome.text) await this.push(taskId, outcome.text, "turn");
      return;
    }

    await this.finish(
      taskId,
      buildCompletedTask(
        taskId,
        row.contextId,
        outcome.reply || COPY.emptyReply
      )
    );
  }

  /** The guarded terminal write, then the durable callback, then the hooks. */
  private async finish(taskId: string, task: PlainTask): Promise<void> {
    if (!this.ledger.settle(task)) return;
    await this.enqueueDelivery(taskId, task);
    await settleTranscript(this.env, taskId, task.status.state);
  }

  /**
   * Hand one callback to the queue.
   *
   * `onSubmissionStatus` fires inside the turn slot and its errors are only
   * logged, so nothing there may be the thing that delivers. The stable id
   * makes a repeat replace the pending item instead of queueing a second one.
   */
  private async enqueueDelivery(taskId: string, task: Task): Promise<void> {
    const state = taskStateLabel(
      task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED
    );
    await this.queue<DeliveryJob>(
      "deliverTask",
      { taskId, state, task: Task.toJSON(task) },
      {
        id: `deliver:${taskId}:${state}`,
        retry: { maxAttempts: 8, baseDelayMs: 2_000, maxDelayMs: 300_000 }
      }
    );
  }

  /**
   * POST one callback. Throws on a non-2xx so the queue retries — this is the
   * delivery the whole turn exists for.
   */
  async deliverTask(job: DeliveryJob): Promise<void> {
    await this.__unsafe_ensureInitialized();
    const row = this.ledger.row(job.taskId);
    if (!row?.push) return;
    this.ledger.recordDelivery(job.taskId, job.state);
    await createPushChannel(this.env.A2A_SIGNING_KEY, row.push).deliver(
      Task.fromJSON(job.task)
    );
    this.ledger.clearPendingDelivery(job.taskId);
  }

  /** A question nobody answered. Guarded, so a late answer still wins. */
  async expireTask(payload: {
    taskId: string;
    requestId: string;
  }): Promise<void> {
    await this.__unsafe_ensureInitialized();
    const row = this.ledger.row(payload.taskId);
    if (!row || row.request?.requestId !== payload.requestId) return;
    await this.finish(
      payload.taskId,
      buildFailedTask(payload.taskId, row.contextId, COPY.questionExpired)
    );
  }

  // --- cancellation ----------------------------------------------------------

  /**
   * The one place a task becomes canceled: flip the row — terminal, so every
   * non-canceled write is refused afterwards — then stop what is still running
   * for it.
   *
   * The flip's verdict is what decides whether anything else happens. Reading
   * the state first and acting second is the race this closes.
   */
  private async markCanceled(
    taskId: string,
    task?: Task
  ): Promise<PlainTask | null> {
    const before = this.ledger.row(taskId);
    const canceled = task
      ? this.ledger.save(task)
        ? this.ledger.get(taskId)
        : null
      : this.ledger.cancel(taskId);
    if (!canceled) return null;

    const row = this.ledger.row(taskId);
    if (row?.submissionId) {
      await this.cancelSubmission(row.submissionId, "task canceled").catch(
        (err: unknown) => {
          console.warn("[spike] submission not canceled", {
            taskId,
            err: String(err)
          });
        }
      );
    }
    // `cancelSubmission` misses a recovered continuation, which runs under a
    // new request id — so the running turn is aborted directly as well.
    if (this.turnTaskId() === taskId) this.abortAllRequests();

    for (const work of this.ledger.openWorkRows(taskId)) {
      if (work.kind === "detached") {
        await this.cancelAgentTool(work.workId, "task canceled").catch(
          (err: unknown) => {
            console.warn("[spike] detached run not canceled", {
              runId: work.workId,
              err: String(err)
            });
          }
        );
      } else if (work.scheduleId) {
        await this.cancelSchedule(work.scheduleId);
      }
      this.ledger.closeWork(work.workId);
    }

    if (!before || !isTerminalState(before.state)) {
      await settleTranscript(this.env, taskId, TaskState.TASK_STATE_CANCELED);
    }
    return canceled;
  }

  // --- delegation ------------------------------------------------------------

  /**
   * Hand a job to the sub-agent and end the turn.
   *
   * The work row is written **before** the dispatch: a crash between the two
   * leaves an open row with no run, which the gatekeeper's hour closes, while
   * the other order leaves a run nothing is waiting for and a task that settles
   * early.
   */
  private generalLongTool() {
    return tool({
      description:
        "Hand a long job to the background sub-agent. It does not answer here: " +
        "the result arrives in a later turn, so say what you started and stop.",
      inputSchema: z.object({ task: z.string().min(1) }),
      execute: async ({ task }, { toolCallId }) => {
        const taskId = this.requireTurnTaskId();
        const runId = `detached:${toolCallId}`;
        this.ledger.addWork(runId, taskId, "detached", null);
        const dispatch = await this.runAgentTool(SpikeGeneral, {
          input: { task },
          runId,
          parentToolCallId: toolCallId,
          detached: { onFinish: "onSubAgentFinish" }
        });
        if (dispatch.status !== "running") {
          // A synchronous rejection wires no `onFinish`, so nothing would ever
          // close this row and the task would stay `working` for ever.
          this.ledger.closeWork(runId);
          return {
            error: dispatch.error ?? "the background job did not start"
          };
        }
        return { started: runId };
      }
    });
  }

  /** Sleep on the task and come back to it. The turn ends on the `stopWhen`. */
  private checkBackTool() {
    return tool({
      description:
        "Stop working and come back to this task later. The turn ends here.",
      inputSchema: z.object({
        seconds: z.number().int().min(1).max(3600),
        why: z.string().min(1)
      }),
      execute: async ({ seconds, why }) => {
        const taskId = this.requireTurnTaskId();
        const workId = `wait:${taskId}:${crypto.randomUUID()}`;
        const schedule = await this.schedule<CheckBackWake>(
          seconds,
          "onCheckBack",
          { taskId, workId, seconds, why }
        );
        this.ledger.addWork(workId, taskId, "wait", schedule.id);
        return { waiting: seconds, why };
      }
    });
  }

  /**
   * The `onFinish` every detached run is dispatched with.
   *
   * Delivery is exactly-once on the happy path and at-least-once under a crash,
   * so this has to be idempotent — which is what the guarded `closeWork` buys:
   * the first delivery closes the row and submits the follow-up turn, and a
   * repeat finds it closed and does nothing.
   */
  async onSubAgentFinish(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    await this.__unsafe_ensureInitialized();
    // A soft give-up. The child is still working and will fire this hook again
    // with its real result, so treating it as the answer would lose that.
    if (result.status === "interrupted" && result.childStillRunning) return;

    const taskId = this.ledger.taskOfWork(run.runId);
    if (!taskId) return;
    const row = this.ledger.row(taskId);
    if (!row || isTerminalState(row.state)) return;
    if (!this.ledger.closeWork(run.runId)) return;

    await this.replayNotes(run, taskId);
    await this.runTurn({
      mode: "submit",
      input: userMessage(
        `finish:${run.runId}`,
        this.formatDetachedCompletion(run, result),
        { taskId, contextId: row.contextId }
      ),
      idempotencyKey: `finish:${run.runId}`,
      metadata: { taskId }
    });
  }

  /** The wake a `check_back` scheduled. Same follow-up shape as a finished run. */
  async onCheckBack(wake: CheckBackWake): Promise<void> {
    await this.__unsafe_ensureInitialized();
    const row = this.ledger.row(wake.taskId);
    if (!row || isTerminalState(row.state)) return;
    if (!this.ledger.closeWork(wake.workId)) return;
    await this.runTurn({
      mode: "submit",
      input: userMessage(
        `wake:${wake.workId}`,
        `Waited ${wake.seconds}s: ${wake.why}`,
        { taskId: wake.taskId, contextId: row.contextId }
      ),
      idempotencyKey: `wake:${wake.workId}`,
      metadata: { taskId: wake.taskId }
    });
  }

  // --- the transcript --------------------------------------------------------

  /**
   * A child's live progress, while no turn of this agent is running.
   *
   * The task cannot come from `activeTurnMetadata` here — a detached run
   * reports with nothing active — so it comes from the work row the dispatch
   * wrote.
   */
  override async onProgress(
    run: AgentToolRunInfo,
    progress: AgentToolProgressSnapshot
  ): Promise<void> {
    if (progress.milestone !== "note") return;
    const taskId = this.ledger.taskOfWork(run.runId);
    if (!taskId) return;
    const data = progress.data as { key?: unknown; text?: unknown } | undefined;
    if (typeof data?.key !== "string") return;
    await this.note(
      taskId,
      run,
      String(data.text ?? progress.message ?? ""),
      data.key
    );
  }

  /**
   * Every note the child persisted, delivered again when the run finishes.
   *
   * `onProgress` is best-effort and is not replayed after an eviction, so the
   * live path can silently miss notes. The replay is safe because the artifact
   * dedupes on the note key — a note that did land is recorded once.
   */
  private async replayNotes(
    run: AgentToolRunInfo,
    taskId: string
  ): Promise<void> {
    try {
      const child = await this.dynamicAgents.get(SpikeGeneral, run.runId);
      for (const milestone of await milestonesOf(child, run.runId)) {
        if (milestone.name !== "note") continue;
        const data = milestone.data as
          { key?: unknown; text?: unknown } | undefined;
        if (typeof data?.key !== "string") continue;
        await this.note(taskId, run, String(data.text ?? ""), data.key);
      }
    } catch (err) {
      console.warn("[spike] milestones not replayed", {
        runId: run.runId,
        err: String(err)
      });
    }
  }

  private async note(
    taskId: string,
    run: AgentToolRunInfo,
    text: string,
    key: string
  ): Promise<void> {
    const channel = this.channel(taskId);
    if (!channel || !text) return;
    await transcribeNote(
      this.env,
      {
        taskId,
        origin: this.origin.peek(),
        source: { type: run.agentType, ordinal: run.displayOrder },
        text,
        key
      },
      (line) => channel.working(line, key)
    );
  }

  // --- small helpers ---------------------------------------------------------

  /** Best-effort progress. A post that does not arrive never fails a turn. */
  private async push(
    taskId: string,
    text: string,
    prefix: string
  ): Promise<void> {
    const channel = this.channel(taskId);
    if (!channel) return;
    await channel.working(text, this.ledger.nextPushKey(taskId, prefix));
  }

  private channel(taskId: string): PushChannel | null {
    const push: TurnPushContext | null = this.ledger.row(taskId)?.push ?? null;
    return push ? createPushChannel(this.env.A2A_SIGNING_KEY, push) : null;
  }

  private contextOf(taskId: string): string {
    return this.ledger.row(taskId)?.contextId ?? "";
  }

  /** The task the running turn belongs to, from the message that started it. */
  private turnTaskId(): string | undefined {
    const metadata = this.activeTurnMetadata as
      { taskId?: unknown } | undefined;
    return typeof metadata?.taskId === "string" ? metadata.taskId : undefined;
  }

  private requireTurnTaskId(): string {
    const taskId = this.turnTaskId();
    if (!taskId) {
      throw new Error(
        "this turn carries no task id: a tool that records work has to run " +
          "inside a turn submitted with `metadata.turnMetadata.taskId`"
      );
    }
    return taskId;
  }
}

/**
 * The milestones a child persisted for one run.
 *
 * `inspectAgentToolRun` returns them — `_inspectionFromChildRow` reads the
 * milestone table and spreads them onto the inspection — but Think's own
 * `AgentToolRunInspection` type omits the field that `agents`' copy declares.
 * Narrowed here rather than at every call site, so the gap has one home.
 */
async function milestonesOf(
  child: { inspectAgentToolRun(runId: string): Promise<unknown> },
  runId: string
): Promise<AgentToolMilestone[]> {
  const inspection = (await child.inspectAgentToolRun(runId)) as {
    milestones?: AgentToolMilestone[];
  } | null;
  return inspection?.milestones ?? [];
}

/**
 * One submitted user message.
 *
 * The task id rides in `metadata.turnMetadata` rather than on the submission's
 * own `metadata`, because only the message's copy is visible during the turn
 * (`activeTurnMetadata`) and survives into a recovered one. The submission
 * metadata carries it too, for `onSubmissionStatus`, which sees that one alone.
 */
function userMessage(
  id: string,
  text: string,
  turnMetadata: { taskId: string; contextId: string }
): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { turnMetadata }
  };
}

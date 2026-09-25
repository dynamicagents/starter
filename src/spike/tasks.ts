import { Task, TaskState } from "@a2a-js/sdk";
import type { HitlRequestData } from "@dynamicagents/core/a2a";
import {
  buildSubmittedTask,
  taskStateLabel,
  type PlainTask,
  type TurnPushContext
} from "@dynamicagents/core/a2a";

/**
 * The A2A task ledger, on `ctx.storage.sql` directly.
 *
 * Two things move here from the drizzle `AgentDB` this replaces, and both are
 * the point of the spike:
 *
 *  - **Every transition is a guarded write.** The `UPDATE … WHERE state IN (…)`
 *    is what decides, and the row it returns is the verdict. A caller that
 *    reads the state first and acts second reopens the window in which a cancel
 *    lands and the gatekeeper still gets a `completed` callback.
 *  - **Open work keeps a task alive across turns.** A detached sub-agent run or
 *    a scheduled wake is a row here, and settlement asks this table — not the
 *    model — whether the task is finished.
 */

/** The states a task never leaves. */
const TERMINAL = new Set(["completed", "failed", "canceled", "rejected"]);

/** The states a `working` or terminal write may be applied over. */
const OPEN = ["submitted", "working", "input-required"];

export function isTerminalState(state: string): boolean {
  return TERMINAL.has(state);
}

/** What keeps a task open across turns. Only these two hold it `working`. */
export type WorkKind = "detached" | "wait";

export interface WorkRow {
  workId: string;
  taskId: string;
  kind: WorkKind;
  scheduleId: string | null;
}

/** One task row, less the blob — everything a caller needs to act on it. */
export interface TaskRow {
  taskId: string;
  messageId: string | null;
  contextId: string;
  state: string;
  text: string;
  push: TurnPushContext | null;
  submissionId: string | null;
  /** The question the task is parked on, or `null` when it is not parked. */
  request: HitlRequestData | null;
  pendingDelivery: boolean;
}

export interface DeliveryRow {
  taskId: string;
  state: string;
  at: number;
}

/** The tagged-template `sql` every `Agent` exposes. */
type Sql = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

interface StoredRow {
  task_id: string;
  message_id: string | null;
  context_id: string;
  state: string;
  task_json: string;
  text: string;
  push_json: string | null;
  submission_id: string | null;
  request_json: string | null;
  pending_delivery: number;
  push_seq: number;
}

export class SpikeTasks {
  private ensured = false;

  constructor(private readonly sql: Sql) {}

  /**
   * Idempotent DDL, run before the first statement rather than at construction:
   * a Durable Object builds this handle in a field initializer, where there is
   * no storage to write to yet.
   */
  private ensure(): void {
    if (this.ensured) return;
    this.sql`CREATE TABLE IF NOT EXISTS spike_a2a_tasks (
      task_id TEXT PRIMARY KEY,
      message_id TEXT UNIQUE,
      context_id TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      task_json TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      push_json TEXT,
      identity_json TEXT,
      submission_id TEXT,
      request_json TEXT,
      pending_delivery INTEGER NOT NULL DEFAULT 0,
      push_seq INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS spike_a2a_work (
      work_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      schedule_id TEXT,
      open INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS spike_deliveries (
      task_id TEXT NOT NULL,
      state TEXT NOT NULL,
      at INTEGER NOT NULL
    )`;
    this.ensured = true;
  }

  // --- reads ---------------------------------------------------------------

  private stored(taskId: string): StoredRow | null {
    this.ensure();
    const rows = this.sql<StoredRow>`
      SELECT * FROM spike_a2a_tasks WHERE task_id = ${taskId}`;
    return rows[0] ?? null;
  }

  row(taskId: string): TaskRow | null {
    const row = this.stored(taskId);
    return row ? project(row) : null;
  }

  get(taskId: string): PlainTask | null {
    const row = this.stored(taskId);
    return row ? parse(row.task_json) : null;
  }

  list(query: {
    contextId?: string;
    state?: TaskState;
    updatedAfter?: number;
    includeArtifacts: boolean;
    historyLength?: number;
    limit: number;
    offset: number;
  }): { tasks: PlainTask[]; totalSize: number } {
    this.ensure();
    const contextId = query.contextId ?? "";
    const state = query.state === undefined ? "" : taskStateLabel(query.state);
    const updatedAfter = query.updatedAfter ?? 0;
    // One statement with neutral sentinels rather than a built-up WHERE: the
    // tagged template takes values, not fragments.
    const rows = this.sql<StoredRow>`
      SELECT * FROM spike_a2a_tasks
      WHERE (${contextId} = '' OR context_id = ${contextId})
        AND (${state} = '' OR state = ${state})
        AND updated_at >= ${updatedAfter}
      ORDER BY created_at DESC
      LIMIT ${query.limit} OFFSET ${query.offset}`;
    const total = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM spike_a2a_tasks
      WHERE (${contextId} = '' OR context_id = ${contextId})
        AND (${state} = '' OR state = ${state})
        AND updated_at >= ${updatedAfter}`;
    return {
      tasks: rows.map((r) => shape(parse(r.task_json), query)),
      totalSize: total[0]?.n ?? 0
    };
  }

  /** Tasks whose terminal callback has not been acknowledged as delivered. */
  pendingDeliveries(): { taskId: string; state: string }[] {
    this.ensure();
    return this.sql<{ taskId: string; state: string }>`
      SELECT task_id AS taskId, state FROM spike_a2a_tasks
      WHERE pending_delivery = 1`;
  }

  // --- writes --------------------------------------------------------------

  /**
   * Record (or reuse) the `submitted` task for a turn. Idempotent on
   * `messageId` — the gatekeeper retries dispatch, and the whole
   * accept-and-notify contract rests on that retry recording once.
   */
  accept(input: {
    messageId: string;
    taskId: string;
    contextId: string;
  }): TaskRow {
    this.ensure();
    const existing = this.sql<StoredRow>`
      SELECT * FROM spike_a2a_tasks WHERE message_id = ${input.messageId}`;
    if (existing[0]) return project(existing[0]);

    const task = buildSubmittedTask(input.taskId, input.contextId);
    const now = Date.now();
    this.sql`INSERT INTO spike_a2a_tasks
      (task_id, message_id, context_id, state, task_json, created_at, updated_at)
      VALUES (${task.id}, ${input.messageId}, ${task.contextId},
              ${taskStateLabel(task.status.state)}, ${serialize(task)},
              ${now}, ${now})`;
    return project(this.stored(task.id)!);
  }

  /** Attach the turn's push config and text once the executor forwards them. */
  bindTurn(input: {
    taskId: string;
    text: string;
    push: TurnPushContext;
    identity: unknown;
  }): void {
    this.ensure();
    this.sql`UPDATE spike_a2a_tasks
      SET text = ${input.text},
          push_json = ${JSON.stringify(input.push)},
          identity_json = ${JSON.stringify(input.identity ?? null)},
          updated_at = ${Date.now()}
      WHERE task_id = ${input.taskId}`;
  }

  bindSubmission(taskId: string, submissionId: string): void {
    this.ensure();
    this.sql`UPDATE spike_a2a_tasks SET submission_id = ${submissionId}
      WHERE task_id = ${taskId} AND submission_id IS NULL`;
  }

  /**
   * The next notification key for this task.
   *
   * Derived from a durable counter rather than a clock or the content: the
   * gatekeeper dedupes on `${taskId}:${key}`, so the key has to be stable
   * across a redelivery and distinct between two progress posts.
   */
  nextPushKey(taskId: string, prefix: string): string {
    this.ensure();
    const rows = this.sql<{ push_seq: number }>`
      UPDATE spike_a2a_tasks SET push_seq = push_seq + 1
      WHERE task_id = ${taskId} RETURNING push_seq`;
    return `${prefix}:${rows[0]?.push_seq ?? 0}`;
  }

  /**
   * Upsert a task by id, preserving `message_id`. Returns whether the write
   * applied.
   *
   * The guards, each closing a race the spike can actually reach:
   *  - nothing overwrites `canceled`;
   *  - `canceled` is only written over a task still running or parked;
   *  - one terminal state is never replaced by a different one;
   *  - a `submitted` snapshot never lands on a task that has moved past it —
   *    the a2a-js request handler re-saves the accepted task it published
   *    while the turn is already running in the object.
   */
  save(task: Task): boolean {
    this.ensure();
    const incoming = taskStateLabel(
      task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED
    );
    const existing = this.stored(task.id);
    if (!existing) {
      const now = Date.now();
      this.sql`INSERT INTO spike_a2a_tasks
        (task_id, context_id, state, task_json, created_at, updated_at)
        VALUES (${task.id}, ${task.contextId}, ${incoming}, ${serialize(task)},
                ${now}, ${now})`;
      return true;
    }
    const current = existing.state;
    if (current === "canceled" && incoming !== "canceled") return false;
    if (
      incoming === "canceled" &&
      !OPEN.includes(current) &&
      current !== "canceled"
    ) {
      return false;
    }
    if (
      isTerminalState(current) &&
      isTerminalState(incoming) &&
      incoming !== current
    ) {
      return false;
    }
    if (incoming === "submitted" && current !== "submitted") return false;
    this.write(task.id, incoming, task);
    return true;
  }

  /**
   * Move a task to `working`. `"canceled"` is the caller's signal to stop;
   * every other outcome — unknown row, or one already past `submitted` — is a
   * no-op reported as `"ok"`, because a retried submission re-runs this.
   */
  markWorking(taskId: string): "ok" | "canceled" {
    const row = this.stored(taskId);
    if (!row) return "ok";
    if (row.state === "canceled") return "canceled";
    if (row.state !== "submitted") return "ok";
    const task = parse(row.task_json);
    task.status = {
      state: TaskState.TASK_STATE_WORKING,
      message: task.status?.message,
      timestamp: new Date().toISOString()
    };
    this.write(taskId, "working", task);
    return "ok";
  }

  /**
   * Flip the task to `canceled` and return it, or `null` when the row is not
   * eligible. A task parked on a question is eligible: it is waiting, and a
   * cancel is how it stops waiting.
   */
  cancel(taskId: string): PlainTask | null {
    const row = this.stored(taskId);
    if (!row || !OPEN.includes(row.state)) return null;
    const task = parse(row.task_json);
    task.status = {
      state: TaskState.TASK_STATE_CANCELED,
      message: task.status?.message,
      timestamp: new Date().toISOString()
    };
    this.write(taskId, "canceled", task);
    return task;
  }

  /** Park a running task on a question, and mark the question for delivery. */
  park(task: Task, request: HitlRequestData): boolean {
    this.ensure();
    const rows = this.sql<{ task_id: string }>`
      UPDATE spike_a2a_tasks
      SET state = 'input-required', task_json = ${serialize(task)},
          request_json = ${JSON.stringify(request)}, pending_delivery = 1,
          updated_at = ${Date.now()}
      WHERE task_id = ${task.id} AND state IN ('working', 'input-required')
      RETURNING task_id`;
    return rows.length > 0;
  }

  /**
   * Take a parked task back to `working`, and return it — or `null` when it is
   * not parked, which is what a retried answer finds after the first resumed it.
   */
  resume(taskId: string): PlainTask | null {
    const row = this.stored(taskId);
    if (!row || row.state !== "input-required") return null;
    const task = parse(row.task_json);
    task.status = {
      state: TaskState.TASK_STATE_WORKING,
      message: undefined,
      timestamp: new Date().toISOString()
    };
    this.ensure();
    const rows = this.sql<{ task_id: string }>`
      UPDATE spike_a2a_tasks
      SET state = 'working', task_json = ${serialize(task)},
          request_json = NULL, updated_at = ${Date.now()}
      WHERE task_id = ${taskId} AND state = 'input-required'
      RETURNING task_id`;
    return rows.length > 0 ? task : null;
  }

  /**
   * The one terminal transition, guarded on the source state and marking the
   * callback for delivery in the same statement — so a crash between settling
   * and queueing leaves evidence the sweep at start can act on.
   */
  settle(task: Task): boolean {
    this.ensure();
    const state = taskStateLabel(
      task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED
    );
    const rows = this.sql<{ task_id: string }>`
      UPDATE spike_a2a_tasks
      SET state = ${state}, task_json = ${serialize(task)},
          pending_delivery = 1, request_json = NULL, updated_at = ${Date.now()}
      WHERE task_id = ${task.id}
        AND state IN ('submitted', 'working', 'input-required')
      RETURNING task_id`;
    return rows.length > 0;
  }

  clearPendingDelivery(taskId: string): void {
    this.ensure();
    this.sql`UPDATE spike_a2a_tasks SET pending_delivery = 0
      WHERE task_id = ${taskId}`;
  }

  private write(taskId: string, state: string, task: Task): void {
    this.sql`UPDATE spike_a2a_tasks
      SET state = ${state}, task_json = ${serialize(task)},
          context_id = ${task.contextId}, updated_at = ${Date.now()}
      WHERE task_id = ${taskId}`;
  }

  // --- the work ledger -----------------------------------------------------

  addWork(
    workId: string,
    taskId: string,
    kind: WorkKind,
    scheduleId: string | null
  ): void {
    this.ensure();
    this.sql`INSERT OR IGNORE INTO spike_a2a_work
      (work_id, task_id, kind, schedule_id, open, created_at)
      VALUES (${workId}, ${taskId}, ${kind}, ${scheduleId}, 1, ${Date.now()})`;
  }

  /**
   * Close one open work row, answering whether *this* call closed it.
   *
   * Guarded because detached delivery is at-least-once under a crash: the
   * boolean is what makes the follow-up turn fire once per run rather than once
   * per delivery.
   */
  closeWork(workId: string): boolean {
    this.ensure();
    const rows = this.sql<{ work_id: string }>`
      UPDATE spike_a2a_work SET open = 0
      WHERE work_id = ${workId} AND open = 1 RETURNING work_id`;
    return rows.length > 0;
  }

  openWork(taskId: string): number {
    this.ensure();
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM spike_a2a_work
      WHERE task_id = ${taskId} AND open = 1`;
    return rows[0]?.n ?? 0;
  }

  openWorkRows(taskId: string): WorkRow[] {
    this.ensure();
    return this.sql<StoredWorkRow>`
      SELECT work_id, task_id, kind, schedule_id FROM spike_a2a_work
      WHERE task_id = ${taskId} AND open = 1`.map(projectWork);
  }

  /** Every work row of a task, closed ones included — the inspection view. */
  workRows(taskId: string): WorkRow[] {
    this.ensure();
    return this.sql<StoredWorkRow>`
      SELECT work_id, task_id, kind, schedule_id FROM spike_a2a_work
      WHERE task_id = ${taskId} ORDER BY created_at ASC`.map(projectWork);
  }

  /** The task a detached run or a scheduled wake belongs to. */
  taskOfWork(workId: string): string | null {
    this.ensure();
    const rows = this.sql<{ task_id: string }>`
      SELECT task_id FROM spike_a2a_work WHERE work_id = ${workId}`;
    return rows[0]?.task_id ?? null;
  }

  // --- the delivery record -------------------------------------------------

  /**
   * One attempted terminal callback. On the deployed spike no push sink is
   * reachable, so this table is the only evidence that delivery happened at
   * all — and how many times.
   */
  recordDelivery(taskId: string, state: string): void {
    this.ensure();
    this.sql`INSERT INTO spike_deliveries (task_id, state, at)
      VALUES (${taskId}, ${state}, ${Date.now()})`;
  }

  deliveries(taskId?: string): DeliveryRow[] {
    this.ensure();
    const filter = taskId ?? "";
    return this.sql<DeliveryRow>`
      SELECT task_id AS taskId, state, at FROM spike_deliveries
      WHERE (${filter} = '' OR task_id = ${filter})
      ORDER BY at ASC`;
  }
}

// --- encoding ---------------------------------------------------------------

/**
 * Rows hold the task in its **A2A wire form**, not the in-memory protobuf
 * shape: under v1.0 enums are numbers in memory and `SCREAMING_SNAKE` strings
 * on the wire, and `Part.content` is a `{ $case, value }` wrapper in memory and
 * a bare named key on the wire. A plain `JSON.stringify` would persist a shape
 * that is neither valid A2A JSON nor stable across SDK versions.
 */
function serialize(task: Task): string {
  return JSON.stringify(Task.toJSON(task));
}

function parse(json: string): PlainTask {
  return Task.fromJSON(JSON.parse(json)) as PlainTask;
}

interface StoredWorkRow {
  work_id: string;
  task_id: string;
  kind: string;
  schedule_id: string | null;
}

function projectWork(row: StoredWorkRow): WorkRow {
  return {
    workId: row.work_id,
    taskId: row.task_id,
    kind: row.kind as WorkKind,
    scheduleId: row.schedule_id
  };
}

function project(row: StoredRow): TaskRow {
  return {
    taskId: row.task_id,
    messageId: row.message_id,
    contextId: row.context_id,
    state: row.state,
    text: row.text,
    push: row.push_json ? (JSON.parse(row.push_json) as TurnPushContext) : null,
    submissionId: row.submission_id,
    request: row.request_json
      ? (JSON.parse(row.request_json) as HitlRequestData)
      : null,
    pendingDelivery: row.pending_delivery === 1
  };
}

/** Apply the `ListTasks` response-shaping options to one stored task. */
function shape(
  task: PlainTask,
  query: { includeArtifacts: boolean; historyLength?: number }
): PlainTask {
  const history = task.history ?? [];
  return {
    ...task,
    artifacts: query.includeArtifacts ? (task.artifacts ?? []) : [],
    history:
      query.historyLength === undefined
        ? history
        : history.slice(Math.max(0, history.length - query.historyLength))
  };
}

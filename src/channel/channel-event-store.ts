import type { DatabaseSync, StatementSync } from "node:sqlite";
import type {
  ChannelAdapterIdentity,
  ChannelConversationKind,
  ChannelDeliveryReceipt,
  ChannelInboundText,
  ChannelMessageFormat,
  ChannelOutboundText,
} from "./channel-types.js";
import {
  isChannelConversationKind,
  isChannelMessageFormat,
} from "./channel-types.js";

export type ChannelInboxStatus =
  | "received"
  | "running"
  | "completed"
  | "failed"
  | "uncertain";

export type ChannelOutboxStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "dead"
  | "uncertain";

export interface ChannelInboxInput {
  readonly adapter: ChannelAdapterIdentity;
  readonly message: ChannelInboundText;
  readonly sessionId: string;
  /** Canonical userId returned by the access policy, never a raw platform ID. */
  readonly userId: string;
}

export interface ChannelInboxRecord {
  readonly id: number;
  /** Monotonic local sequence used to order events during dispatch/recovery. */
  readonly sequence: number;
  readonly adapter: ChannelAdapterIdentity;
  readonly message: ChannelInboundText;
  readonly sessionId: string;
  readonly userId: string;
  readonly status: ChannelInboxStatus;
  readonly errorMessage: string | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type ChannelInboxClaim =
  | { readonly status: "accepted"; readonly record: ChannelInboxRecord }
  | { readonly status: "duplicate"; readonly record: ChannelInboxRecord };

export interface ChannelOutboxInput {
  readonly adapter: ChannelAdapterIdentity;
  readonly sessionId: string;
  /** Canonical userId bound to the target Agent session. */
  readonly userId: string;
  readonly delivery: ChannelOutboundText;
}

export interface ChannelOutboxRecord {
  readonly id: number;
  readonly inboxId: number | null;
  readonly adapter: ChannelAdapterIdentity;
  readonly sessionId: string;
  readonly userId: string;
  readonly delivery: ChannelOutboundText;
  readonly status: ChannelOutboxStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: number;
  readonly lastError: string | null;
  readonly platformMessageIds: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sentAt: number | null;
}

export interface ChannelOutboxEnqueueOptions {
  readonly inboxId?: number | null;
  readonly now?: number;
}

export interface ChannelInboxFailureOptions {
  readonly status?: "failed" | "uncertain";
  readonly now?: number;
}

export interface ChannelOutboxFailureOptions {
  readonly nextAttemptAt: number;
  readonly terminal?: boolean;
}

export interface ChannelInboxListOptions {
  readonly sessionId?: string;
  readonly status?: ChannelInboxStatus | readonly ChannelInboxStatus[];
  readonly limit?: number;
}

export interface ChannelOutboxListOptions {
  readonly inboxId?: number | null;
  readonly status?: ChannelOutboxStatus | readonly ChannelOutboxStatus[];
  readonly limit?: number;
}

export interface ChannelOutboxClaimOptions {
  readonly now?: number;
  readonly limit?: number;
}

export interface ChannelEventRecoveryResult {
  readonly inboxesMarkedUncertain: number;
  readonly outboxesMarkedUncertain: number;
}

/**
 * Persistence boundary for transport state. It intentionally lives beside the
 * session store rather than inside canonical `messages`: delivery retries and
 * inbound deduplication are operational records, not Agent conversation data.
 */
export interface ChannelEventStore {
  claimInbound(input: ChannelInboxInput, now?: number): Promise<ChannelInboxClaim>;
  getInbox(id: number): Promise<ChannelInboxRecord | null>;
  listInbox(options?: ChannelInboxListOptions): Promise<ChannelInboxRecord[]>;
  markInboundRunning(id: number, now?: number): Promise<boolean>;
  markInboundFailed(
    id: number,
    error: string,
    options?: ChannelInboxFailureOptions,
  ): Promise<boolean>;
  /** Mark an inbound turn complete and enqueue its final deliveries atomically. */
  finalizeInbound(
    id: number,
    deliveries: readonly ChannelOutboxInput[],
    now?: number,
  ): Promise<readonly ChannelOutboxRecord[]>;
  enqueueOutbox(
    input: ChannelOutboxInput,
    options?: ChannelOutboxEnqueueOptions,
  ): Promise<ChannelOutboxRecord>;
  getOutbox(id: number): Promise<ChannelOutboxRecord | null>;
  listOutbox(options?: ChannelOutboxListOptions): Promise<ChannelOutboxRecord[]>;
  listOutboxForInbox(inboxId: number): Promise<ChannelOutboxRecord[]>;
  claimDueOutbox(
    options?: ChannelOutboxClaimOptions,
  ): Promise<ChannelOutboxRecord[]>;
  markOutboxSent(
    id: number,
    receipt: ChannelDeliveryReceipt,
    now?: number,
  ): Promise<boolean>;
  markOutboxFailed(
    id: number,
    error: string,
    options: ChannelOutboxFailureOptions,
    now?: number,
  ): Promise<boolean>;
  /** Recover work left in running/sending after a process crash. */
  recoverInFlight(now?: number): Promise<ChannelEventRecoveryResult>;
}

export class ChannelEventConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelEventConflictError";
  }
}

export class ChannelEventStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelEventStateError";
  }
}

const DEFAULT_EVENT_LIST_LIMIT = 100;
const MAX_EVENT_LIST_LIMIT = 500;
const MAX_CHANNEL_TEXT_LENGTH = 1_048_576;
const MAX_ERROR_LENGTH = 4_096;
const MAX_PLATFORM_MESSAGE_IDS = 100;
const WRITE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;

const INBOX_STATUSES: readonly ChannelInboxStatus[] = [
  "received",
  "running",
  "completed",
  "failed",
  "uncertain",
];
const OUTBOX_STATUSES: readonly ChannelOutboxStatus[] = [
  "pending",
  "sending",
  "sent",
  "failed",
  "dead",
  "uncertain",
];

export class InMemoryChannelEventStore implements ChannelEventStore {
  private nextInboxId = 1;
  private nextOutboxId = 1;
  private readonly inbox = new Map<number, ChannelInboxRecord>();
  private readonly inboxKeys = new Map<string, number>();
  private readonly outbox = new Map<number, ChannelOutboxRecord>();
  private readonly deliveryIds = new Map<string, number>();

  async claimInbound(
    input: ChannelInboxInput,
    now = Date.now(),
  ): Promise<ChannelInboxClaim> {
    const normalized = normalizeInboxInput(input);
    const createdAt = normalizeTimestamp(now, "now");
    const key = inboundKey(normalized.adapter, normalized.message.externalMessageId);
    const existingId = this.inboxKeys.get(key);
    if (existingId !== undefined) {
      const existing = this.requireInbox(existingId);
      assertSameInbound(existing, normalized);
      return { status: "duplicate", record: cloneInbox(existing) };
    }

    const id = this.nextInboxId++;
    const record: ChannelInboxRecord = {
      id,
      sequence: id,
      adapter: normalized.adapter,
      message: normalized.message,
      sessionId: normalized.sessionId,
      userId: normalized.userId,
      status: "received",
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    this.inbox.set(id, record);
    this.inboxKeys.set(key, id);
    return { status: "accepted", record: cloneInbox(record) };
  }

  async getInbox(id: number): Promise<ChannelInboxRecord | null> {
    const record = this.inbox.get(requirePositiveId(id, "inboxId"));
    return record ? cloneInbox(record) : null;
  }

  async listInbox(
    options: ChannelInboxListOptions = {},
  ): Promise<ChannelInboxRecord[]> {
    const limit = normalizeLimit(options.limit);
    const statuses = normalizeStatusFilter(options.status, INBOX_STATUSES);
    return [...this.inbox.values()]
      .filter((record) => {
        if (options.sessionId !== undefined && record.sessionId !== options.sessionId) {
          return false;
        }
        return !statuses || statuses.includes(record.status);
      })
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, limit)
      .map(cloneInbox);
  }

  async markInboundRunning(id: number, now = Date.now()): Promise<boolean> {
    const record = this.requireInbox(id);
    const timestamp = normalizeTimestamp(now, "now");
    if (record.status !== "received") return false;
    replaceInbox(record, {
      status: "running",
      startedAt: timestamp,
      updatedAt: timestamp,
    });
    return true;
  }

  async markInboundFailed(
    id: number,
    error: string,
    options: ChannelInboxFailureOptions = {},
  ): Promise<boolean> {
    const record = this.requireInbox(id);
    const status = options.status ?? "failed";
    const timestamp = normalizeTimestamp(options.now ?? Date.now(), "now");
    if (record.status !== "received" && record.status !== "running") return false;
    replaceInbox(record, {
      status,
      errorMessage: normalizeError(error),
      completedAt: status === "failed" ? timestamp : null,
      updatedAt: timestamp,
    });
    return true;
  }

  async finalizeInbound(
    id: number,
    deliveries: readonly ChannelOutboxInput[],
    now = Date.now(),
  ): Promise<readonly ChannelOutboxRecord[]> {
    const record = this.requireInbox(id);
    const timestamp = normalizeTimestamp(now, "now");
    if (record.status === "completed") {
      return this.listOutboxForInbox(id);
    }
    if (record.status !== "received" && record.status !== "running") {
      throw new ChannelEventStateError(
        `Inbox ${id} 当前状态为 ${record.status}，不能完成。`,
      );
    }

    const normalized = deliveries.map((input) =>
      normalizeOutboxInput(input),
    );
    assertNoConflictingDeliveries(normalized);
    for (const input of normalized) {
      assertOutboxMatchesInbox(input, record);
      const existingId = this.deliveryIds.get(input.delivery.deliveryId);
      if (existingId !== undefined) {
        const existing = this.requireOutbox(existingId);
        assertSameOutbox(existing, input, id);
      }
    }

    for (const input of normalized) {
      if (this.deliveryIds.has(input.delivery.deliveryId)) continue;
      this.insertOutbox(input, id, timestamp);
    }
    replaceInbox(record, {
      status: "completed",
      errorMessage: null,
      completedAt: timestamp,
      updatedAt: timestamp,
    });
    return this.listOutboxForInbox(id);
  }

  async enqueueOutbox(
    input: ChannelOutboxInput,
    options: ChannelOutboxEnqueueOptions = {},
  ): Promise<ChannelOutboxRecord> {
    const normalized = normalizeOutboxInput(input);
    const timestamp = normalizeTimestamp(options.now ?? Date.now(), "now");
    const inboxId = normalizeOptionalId(options.inboxId, "inboxId");
    if (inboxId !== null) {
      const inbox = this.inbox.get(inboxId);
      if (!inbox) throw new ChannelEventStateError(`Inbox ${inboxId} 不存在。`);
      assertOutboxMatchesInbox(normalized, inbox);
    }

    const existingId = this.deliveryIds.get(normalized.delivery.deliveryId);
    if (existingId !== undefined) {
      const existing = this.requireOutbox(existingId);
      assertSameOutbox(existing, normalized, inboxId);
      return cloneOutbox(existing);
    }

    const id = this.insertOutbox(normalized, inboxId, timestamp);
    return cloneOutbox(this.requireOutbox(id));
  }

  async getOutbox(id: number): Promise<ChannelOutboxRecord | null> {
    const record = this.outbox.get(requirePositiveId(id, "outboxId"));
    return record ? cloneOutbox(record) : null;
  }

  async listOutbox(
    options: ChannelOutboxListOptions = {},
  ): Promise<ChannelOutboxRecord[]> {
    const limit = normalizeLimit(options.limit);
    const statuses = normalizeStatusFilter(options.status, OUTBOX_STATUSES);
    return [...this.outbox.values()]
      .filter((record) => {
        if (options.inboxId !== undefined && record.inboxId !== options.inboxId) {
          return false;
        }
        return !statuses || statuses.includes(record.status);
      })
      .sort((left, right) => left.id - right.id)
      .slice(0, limit)
      .map(cloneOutbox);
  }

  async listOutboxForInbox(inboxId: number): Promise<ChannelOutboxRecord[]> {
    return this.listOutbox({ inboxId: requirePositiveId(inboxId, "inboxId") });
  }

  async claimDueOutbox(
    options: ChannelOutboxClaimOptions = {},
  ): Promise<ChannelOutboxRecord[]> {
    const timestamp = normalizeTimestamp(options.now ?? Date.now(), "now");
    const limit = normalizeLimit(options.limit);
    const records = [...this.outbox.values()]
      .filter(
        (record) =>
          (record.status === "pending" ||
            record.status === "failed" ||
            record.status === "uncertain") &&
          record.nextAttemptAt <= timestamp,
      )
      .sort((left, right) => left.id - right.id)
      .slice(0, limit);
    for (const record of records) {
      replaceOutbox(record, {
        status: "sending",
        attemptCount: record.attemptCount + 1,
        updatedAt: timestamp,
      });
    }
    return records.map(cloneOutbox);
  }

  async markOutboxSent(
    id: number,
    receipt: ChannelDeliveryReceipt,
    now = Date.now(),
  ): Promise<boolean> {
    const record = this.requireOutbox(id);
    const normalizedReceipt = normalizeReceipt(receipt);
    const timestamp = normalizeTimestamp(now, "now");
    if (record.status !== "sending") return false;
    replaceOutbox(record, {
      status: "sent",
      platformMessageIds: normalizedReceipt.platformMessageIds,
      sentAt: normalizedReceipt.deliveredAt,
      updatedAt: timestamp,
      lastError: null,
    });
    return true;
  }

  async markOutboxFailed(
    id: number,
    error: string,
    options: ChannelOutboxFailureOptions,
    now = Date.now(),
  ): Promise<boolean> {
    const record = this.requireOutbox(id);
    const timestamp = normalizeTimestamp(now, "now");
    const nextAttemptAt = normalizeTimestamp(
      options.nextAttemptAt,
      "nextAttemptAt",
    );
    if (record.status !== "sending") return false;
    replaceOutbox(record, {
      status: options.terminal ? "dead" : "failed",
      lastError: normalizeError(error),
      nextAttemptAt,
      updatedAt: timestamp,
    });
    return true;
  }

  async recoverInFlight(now = Date.now()): Promise<ChannelEventRecoveryResult> {
    const timestamp = normalizeTimestamp(now, "now");
    let inboxesMarkedUncertain = 0;
    let outboxesMarkedUncertain = 0;
    for (const record of this.inbox.values()) {
      if (record.status !== "running") continue;
      replaceInbox(record, {
        status: "uncertain",
        errorMessage: "进程重启时该入站 turn 仍在执行，已标记为 uncertain。",
        updatedAt: timestamp,
      });
      inboxesMarkedUncertain += 1;
    }
    for (const record of this.outbox.values()) {
      if (record.status !== "sending") continue;
      replaceOutbox(record, {
        status: "uncertain",
        nextAttemptAt: timestamp,
        updatedAt: timestamp,
      });
      outboxesMarkedUncertain += 1;
    }
    return { inboxesMarkedUncertain, outboxesMarkedUncertain };
  }

  private insertOutbox(
    input: NormalizedChannelOutboxInput,
    inboxId: number | null,
    timestamp: number,
  ): number {
    const id = this.nextOutboxId++;
    const record: ChannelOutboxRecord = {
      id,
      inboxId,
      adapter: input.adapter,
      sessionId: input.sessionId,
      userId: input.userId,
      delivery: input.delivery,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: timestamp,
      lastError: null,
      platformMessageIds: Object.freeze([]),
      createdAt: timestamp,
      updatedAt: timestamp,
      sentAt: null,
    };
    this.outbox.set(id, record);
    this.deliveryIds.set(input.delivery.deliveryId, id);
    return id;
  }

  private requireInbox(id: number): ChannelInboxRecord {
    const normalizedId = requirePositiveId(id, "inboxId");
    const record = this.inbox.get(normalizedId);
    if (!record) throw new ChannelEventStateError(`Inbox ${id} 不存在。`);
    return record;
  }

  private requireOutbox(id: number): ChannelOutboxRecord {
    const normalizedId = requirePositiveId(id, "outboxId");
    const record = this.outbox.get(normalizedId);
    if (!record) throw new ChannelEventStateError(`Outbox ${id} 不存在。`);
    return record;
  }
}

/**
 * SQLite implementation is constructed with the same DatabaseSync connection
 * as SqliteSessionStore, so Inbox/Outbox writes share its WAL/transaction and
 * do not create a second approval or persistence owner.
 */
export class SqliteChannelEventStore implements ChannelEventStore {
  private readonly database: DatabaseSync;
  private readonly getInboxStatement: StatementSync;
  private readonly getInboxByKeyStatement: StatementSync;
  private readonly insertInboxStatement: StatementSync;
  private readonly markInboxRunningStatement: StatementSync;
  private readonly markInboxFailedStatement: StatementSync;
  private readonly markInboxCompletedStatement: StatementSync;
  private readonly recoverInboxStatement: StatementSync;
  private readonly getOutboxStatement: StatementSync;
  private readonly getOutboxByDeliveryIdStatement: StatementSync;
  private readonly insertOutboxStatement: StatementSync;
  private readonly markOutboxSentStatement: StatementSync;
  private readonly markOutboxFailedStatement: StatementSync;
  private readonly recoverOutboxStatement: StatementSync;

  constructor(database: DatabaseSync) {
    this.database = database;
    this.getInboxStatement = database.prepare(
      `${INBOX_SELECT}\nWHERE id = ?`,
    );
    this.getInboxByKeyStatement = database.prepare(
      `${INBOX_SELECT}\nWHERE adapter_id = ? AND account_id = ? AND external_message_id = ?`,
    );
    this.insertInboxStatement = database.prepare(`
      INSERT INTO channel_inbox (
        adapter_id,
        channel,
        account_id,
        external_message_id,
        external_conversation_id,
        conversation_kind,
        sender_id,
        text,
        received_at,
        reply_to_message_id,
        session_id,
        user_id,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
    `);
    this.markInboxRunningStatement = database.prepare(`
      UPDATE channel_inbox
      SET status = 'running', started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'received'
    `);
    this.markInboxFailedStatement = database.prepare(`
      UPDATE channel_inbox
      SET
        status = ?,
        error_message = ?,
        completed_at = ?,
        updated_at = ?
      WHERE id = ? AND status IN ('received', 'running')
    `);
    this.markInboxCompletedStatement = database.prepare(`
      UPDATE channel_inbox
      SET
        status = 'completed',
        error_message = NULL,
        completed_at = ?,
        updated_at = ?
      WHERE id = ? AND status IN ('received', 'running')
    `);
    this.recoverInboxStatement = database.prepare(`
      UPDATE channel_inbox
      SET
        status = 'uncertain',
        error_message = ?,
        updated_at = ?
      WHERE status = 'running'
    `);
    this.getOutboxStatement = database.prepare(
      `${OUTBOX_SELECT}\nWHERE id = ?`,
    );
    this.getOutboxByDeliveryIdStatement = database.prepare(
      `${OUTBOX_SELECT}\nWHERE delivery_id = ?`,
    );
    this.insertOutboxStatement = database.prepare(`
      INSERT INTO channel_outbox (
        delivery_id,
        inbox_id,
        adapter_id,
        channel,
        account_id,
        session_id,
        user_id,
        external_conversation_id,
        reply_to_message_id,
        text,
        format,
        status,
        attempt_count,
        next_attempt_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `);
    this.markOutboxSentStatement = database.prepare(`
      UPDATE channel_outbox
      SET
        status = 'sent',
        platform_message_ids_json = ?,
        last_error = NULL,
        sent_at = ?,
        updated_at = ?
      WHERE id = ? AND status = 'sending'
    `);
    this.markOutboxFailedStatement = database.prepare(`
      UPDATE channel_outbox
      SET
        status = ?,
        last_error = ?,
        next_attempt_at = ?,
        updated_at = ?
      WHERE id = ? AND status = 'sending'
    `);
    this.recoverOutboxStatement = database.prepare(`
      UPDATE channel_outbox
      SET
        status = 'uncertain',
        next_attempt_at = ?,
        updated_at = ?
      WHERE status = 'sending'
    `);
  }

  async claimInbound(
    input: ChannelInboxInput,
    now = Date.now(),
  ): Promise<ChannelInboxClaim> {
    const normalized = normalizeInboxInput(input);
    const timestamp = normalizeTimestamp(now, "now");
    return this.withWriteTransaction(() => {
      const existing = this.getInboxByKey(normalized);
      if (existing) {
        assertSameInbound(existing, normalized);
        return { status: "duplicate", record: existing };
      }

      this.insertInboxStatement.run(
        normalized.adapter.adapterId,
        normalized.adapter.channel,
        normalized.adapter.accountId,
        normalized.message.externalMessageId,
        normalized.message.externalConversationId,
        normalized.message.conversationKind,
        normalized.message.senderId,
        normalized.message.text,
        normalized.message.receivedAt,
        normalized.message.replyToMessageId ?? null,
        normalized.sessionId,
        normalized.userId,
        timestamp,
        timestamp,
      );
      const inserted = this.getInboxByKey(normalized);
      if (!inserted) throw new Error("无法读取刚刚写入的 Channel Inbox。");
      return { status: "accepted", record: inserted };
    });
  }

  async getInbox(id: number): Promise<ChannelInboxRecord | null> {
    const normalizedId = requirePositiveId(id, "inboxId");
    const row = this.getInboxStatement.get(normalizedId) as
      | ChannelInboxRow
      | undefined;
    return row ? toInboxRecord(row) : null;
  }

  async listInbox(
    options: ChannelInboxListOptions = {},
  ): Promise<ChannelInboxRecord[]> {
    const limit = normalizeLimit(options.limit);
    const statuses = normalizeStatusFilter(options.status, INBOX_STATUSES);
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.sessionId !== undefined) {
      const sessionId = requiredIdentifier(options.sessionId, "sessionId", 512);
      where.push("session_id = ?");
      parameters.push(sessionId);
    }
    appendStatusFilter(where, parameters, statuses, "status");
    parameters.push(limit);
    const rows = this.database
      .prepare(
        `${INBOX_SELECT}
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY id ASC
        LIMIT ?`,
      )
      .all(...parameters) as unknown as ChannelInboxRow[];
    return rows.map(toInboxRecord);
  }

  async markInboundRunning(id: number, now = Date.now()): Promise<boolean> {
    const normalizedId = requirePositiveId(id, "inboxId");
    const timestamp = normalizeTimestamp(now, "now");
    return this.withWriteTransaction(() => {
      const result = this.markInboxRunningStatement.run(
        timestamp,
        timestamp,
        normalizedId,
      );
      return Number(result.changes) === 1;
    });
  }

  async markInboundFailed(
    id: number,
    error: string,
    options: ChannelInboxFailureOptions = {},
  ): Promise<boolean> {
    const normalizedId = requirePositiveId(id, "inboxId");
    const status = options.status ?? "failed";
    const timestamp = normalizeTimestamp(options.now ?? Date.now(), "now");
    const completedAt = status === "failed" ? timestamp : null;
    return this.withWriteTransaction(() => {
      const result = this.markInboxFailedStatement.run(
        status,
        normalizeError(error),
        completedAt,
        timestamp,
        normalizedId,
      );
      return Number(result.changes) === 1;
    });
  }

  async finalizeInbound(
    id: number,
    deliveries: readonly ChannelOutboxInput[],
    now = Date.now(),
  ): Promise<readonly ChannelOutboxRecord[]> {
    const normalizedId = requirePositiveId(id, "inboxId");
    const timestamp = normalizeTimestamp(now, "now");
    const normalizedDeliveries = deliveries.map((input) =>
      normalizeOutboxInput(input),
    );
    assertNoConflictingDeliveries(normalizedDeliveries);
    return this.withWriteTransaction(() => {
      const inbox = this.getInboxStatement.get(normalizedId) as
        | ChannelInboxRow
        | undefined;
      if (!inbox) throw new ChannelEventStateError(`Inbox ${id} 不存在。`);
      const record = toInboxRecord(inbox);
      if (record.status === "completed") {
        return this.listOutboxForInboxUnsafe(normalizedId);
      }
      if (record.status !== "received" && record.status !== "running") {
        throw new ChannelEventStateError(
          `Inbox ${id} 当前状态为 ${record.status}，不能完成。`,
        );
      }

      for (const input of normalizedDeliveries) {
        assertOutboxMatchesInbox(input, record);
        const existing = this.getOutboxByDeliveryIdUnsafe(
          input.delivery.deliveryId,
        );
        if (existing) assertSameOutbox(existing, input, normalizedId);
      }
      for (const input of normalizedDeliveries) {
        if (this.getOutboxByDeliveryIdUnsafe(input.delivery.deliveryId)) {
          continue;
        }
        this.insertOutboxUnsafe(input, normalizedId, timestamp);
      }

      const result = this.markInboxCompletedStatement.run(
        timestamp,
        timestamp,
        normalizedId,
      );
      if (Number(result.changes) !== 1) {
        throw new ChannelEventStateError(`Inbox ${id} 在完成前发生了状态变化。`);
      }
      return this.listOutboxForInboxUnsafe(normalizedId);
    });
  }

  async enqueueOutbox(
    input: ChannelOutboxInput,
    options: ChannelOutboxEnqueueOptions = {},
  ): Promise<ChannelOutboxRecord> {
    const normalized = normalizeOutboxInput(input);
    const timestamp = normalizeTimestamp(options.now ?? Date.now(), "now");
    const inboxId = normalizeOptionalId(options.inboxId, "inboxId");
    return this.withWriteTransaction(() => {
      if (inboxId !== null) {
        const inbox = this.getInboxStatement.get(inboxId) as
          | ChannelInboxRow
          | undefined;
        if (!inbox) throw new ChannelEventStateError(`Inbox ${inboxId} 不存在。`);
        assertOutboxMatchesInbox(normalized, toInboxRecord(inbox));
      }
      const existing = this.getOutboxByDeliveryIdUnsafe(
        normalized.delivery.deliveryId,
      );
      if (existing) {
        assertSameOutbox(existing, normalized, inboxId);
        return existing;
      }
      const id = this.insertOutboxUnsafe(normalized, inboxId, timestamp);
      const inserted = this.getOutboxStatement.get(id) as
        | ChannelOutboxRow
        | undefined;
      if (!inserted) throw new Error("无法读取刚刚写入的 Channel Outbox。");
      return toOutboxRecord(inserted);
    });
  }

  async getOutbox(id: number): Promise<ChannelOutboxRecord | null> {
    const normalizedId = requirePositiveId(id, "outboxId");
    const row = this.getOutboxStatement.get(normalizedId) as
      | ChannelOutboxRow
      | undefined;
    return row ? toOutboxRecord(row) : null;
  }

  async listOutbox(
    options: ChannelOutboxListOptions = {},
  ): Promise<ChannelOutboxRecord[]> {
    const limit = normalizeLimit(options.limit);
    const statuses = normalizeStatusFilter(options.status, OUTBOX_STATUSES);
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.inboxId !== undefined) {
      const inboxId = normalizeOptionalId(options.inboxId, "inboxId");
      if (inboxId === null) {
        where.push("inbox_id IS NULL");
      } else {
        where.push("inbox_id = ?");
        parameters.push(inboxId);
      }
    }
    appendStatusFilter(where, parameters, statuses, "status");
    parameters.push(limit);
    const rows = this.database
      .prepare(
        `${OUTBOX_SELECT}
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY id ASC
        LIMIT ?`,
      )
      .all(...parameters) as unknown as ChannelOutboxRow[];
    return rows.map(toOutboxRecord);
  }

  async listOutboxForInbox(inboxId: number): Promise<ChannelOutboxRecord[]> {
    return this.listOutbox({ inboxId: requirePositiveId(inboxId, "inboxId") });
  }

  async claimDueOutbox(
    options: ChannelOutboxClaimOptions = {},
  ): Promise<ChannelOutboxRecord[]> {
    const timestamp = normalizeTimestamp(options.now ?? Date.now(), "now");
    const limit = normalizeLimit(options.limit);
    return this.withWriteTransaction(() => {
      const rows = this.database
        .prepare(`
          SELECT id
          FROM channel_outbox
          WHERE status IN ('pending', 'failed', 'uncertain')
            AND next_attempt_at <= ?
          ORDER BY id ASC
          LIMIT ?
        `)
        .all(timestamp, limit) as unknown as Array<{ id: number }>;
      const claimed: ChannelOutboxRecord[] = [];
      for (const row of rows) {
        const result = this.database
          .prepare(`
            UPDATE channel_outbox
            SET status = 'sending',
                attempt_count = attempt_count + 1,
                updated_at = ?
            WHERE id = ?
              AND status IN ('pending', 'failed', 'uncertain')
          `)
          .run(timestamp, Number(row.id));
        if (Number(result.changes) !== 1) continue;
        const claimedRow = this.getOutboxStatement.get(Number(row.id)) as
          | ChannelOutboxRow
          | undefined;
        if (claimedRow) claimed.push(toOutboxRecord(claimedRow));
      }
      return claimed;
    });
  }

  async markOutboxSent(
    id: number,
    receipt: ChannelDeliveryReceipt,
    now = Date.now(),
  ): Promise<boolean> {
    const normalizedId = requirePositiveId(id, "outboxId");
    const normalizedReceipt = normalizeReceipt(receipt);
    const timestamp = normalizeTimestamp(now, "now");
    return this.withWriteTransaction(() => {
      const result = this.markOutboxSentStatement.run(
        JSON.stringify(normalizedReceipt.platformMessageIds),
        normalizedReceipt.deliveredAt,
        timestamp,
        normalizedId,
      );
      return Number(result.changes) === 1;
    });
  }

  async markOutboxFailed(
    id: number,
    error: string,
    options: ChannelOutboxFailureOptions,
    now = Date.now(),
  ): Promise<boolean> {
    const normalizedId = requirePositiveId(id, "outboxId");
    const timestamp = normalizeTimestamp(now, "now");
    const nextAttemptAt = normalizeTimestamp(
      options.nextAttemptAt,
      "nextAttemptAt",
    );
    return this.withWriteTransaction(() => {
      const result = this.markOutboxFailedStatement.run(
        options.terminal ? "dead" : "failed",
        normalizeError(error),
        nextAttemptAt,
        timestamp,
        normalizedId,
      );
      return Number(result.changes) === 1;
    });
  }

  async recoverInFlight(now = Date.now()): Promise<ChannelEventRecoveryResult> {
    const timestamp = normalizeTimestamp(now, "now");
    return this.withWriteTransaction(() => {
      const inboxResult = this.recoverInboxStatement.run(
        "进程重启时该入站 turn 仍在执行，已标记为 uncertain。",
        timestamp,
      );
      const outboxResult = this.recoverOutboxStatement.run(
        timestamp,
        timestamp,
      );
      return {
        inboxesMarkedUncertain: Number(inboxResult.changes),
        outboxesMarkedUncertain: Number(outboxResult.changes),
      };
    });
  }

  private getInboxByKey(
    input: NormalizedChannelInboxInput,
  ): ChannelInboxRecord | null {
    const row = this.getInboxByKeyStatement.get(
      input.adapter.adapterId,
      input.adapter.accountId,
      input.message.externalMessageId,
    ) as ChannelInboxRow | undefined;
    return row ? toInboxRecord(row) : null;
  }

  private getOutboxByDeliveryIdUnsafe(
    deliveryId: string,
  ): ChannelOutboxRecord | null {
    const row = this.getOutboxByDeliveryIdStatement.get(deliveryId) as
      | ChannelOutboxRow
      | undefined;
    return row ? toOutboxRecord(row) : null;
  }

  private listOutboxForInboxUnsafe(inboxId: number): ChannelOutboxRecord[] {
    const rows = this.database
      .prepare(`${OUTBOX_SELECT}\nWHERE inbox_id = ?\nORDER BY id ASC`)
      .all(inboxId) as unknown as ChannelOutboxRow[];
    return rows.map(toOutboxRecord);
  }

  private insertOutboxUnsafe(
    input: NormalizedChannelOutboxInput,
    inboxId: number | null,
    timestamp: number,
  ): number {
    const result = this.insertOutboxStatement.run(
      input.delivery.deliveryId,
      inboxId,
      input.adapter.adapterId,
      input.adapter.channel,
      input.adapter.accountId,
      input.sessionId,
      input.userId,
      input.delivery.externalConversationId,
      input.delivery.replyToMessageId ?? null,
      input.delivery.text,
      input.delivery.format,
      timestamp,
      timestamp,
      timestamp,
    );
    return Number(result.lastInsertRowid);
  }

  private withWriteTransaction<T>(operation: () => T): T {
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.database.exec("BEGIN IMMEDIATE");
        try {
          const result = operation();
          this.database.exec("COMMIT");
          return result;
        } catch (error) {
          if (this.database.isTransaction) this.database.exec("ROLLBACK");
          throw error;
        }
      } catch (error) {
        const delay = WRITE_RETRY_DELAYS_MS[attempt];
        if (!isBusyError(error) || delay === undefined) throw error;
        sleepSync(delay);
      }
    }
  }
}

type NormalizedChannelInboxInput = {
  adapter: ChannelAdapterIdentity;
  message: ChannelInboundText;
  sessionId: string;
  userId: string;
};

type NormalizedChannelOutboxInput = {
  adapter: ChannelAdapterIdentity;
  sessionId: string;
  userId: string;
  delivery: ChannelOutboundText;
};

type ChannelInboxRow = {
  id: number;
  adapter_id: string;
  channel: string;
  account_id: string;
  external_message_id: string;
  external_conversation_id: string;
  conversation_kind: ChannelConversationKind;
  sender_id: string;
  text: string;
  received_at: number;
  reply_to_message_id: string | null;
  session_id: string;
  user_id: string;
  status: ChannelInboxStatus;
  error_message: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
};

type ChannelOutboxRow = {
  id: number;
  inbox_id: number | null;
  delivery_id: string;
  adapter_id: string;
  channel: string;
  account_id: string;
  session_id: string;
  user_id: string;
  external_conversation_id: string;
  reply_to_message_id: string | null;
  text: string;
  format: ChannelMessageFormat;
  status: ChannelOutboxStatus;
  attempt_count: number;
  next_attempt_at: number;
  last_error: string | null;
  platform_message_ids_json: string | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
};

const INBOX_SELECT = `
  SELECT
    id,
    adapter_id,
    channel,
    account_id,
    external_message_id,
    external_conversation_id,
    conversation_kind,
    sender_id,
    text,
    received_at,
    reply_to_message_id,
    session_id,
    user_id,
    status,
    error_message,
    started_at,
    completed_at,
    created_at,
    updated_at
  FROM channel_inbox`;

const OUTBOX_SELECT = `
  SELECT
    id,
    inbox_id,
    delivery_id,
    adapter_id,
    channel,
    account_id,
    session_id,
    user_id,
    external_conversation_id,
    reply_to_message_id,
    text,
    format,
    status,
    attempt_count,
    next_attempt_at,
    last_error,
    platform_message_ids_json,
    created_at,
    updated_at,
    sent_at
  FROM channel_outbox`;

function normalizeInboxInput(input: ChannelInboxInput): NormalizedChannelInboxInput {
  if (!input || typeof input !== "object") {
    throw new TypeError("ChannelInboxInput 格式无效。");
  }
  return {
    adapter: normalizeAdapterIdentity(input.adapter),
    message: normalizeInboundMessage(input.message),
    sessionId: requiredIdentifier(input.sessionId, "sessionId", 512),
    userId: requiredIdentifier(input.userId, "userId", 512),
  };
}

function normalizeOutboxInput(input: ChannelOutboxInput): NormalizedChannelOutboxInput {
  if (!input || typeof input !== "object") {
    throw new TypeError("ChannelOutboxInput 格式无效。");
  }
  return {
    adapter: normalizeAdapterIdentity(input.adapter),
    sessionId: requiredIdentifier(input.sessionId, "sessionId", 512),
    userId: requiredIdentifier(input.userId, "userId", 512),
    delivery: normalizeOutboundMessage(input.delivery),
  };
}

function normalizeAdapterIdentity(
  value: ChannelAdapterIdentity,
): ChannelAdapterIdentity {
  if (!value || typeof value !== "object") {
    throw new TypeError("ChannelAdapterIdentity 格式无效。");
  }
  return Object.freeze({
    adapterId: requiredIdentifier(value.adapterId, "adapterId", 128),
    channel: requiredIdentifier(value.channel, "channel", 128),
    accountId: requiredIdentifier(value.accountId, "accountId", 128),
  });
}

function normalizeInboundMessage(value: ChannelInboundText): ChannelInboundText {
  if (!value || typeof value !== "object") {
    throw new TypeError("ChannelInboundText 格式无效。");
  }
  if (!isChannelConversationKind(value.conversationKind)) {
    throw new TypeError("conversationKind 无效。");
  }
  return Object.freeze({
    externalMessageId: requiredIdentifier(
      value.externalMessageId,
      "externalMessageId",
      512,
    ),
    externalConversationId: requiredIdentifier(
      value.externalConversationId,
      "externalConversationId",
      512,
    ),
    conversationKind: value.conversationKind,
    senderId: requiredIdentifier(value.senderId, "senderId", 256),
    text: requiredMessageText(value.text, "text"),
    receivedAt: normalizeTimestamp(value.receivedAt, "receivedAt"),
    ...(value.replyToMessageId === undefined
      ? {}
      : {
          replyToMessageId: requiredIdentifier(
            value.replyToMessageId,
            "replyToMessageId",
            512,
          ),
        }),
  });
}

function normalizeOutboundMessage(
  value: ChannelOutboundText,
): ChannelOutboundText {
  if (!value || typeof value !== "object") {
    throw new TypeError("ChannelOutboundText 格式无效。");
  }
  if (!isChannelMessageFormat(value.format)) {
    throw new TypeError("format 无效。");
  }
  return Object.freeze({
    deliveryId: requiredIdentifier(value.deliveryId, "deliveryId", 256),
    externalConversationId: requiredIdentifier(
      value.externalConversationId,
      "externalConversationId",
      512,
    ),
    ...(value.replyToMessageId === undefined
      ? {}
      : {
          replyToMessageId: requiredIdentifier(
            value.replyToMessageId,
            "replyToMessageId",
            512,
          ),
        }),
    text: requiredMessageText(value.text, "text"),
    format: value.format,
  });
}

function normalizeReceipt(receipt: ChannelDeliveryReceipt): ChannelDeliveryReceipt {
  if (!receipt || typeof receipt !== "object") {
    throw new TypeError("ChannelDeliveryReceipt 格式无效。");
  }
  if (
    !Array.isArray(receipt.platformMessageIds) ||
    receipt.platformMessageIds.length === 0 ||
    receipt.platformMessageIds.length > MAX_PLATFORM_MESSAGE_IDS
  ) {
    throw new TypeError("platformMessageIds 数量无效。");
  }
  const platformMessageIds = receipt.platformMessageIds.map((id) =>
    requiredIdentifier(id, "platformMessageId", 256),
  );
  return Object.freeze({
    platformMessageIds: Object.freeze(platformMessageIds),
    deliveredAt: normalizeTimestamp(receipt.deliveredAt, "deliveredAt"),
  });
}

function assertSameInbound(
  existing: ChannelInboxRecord,
  input: NormalizedChannelInboxInput,
): void {
  if (
    !sameAdapter(existing.adapter, input.adapter) ||
    existing.sessionId !== input.sessionId ||
    existing.userId !== input.userId ||
    !sameInboundMessage(existing.message, input.message)
  ) {
    throw new ChannelEventConflictError(
      `Inbox 外部消息 ${input.message.externalMessageId} 与已有事件内容不一致。`,
    );
  }
}

function assertOutboxMatchesInbox(
  input: NormalizedChannelOutboxInput,
  inbox: ChannelInboxRecord,
): void {
  if (
    !sameAdapter(input.adapter, inbox.adapter) ||
    input.sessionId !== inbox.sessionId ||
    input.userId !== inbox.userId ||
    input.delivery.externalConversationId !== inbox.message.externalConversationId
  ) {
    throw new ChannelEventConflictError(
      `Outbox delivery ${input.delivery.deliveryId} 与 Inbox ${inbox.id} 的渠道绑定不一致。`,
    );
  }
}

function assertSameOutbox(
  existing: ChannelOutboxRecord,
  input: NormalizedChannelOutboxInput,
  inboxId: number | null,
): void {
  if (
    existing.inboxId !== inboxId ||
    existing.sessionId !== input.sessionId ||
    existing.userId !== input.userId ||
    !sameAdapter(existing.adapter, input.adapter) ||
    !sameOutboundMessage(existing.delivery, input.delivery)
  ) {
    throw new ChannelEventConflictError(
      `Outbox delivery ${input.delivery.deliveryId} 与已有记录不一致。`,
    );
  }
}

function inboundKey(
  adapter: ChannelAdapterIdentity,
  externalMessageId: string,
): string {
  return JSON.stringify([
    adapter.adapterId,
    adapter.accountId,
    externalMessageId,
  ]);
}

function sameAdapter(
  left: ChannelAdapterIdentity,
  right: ChannelAdapterIdentity,
): boolean {
  return (
    left.adapterId === right.adapterId &&
    left.channel === right.channel &&
    left.accountId === right.accountId
  );
}

function sameInboundMessage(
  left: ChannelInboundText,
  right: ChannelInboundText,
): boolean {
  return (
    left.externalMessageId === right.externalMessageId &&
    left.externalConversationId === right.externalConversationId &&
    left.conversationKind === right.conversationKind &&
    left.senderId === right.senderId &&
    left.text === right.text &&
    // Adapters may recalculate this observation timestamp while replaying an
    // immutable event; it is metadata, not replay identity.
    (left.replyToMessageId ?? null) === (right.replyToMessageId ?? null)
  );
}

function assertNoConflictingDeliveries(
  deliveries: readonly NormalizedChannelOutboxInput[],
): void {
  const seen = new Map<string, NormalizedChannelOutboxInput>();
  for (const input of deliveries) {
    const existing = seen.get(input.delivery.deliveryId);
    if (!existing) {
      seen.set(input.delivery.deliveryId, input);
      continue;
    }
    if (!sameNormalizedOutbox(existing, input)) {
      throw new ChannelEventConflictError(
        `Outbox delivery ${input.delivery.deliveryId} 在同一批次中内容不一致。`,
      );
    }
  }
}

function sameNormalizedOutbox(
  left: NormalizedChannelOutboxInput,
  right: NormalizedChannelOutboxInput,
): boolean {
  return (
    sameAdapter(left.adapter, right.adapter) &&
    left.sessionId === right.sessionId &&
    left.userId === right.userId &&
    sameOutboundMessage(left.delivery, right.delivery)
  );
}

function sameOutboundMessage(
  left: ChannelOutboundText,
  right: ChannelOutboundText,
): boolean {
  return (
    left.deliveryId === right.deliveryId &&
    left.externalConversationId === right.externalConversationId &&
    left.text === right.text &&
    left.format === right.format &&
    (left.replyToMessageId ?? null) === (right.replyToMessageId ?? null)
  );
}

function toInboxRecord(row: ChannelInboxRow): ChannelInboxRecord {
  if (!isChannelConversationKind(row.conversation_kind)) {
    throw new Error(`Inbox ${row.id} 的 conversation_kind 无效。`);
  }
  if (!INBOX_STATUSES.includes(row.status)) {
    throw new Error(`Inbox ${row.id} 的 status 无效。`);
  }
  return cloneInbox({
    id: Number(row.id),
    sequence: Number(row.id),
    adapter: Object.freeze({
      adapterId: row.adapter_id,
      channel: row.channel,
      accountId: row.account_id,
    }),
    message: Object.freeze({
      externalMessageId: row.external_message_id,
      externalConversationId: row.external_conversation_id,
      conversationKind: row.conversation_kind,
      senderId: row.sender_id,
      text: row.text,
      receivedAt: Number(row.received_at),
      ...(row.reply_to_message_id === null
        ? {}
        : { replyToMessageId: row.reply_to_message_id }),
    }),
    sessionId: row.session_id,
    userId: row.user_id,
    status: row.status,
    errorMessage: row.error_message,
    startedAt: nullableNumber(row.started_at),
    completedAt: nullableNumber(row.completed_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}

function toOutboxRecord(row: ChannelOutboxRow): ChannelOutboxRecord {
  if (!isChannelMessageFormat(row.format)) {
    throw new Error(`Outbox ${row.id} 的 format 无效。`);
  }
  if (!OUTBOX_STATUSES.includes(row.status)) {
    throw new Error(`Outbox ${row.id} 的 status 无效。`);
  }
  const platformMessageIds = parsePlatformMessageIds(
    row.platform_message_ids_json,
  );
  return cloneOutbox({
    id: Number(row.id),
    inboxId: nullableNumber(row.inbox_id),
    adapter: Object.freeze({
      adapterId: row.adapter_id,
      channel: row.channel,
      accountId: row.account_id,
    }),
    sessionId: row.session_id,
    userId: row.user_id,
    delivery: Object.freeze({
      deliveryId: row.delivery_id,
      externalConversationId: row.external_conversation_id,
      ...(row.reply_to_message_id === null
        ? {}
        : { replyToMessageId: row.reply_to_message_id }),
      text: row.text,
      format: row.format,
    }),
    status: row.status,
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: Number(row.next_attempt_at),
    lastError: row.last_error,
    platformMessageIds,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    sentAt: nullableNumber(row.sent_at),
  });
}

function cloneInbox(record: ChannelInboxRecord): ChannelInboxRecord {
  return Object.freeze({
    ...record,
    adapter: Object.freeze({ ...record.adapter }),
    message: Object.freeze({ ...record.message }),
  });
}

function cloneOutbox(record: ChannelOutboxRecord): ChannelOutboxRecord {
  return Object.freeze({
    ...record,
    adapter: Object.freeze({ ...record.adapter }),
    delivery: Object.freeze({ ...record.delivery }),
    platformMessageIds: Object.freeze([...record.platformMessageIds]),
  });
}

function replaceInbox(
  record: ChannelInboxRecord,
  patch: Partial<ChannelInboxRecord>,
): void {
  Object.assign(record as unknown as Record<string, unknown>, patch);
}

function replaceOutbox(
  record: ChannelOutboxRecord,
  patch: Partial<ChannelOutboxRecord>,
): void {
  Object.assign(record as unknown as Record<string, unknown>, patch);
}

function requiredIdentifier(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new TypeError(`${name} 必须是非空且安全的字符串。`);
  }
  return value;
}

function requiredMessageText(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CHANNEL_TEXT_LENGTH ||
    value.includes("\u0000")
  ) {
    throw new TypeError(`${name} 必须是非空且不超过 1 MiB 的文本。`);
  }
  return value;
}

function normalizeTimestamp(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(`${name} 必须是非负安全整数。`);
  }
  return value;
}

function normalizeError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  const trimmed = message.trim() || "未知错误";
  return trimmed.slice(0, MAX_ERROR_LENGTH);
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_EVENT_LIST_LIMIT;
  }
  return Math.min(MAX_EVENT_LIST_LIMIT, Math.max(1, Math.ceil(value)));
}

function normalizeOptionalId(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  return requirePositiveId(value, name);
}

function requirePositiveId(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new TypeError(`${name} 必须是正整数。`);
  }
  return value;
}

function normalizeStatusFilter<T extends string>(
  value: T | readonly T[] | undefined,
  allowed: readonly T[],
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.some((item) => !allowed.includes(item))) {
    throw new TypeError("状态筛选条件无效。");
  }
  return [...new Set(values)];
}

function appendStatusFilter(
  where: string[],
  parameters: Array<string | number>,
  statuses: readonly string[] | undefined,
  column: string,
): void {
  if (!statuses) return;
  where.push(`${column} IN (${statuses.map(() => "?").join(", ")})`);
  parameters.push(...statuses);
}

function parsePlatformMessageIds(value: string | null): readonly string[] {
  if (value === null) return Object.freeze([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Outbox platform_message_ids_json 不是合法 JSON。");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Outbox platform_message_ids_json 必须是数组。");
  }
  return Object.freeze(
    parsed.map((item) => requiredIdentifier(item, "platformMessageId", 256)),
  );
}

function nullableNumber(value: number | null): number | null {
  return value === null ? null : Number(value);
}

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("database is locked") || message.includes("database is busy");
}

/** DatabaseSync is synchronous, so retry sleeps are deliberately bounded. */
function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

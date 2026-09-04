import type { ChannelAdapter } from "./channel-adapter.js";
import type {
  ChannelEventStore,
  ChannelOutboxRecord,
} from "./channel-event-store.js";
import type { ChannelAdapterIdentity } from "./channel-types.js";

export interface ChannelDeliveryWorkerOptions {
  readonly eventStore: ChannelEventStore;
  readonly adapters: ReadonlyMap<string, ChannelAdapter>;
  /** How often to look for deliveries when no explicit wake-up is received. */
  readonly pollIntervalMs?: number;
  /** Maximum number of Outbox records claimed in one cycle. */
  readonly batchSize?: number;
  /** Attempts include the current claim; the final failed attempt becomes dead. */
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly now?: () => number;
  readonly onError?: (
    error: unknown,
    record?: ChannelOutboxRecord,
  ) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 5 * 60 * 1_000;

/**
 * Delivers only durable Outbox records. It never calls AgentManager or
 * ChatService, so a platform failure cannot cause an already completed Agent
 * turn to execute again.
 */
export class ChannelDeliveryWorker {
  private readonly eventStore: ChannelEventStore;
  private readonly adapters: ReadonlyMap<string, ChannelAdapter>;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly now: () => number;
  private readonly onError?: (
    error: unknown,
    record?: ChannelOutboxRecord,
  ) => void;
  private readonly wakeWaiters = new Set<() => void>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly idleWaiters = new Set<() => void>();
  private running = false;
  private cycleRunning = false;
  private activeDeliveries = 0;
  private loopPromise: Promise<void> | undefined;
  private cyclePromise: Promise<number> | undefined;

  constructor(options: ChannelDeliveryWorkerOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("ChannelDeliveryWorker 配置无效。");
    }
    this.eventStore = options.eventStore;
    this.adapters = options.adapters;
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    this.batchSize = positiveInteger(
      options.batchSize ?? DEFAULT_BATCH_SIZE,
      "batchSize",
    );
    this.maxAttempts = positiveInteger(
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      "maxAttempts",
    );
    this.retryBaseMs = positiveInteger(
      options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
      "retryBaseMs",
    );
    this.retryMaxMs = positiveInteger(
      options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
      "retryMaxMs",
    );
    if (this.retryMaxMs < this.retryBaseMs) {
      throw new RangeError("retryMaxMs 不能小于 retryBaseMs。");
    }
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Start the background polling loop; repeated calls are harmless. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
    this.kick();
  }

  /** Wake a running worker after a new Outbox record is enqueued. */
  kick(): void {
    for (const resolve of this.wakeWaiters) resolve();
    this.wakeWaiters.clear();
  }

  /**
   * Run one deterministic delivery cycle. This is also useful to an embedding
   * runtime's tests or an administrative drain command; it does not require
   * the background loop to be started.
   */
  async runOnce(): Promise<number> {
    if (this.cyclePromise) return this.cyclePromise;

    const cycle = this.runCycle();
    this.cyclePromise = cycle;
    try {
      return await cycle;
    } finally {
      if (this.cyclePromise === cycle) this.cyclePromise = undefined;
      this.notifyIdle();
    }
  }

  /** Wait until the current claim/delivery cycle has no active deliveries. */
  async waitForIdle(): Promise<void> {
    if (!this.cycleRunning && this.activeDeliveries === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  /** Stop polling and abort only in-flight platform calls. */
  async stop(): Promise<void> {
    this.running = false;
    this.kick();
    for (const controller of this.activeControllers) controller.abort();

    const loop = this.loopPromise;
    if (loop) await loop.catch((error) => this.reportError(error));
    const cycle = this.cyclePromise;
    if (cycle) await cycle.catch((error) => this.reportError(error));
    this.loopPromise = undefined;
    this.notifyIdle();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        // A temporary database error must not permanently kill delivery. The
        // next poll retries the claim, while the record itself remains durable.
        this.reportError(error);
      }
      if (!this.running) break;
      await this.waitForWake(this.pollIntervalMs);
    }
  }

  private async runCycle(): Promise<number> {
    this.cycleRunning = true;
    try {
      const records = await this.eventStore.claimDueOutbox({
        now: this.now(),
        limit: this.batchSize,
      });
      await Promise.all(records.map((record) => this.deliver(record)));
      return records.length;
    } finally {
      this.cycleRunning = false;
      this.notifyIdle();
    }
  }

  private async deliver(record: ChannelOutboxRecord): Promise<void> {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    this.activeDeliveries += 1;

    try {
      const adapter = this.adapters.get(record.adapter.adapterId);
      if (!adapter || !sameIdentity(adapter.identity, record.adapter)) {
        throw new Error(
          `没有与 Outbox ${record.id} 匹配的 ChannelAdapter：${record.adapter.adapterId}。`,
        );
      }

      const receipt = await adapter.deliver(record.delivery, controller.signal);
      await this.eventStore.markOutboxSent(
        record.id,
        receipt,
        this.now(),
      );
    } catch (error) {
      const aborted = controller.signal.aborted;
      const terminal = !aborted && record.attemptCount >= this.maxAttempts;
      const now = this.now();
      const nextAttemptAt = aborted
        ? now
        : now + this.retryDelay(record.attemptCount);
      try {
        await this.eventStore.markOutboxFailed(record.id, errorMessage(error), {
          nextAttemptAt,
          terminal,
        }, now);
      } catch (markError) {
        this.reportError(markError, record);
      }
      this.reportError(error, record);
    } finally {
      this.activeControllers.delete(controller);
      this.activeDeliveries -= 1;
      this.notifyIdle();
    }
  }

  private retryDelay(attemptCount: number): number {
    const exponent = Math.max(0, Math.min(attemptCount - 1, 30));
    return Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** exponent);
  }

  private async waitForWake(milliseconds: number): Promise<void> {
    if (!this.running) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.wakeWaiters.delete(wake);
        resolve();
      }, milliseconds);
      const wake = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.wakeWaiters.delete(wake);
        resolve();
      };
      this.wakeWaiters.add(wake);
    });
  }

  private notifyIdle(): void {
    if (this.cycleRunning || this.activeDeliveries > 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private reportError(error: unknown, record?: ChannelOutboxRecord): void {
    this.onError?.(error, record);
  }
}

function sameIdentity(
  left: ChannelAdapterIdentity,
  right: ChannelAdapterIdentity,
): boolean {
  return (
    left.adapterId === right.adapterId &&
    left.channel === right.channel &&
    left.accountId === right.accountId
  );
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${name} 必须是正整数。`);
  }
  return value as number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

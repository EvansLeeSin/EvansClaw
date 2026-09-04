import type {
  AgentSessionDescriptor,
  AgentSessionHandle,
} from "../agent/agent-manager.js";
import type {
  ChannelAdapter,
  ChannelRegistration,
  ChannelSink,
  InboundAcceptance,
} from "./channel-adapter.js";
import {
  ChannelEventConflictError,
  type ChannelEventStore,
  type ChannelInboxRecord,
  type ChannelInboxInput,
  type ChannelOutboxInput,
} from "./channel-event-store.js";
import type { AuthorizedChannelPrincipal } from "./channel-access-policy.js";
import { createChannelSessionRoute } from "./channel-session-key.js";
import type { ChannelInboundText } from "./channel-types.js";
import { ChannelDeliveryWorker } from "./channel-delivery-worker.js";

export interface ChannelSessionManager {
  getOrCreate(
    descriptor: AgentSessionDescriptor,
  ): Promise<AgentSessionHandle>;
}

export interface ChannelGatewayErrorContext {
  readonly phase: "inbound" | "delivery" | "adapter";
  readonly inboxId?: number;
  readonly outboxId?: number;
  readonly adapterId?: string;
}

export interface ChannelGatewayOptions {
  readonly manager: ChannelSessionManager;
  readonly eventStore: ChannelEventStore;
  readonly registrations: readonly ChannelRegistration[];
  readonly delivery?: {
    readonly pollIntervalMs?: number;
    readonly batchSize?: number;
    readonly maxAttempts?: number;
    readonly retryBaseMs?: number;
    readonly retryMaxMs?: number;
  };
  readonly now?: () => number;
  readonly onError?: (
    error: unknown,
    context: ChannelGatewayErrorContext,
  ) => void;
}

type GatewayState = "idle" | "starting" | "started" | "stopping" | "closed";

type InboundWork = {
  readonly record: ChannelInboxRecord;
  readonly registration: ChannelRegistration;
  readonly principal: AuthorizedChannelPrincipal;
};

/**
 * Orchestrates one push-channel boundary without becoming another Agent queue.
 * Inbox records are ordered per derived session here; AgentManager remains the
 * final lifecycle and serialization owner for the actual session turn.
 */
export class ChannelGateway {
  private readonly manager: ChannelSessionManager;
  private readonly eventStore: ChannelEventStore;
  private readonly registrations: readonly ChannelRegistration[];
  private readonly registrationByAdapterId = new Map<
    string,
    ChannelRegistration
  >();
  private readonly deliveryWorker: ChannelDeliveryWorker;
  private readonly now: () => number;
  private readonly onError?: (
    error: unknown,
    context: ChannelGatewayErrorContext,
  ) => void;
  private readonly sessionTails = new Map<string, Promise<void>>();
  private readonly activeAccepts = new Set<Promise<InboundAcceptance>>();
  private state: GatewayState = "idle";
  private accepting = false;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(options: ChannelGatewayOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("ChannelGateway 配置无效。");
    }
    this.manager = options.manager;
    this.eventStore = options.eventStore;
    this.now = options.now ?? Date.now;
    this.onError = options.onError;

    const registrations: ChannelRegistration[] = [];
    for (const registration of options.registrations) {
      assertRegistration(registration);
      const adapterId = registration.adapter.identity.adapterId;
      if (this.registrationByAdapterId.has(adapterId)) {
        throw new Error(`重复注册 ChannelAdapter：${adapterId}。`);
      }
      registrations.push(registration);
      this.registrationByAdapterId.set(adapterId, registration);
    }
    this.registrations = Object.freeze(registrations);

    const adapters = new Map<string, ChannelAdapter>();
    for (const registration of this.registrations) {
      adapters.set(
        registration.adapter.identity.adapterId,
        registration.adapter,
      );
    }
    this.deliveryWorker = new ChannelDeliveryWorker({
      eventStore: this.eventStore,
      adapters,
      now: this.now,
      onError: (error, record) => {
        this.onError?.(error, {
          phase: "delivery",
          outboxId: record?.id,
          adapterId: record?.adapter.adapterId,
        });
      },
      ...options.delivery,
    });
  }

  get status(): GatewayState {
    return this.state;
  }

  /**
   * Authenticate/start adapters before delivery so a recovered Outbox record
   * can never call an adapter before its transport is ready. Previously
   * claimed `received` Inbox rows are resumed before new events are accepted.
   */
  async start(): Promise<void> {
    if (this.state === "started") return;
    if (this.state === "starting" && this.startPromise) {
      return this.startPromise;
    }
    if (this.state === "stopping" || this.state === "closed") {
      throw new ChannelGatewayClosedError();
    }

    this.state = "starting";
    this.accepting = true;
    const start = this.startInternal();
    this.startPromise = start;
    try {
      await start;
      if (!this.accepting) throw new ChannelGatewayClosedError();
      this.state = "started";
    } catch (error) {
      if (this.state === "starting") {
        this.accepting = false;
        await this.stopAdapters();
        await this.deliveryWorker.stop();
        await this.waitForAcceptsAndInbound();
        this.state = "idle";
      }
      throw error;
    } finally {
      if (this.startPromise === start) this.startPromise = undefined;
    }
  }

  /**
   * Stop receiving first, then stop delivery calls and drain already claimed
   * Inbox work. The AgentManager and shared SQLite resources belong to the host
   * runtime and are intentionally not closed here.
   */
  async stop(): Promise<void> {
    if (this.state === "closed") return;
    if (this.stopPromise) return this.stopPromise;

    this.accepting = false;
    this.state = "stopping";
    const stop = this.stopInternal();
    this.stopPromise = stop;
    try {
      await stop;
    } finally {
      if (this.stopPromise === stop) this.stopPromise = undefined;
    }
  }

  /** Run one Outbox claim/delivery pass, useful for embedding tests or drains. */
  runDeliveryCycle(): Promise<number> {
    return this.deliveryWorker.runOnce();
  }

  /** Wait for in-flight accepts, ordered Agent turns, and due deliveries. */
  async waitForIdle(): Promise<void> {
    await this.waitForAcceptsAndInbound();
    if (this.state === "closed" || this.state === "stopping") {
      await this.deliveryWorker.waitForIdle();
      return;
    }
    // The worker is normally woken by finalizeInbound(), but an embedding
    // caller may reach this method in the small interval before its loop runs.
    // One explicit cycle makes the testing/administrative drain deterministic
    // without changing the background worker's at-least-once behavior.
    for (;;) {
      await this.deliveryWorker.waitForIdle();
      const delivered = await this.deliveryWorker.runOnce();
      if (delivered === 0) break;
    }
  }

  private async startInternal(): Promise<void> {
    const received = await this.eventStore.listInbox({
      status: "received",
      limit: 500,
    });
    for (const record of received) {
      if (!this.accepting) throw new ChannelGatewayClosedError();
      await this.resumeReceived(record);
    }

    for (const registration of this.registrations) {
      if (!this.accepting) throw new ChannelGatewayClosedError();
      await registration.adapter.start(this.createSink(registration));
    }
    this.deliveryWorker.start();
    this.deliveryWorker.kick();
  }

  private createSink(registration: ChannelRegistration): ChannelSink {
    return {
      accept: (message) => this.acceptFrom(registration, message),
    };
  }

  private acceptFrom(
    registration: ChannelRegistration,
    message: ChannelInboundText,
  ): Promise<InboundAcceptance> {
    if (!this.accepting) {
      return Promise.resolve({ status: "rejected", reason: "unsupported" });
    }

    const task = this.acceptInternal(registration, message);
    this.activeAccepts.add(task);
    void task.finally(() => this.activeAccepts.delete(task)).catch((error) => {
      this.reportError(error, {
        phase: "inbound",
        adapterId: registration.adapter.identity.adapterId,
      });
    });
    return task;
  }

  private async acceptInternal(
    registration: ChannelRegistration,
    message: ChannelInboundText,
  ): Promise<InboundAcceptance> {
    const principal = await registration.accessPolicy.authorize(
      registration.adapter.identity,
      message,
    );
    if (!principal) {
      return { status: "rejected", reason: "unauthorized" };
    }

    let route;
    try {
      route = createChannelSessionRoute({
        adapter: registration.adapter.identity,
        conversationKind: message.conversationKind,
        externalConversationId: message.externalConversationId,
        canonicalUserId: principal.userId,
      });
    } catch (error) {
      this.reportError(error, {
        phase: "inbound",
        adapterId: registration.adapter.identity.adapterId,
      });
      return { status: "rejected", reason: "invalid" };
    }

    let claim;
    try {
      const input: ChannelInboxInput = {
        adapter: registration.adapter.identity,
        message,
        sessionId: route.sessionId,
        userId: route.userId,
      };
      claim = await this.eventStore.claimInbound(input, this.now());
    } catch (error) {
      if (error instanceof ChannelEventConflictError) {
        return { status: "rejected", reason: "invalid" };
      }
      throw error;
    }
    if (claim.status === "duplicate") return { status: "duplicate" };

    this.enqueueInbound({
      record: claim.record,
      registration,
      principal,
    });
    return { status: "accepted" };
  }

  private async resumeReceived(record: ChannelInboxRecord): Promise<void> {
    const registration = this.findRegistration(record.adapter);
    if (!registration) return;

    try {
      const principal = await registration.accessPolicy.authorize(
        record.adapter,
        record.message,
      );
      if (!principal) {
        await this.failInbound(
          record,
          new Error("恢复 Inbox 时访问策略不再允许该消息。"),
        );
        return;
      }

      const route = createChannelSessionRoute({
        adapter: record.adapter,
        conversationKind: record.message.conversationKind,
        externalConversationId: record.message.externalConversationId,
        canonicalUserId: principal.userId,
      });
      if (
        route.sessionId !== record.sessionId ||
        route.userId !== record.userId
      ) {
        await this.failInbound(
          record,
          new Error("恢复 Inbox 时 Session 路由绑定已发生变化。"),
        );
        return;
      }

      this.enqueueInbound({ record, registration, principal });
    } catch (error) {
      await this.failInbound(record, error);
    }
  }

  private enqueueInbound(work: InboundWork): void {
    const previous = this.sessionTails.get(work.record.sessionId);
    const task = (previous ?? Promise.resolve()).then(
      () => this.processInbound(work),
      () => this.processInbound(work),
    );
    const tail = task.then(
      () => undefined,
      () => undefined,
    );
    this.sessionTails.set(work.record.sessionId, tail);
    void tail.finally(() => {
      if (this.sessionTails.get(work.record.sessionId) === tail) {
        this.sessionTails.delete(work.record.sessionId);
      }
    }).catch((error) => {
      this.reportError(error, {
        phase: "inbound",
        inboxId: work.record.id,
        adapterId: work.record.adapter.adapterId,
      });
    });
  }

  private async processInbound(work: InboundWork): Promise<void> {
    const { record, registration, principal } = work;
    try {
      const started = await this.eventStore.markInboundRunning(
        record.id,
        this.now(),
      );
      if (!started) return;

      const route = createChannelSessionRoute({
        adapter: record.adapter,
        conversationKind: record.message.conversationKind,
        externalConversationId: record.message.externalConversationId,
        canonicalUserId: principal.userId,
      });
      if (
        route.sessionId !== record.sessionId ||
        route.userId !== record.userId
      ) {
        throw new Error("入站消息的 Session 路由绑定不一致。");
      }

      const descriptor: AgentSessionDescriptor = {
        sessionId: route.sessionId,
        channel: route.channel,
        conversationId: route.conversationId,
        userId: route.userId,
        identity: principal.identity,
        profile: registration.profile,
      };
      const session = await this.manager.getOrCreate(descriptor);
      let responseText = "";
      await session.run((chat) =>
        chat.send(record.message.text, (delta) => {
          responseText += delta;
        }),
      );

      const deliveries: ChannelOutboxInput[] = [];
      if (responseText.trim().length > 0) {
        deliveries.push({
          adapter: registration.adapter.identity,
          sessionId: route.sessionId,
          userId: route.userId,
          delivery: {
            // Inbox IDs are database-local and monotonic, so this ID is stable
            // across a retry of finalization without rerunning the Agent.
            deliveryId: `channel-inbox:${record.id}:reply`,
            externalConversationId: record.message.externalConversationId,
            replyToMessageId: registration.adapter.capabilities.supportsReply
              ? record.message.replyToMessageId
              : undefined,
            text: responseText,
            format: "plain",
          },
        });
      }
      const outboxes = await this.eventStore.finalizeInbound(
        record.id,
        deliveries,
        this.now(),
      );
      if (outboxes.length > 0) this.deliveryWorker.kick();
    } catch (error) {
      await this.failInbound(record, error);
    }
  }

  private async failInbound(
    record: ChannelInboxRecord,
    error: unknown,
  ): Promise<void> {
    try {
      await this.eventStore.markInboundFailed(
        record.id,
        errorMessage(error),
        { now: this.now() },
      );
    } catch (markError) {
      this.reportError(markError, {
        phase: "inbound",
        inboxId: record.id,
        adapterId: record.adapter.adapterId,
      });
    }
    this.reportError(error, {
      phase: "inbound",
      inboxId: record.id,
      adapterId: record.adapter.adapterId,
    });
  }

  private findRegistration(
    identity: ChannelInboundRecordIdentity,
  ): ChannelRegistration | undefined {
    const registration = this.registrationByAdapterId.get(identity.adapterId);
    if (!registration) return undefined;
    return sameIdentity(registration.adapter.identity, identity)
      ? registration
      : undefined;
  }

  private async stopInternal(): Promise<void> {
    await this.stopAdapters();
    await this.deliveryWorker.stop();
    const starting = this.startPromise;
    if (starting) {
      await starting.catch((error) =>
        this.reportError(error, { phase: "adapter" }),
      );
    }
    await this.waitForAcceptsAndInbound();
    this.state = "closed";
  }

  private async stopAdapters(): Promise<void> {
    await Promise.all(
      this.registrations.map(async (registration) => {
        try {
          await registration.adapter.stop();
        } catch (error) {
          this.reportError(error, {
            phase: "adapter",
            adapterId: registration.adapter.identity.adapterId,
          });
        }
      }),
    );
  }

  private async waitForAcceptsAndInbound(): Promise<void> {
    for (;;) {
      const accepts = [...this.activeAccepts];
      if (accepts.length > 0) await Promise.allSettled(accepts);
      const tails = [...this.sessionTails.values()];
      if (tails.length > 0) await Promise.all(tails);
      if (this.activeAccepts.size === 0 && this.sessionTails.size === 0) return;
    }
  }

  private reportError(
    error: unknown,
    context: ChannelGatewayErrorContext,
  ): void {
    this.onError?.(error, context);
  }
}

export class ChannelGatewayClosedError extends Error {
  constructor() {
    super("ChannelGateway 已关闭或正在关闭。");
    this.name = "ChannelGatewayClosedError";
  }
}

type ChannelInboundRecordIdentity = {
  readonly adapterId: string;
  readonly channel: string;
  readonly accountId: string;
};

function sameIdentity(
  left: ChannelInboundRecordIdentity,
  right: ChannelInboundRecordIdentity,
): boolean {
  return (
    left.adapterId === right.adapterId &&
    left.channel === right.channel &&
    left.accountId === right.accountId
  );
}

function assertRegistration(registration: ChannelRegistration): void {
  if (!registration || typeof registration !== "object") {
    throw new TypeError("ChannelRegistration 格式无效。");
  }
  const identity = registration.adapter?.identity;
  if (
    !identity ||
    !safeIdentityPart(identity.adapterId) ||
    !safeIdentityPart(identity.channel) ||
    !safeIdentityPart(identity.accountId)
  ) {
    throw new TypeError("ChannelAdapter identity 格式无效。");
  }
  if (registration.profile !== "read-only") {
    throw new TypeError("外部 ChannelAdapter 当前只能使用 read-only profile。");
  }
  if (!registration.accessPolicy || typeof registration.accessPolicy.authorize !== "function") {
    throw new TypeError("ChannelRegistration.accessPolicy 格式无效。");
  }
  if (typeof registration.adapter.start !== "function" ||
      typeof registration.adapter.deliver !== "function" ||
      typeof registration.adapter.stop !== "function") {
    throw new TypeError("ChannelAdapter 生命周期接口不完整。");
  }
}

function safeIdentityPart(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value === value.trim() &&
    ![...value].some((character) => (character.codePointAt(0) ?? 0) < 0x20)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

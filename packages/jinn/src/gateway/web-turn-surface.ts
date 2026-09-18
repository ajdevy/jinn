import type { Connector, JinnConfig, StreamDelta } from "../shared/types.js";
import type { GatewayEmit } from "../shared/gateway-events.js";
import { logger } from "../shared/logger.js";
import { getSession, insertMessage } from "../sessions/registry.js";
import type { TurnReceipt, TurnSurface } from "../sessions/turn/types.js";
import { hasOperatorFacingSignal } from "../sessions/turn/operator-facing-signal.js";
import { deliverConnectorMessage, deliverConnectorReply, deliverLogChannelReply } from "./connector-reply.js";

export interface WebTurnSurfaceOptions {
  sessionId: string;
  emit: GatewayEmit;
  connectors: Map<string, Connector>;
  getConfig: () => JinnConfig;
  /** Notification turns must not reply to the stale inbound message. */
  replyToMessage?: boolean;
  /** Durable queue identity, when this turn can be replayed after restart. */
  deliveryKey?: string;
  /**
   * What started this turn. `"notification"` means the turn was triggered only
   * by a child-session (or other internal) notification, with no operator
   * message in the same turn — routine replies from such a turn default to
   * `notifications.logChannel` when configured (see connector-reply.ts). Any
   * other value, including omitted, keeps the primary-target behavior: a real
   * operator message always reaches the primary connector.
   */
  triggerKind?: "notification" | "operator";
}

/**
 * Carry a turn over the dashboard: stream deltas to the live view, keep
 * lifecycle prose in the transcript, and relay the answer onward to a chat
 * channel when the session originally came from one.
 */
export function createWebTurnSurface(options: WebTurnSurfaceOptions): TurnSurface {
  const { sessionId, emit } = options;

  return {
    async started() {
      // `session:started` is emitted at dispatch, before the queue slot opens,
      // so the dashboard shows a spinner while the turn is still queued.
    },
    delta(delta: StreamDelta) {
      try {
        emit("session:delta", {
          sessionId,
          type: delta.type,
          content: delta.content,
          toolName: delta.toolName,
          toolId: delta.toolId,
          activityReceiptId: delta.activityReceiptId,
          input: delta.input,
          block: delta.block,
        });
      } catch (err) {
        logger.warn(`Failed to emit stream delta for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    async notice(text: string) {
      insertMessage(sessionId, "notification", text);
    },
    async reply(text: string) {
      const session = getSession(sessionId);
      if (!session) return;
      if (options.triggerKind === "notification" && !hasOperatorFacingSignal(text)) {
        const config = options.getConfig();
        if (config.notifications?.logChannel) {
          await deliverLogChannelReply(session, text, options.connectors, config, options.deliveryKey);
          return;
        }
      }
      const deliver = options.replyToMessage === false ? deliverConnectorMessage : deliverConnectorReply;
      await deliver(session, text, options.connectors, options.deliveryKey);
    },
    async waiting() {
      // The dashboard reads the waiting state off the session row directly.
    },
    async settled(receipt: TurnReceipt) {
      emit("session:completed", {
        sessionId,
        employee: receipt.session.employee || options.getConfig().portal?.portalName || "Jinn",
        title: receipt.session.title,
        result: receipt.result,
        error: receipt.error,
        cost: receipt.cost,
        durationMs: receipt.durationMs,
      });
    },
  };
}

import { initDb } from "../shared/db.js";

export type ConnectorDeliveryKind = "reply" | "message";

/** Stable identity for one terminal connector delivery. */
export function connectorDeliveryKey(
  sessionId: string,
  attemptToken: string,
  kind: ConnectorDeliveryKind,
): string {
  return `turn:${sessionId}:${attemptToken}:${kind}`;
}

/**
 * Claim the delivery before network I/O. Telegram and the other connectors do
 * not accept an idempotency key, so a receipt that survives a restart is the
 * only safe answer to an ambiguous POST: a replay is suppressed rather than
 * risking a second human-visible message.
 */
export function claimConnectorDelivery(deliveryKey: string): boolean {
  if (!deliveryKey.trim()) throw new Error("connector delivery key must be non-empty");
  return initDb().prepare(
    "INSERT INTO connector_delivery_receipts (delivery_key, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
  ).run(deliveryKey, Date.now()).changes === 1;
}

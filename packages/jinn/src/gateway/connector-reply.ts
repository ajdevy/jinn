import type { Connector, JinnConfig, OutboundDocument, Session, Target } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { claimConnectorDelivery, connectorDeliveryKey, type ConnectorDeliveryKind } from "../sessions/connector-delivery-dedupe.js";

/** Sources whose turns have no originating chat channel to relay back into. */
const NON_CONNECTOR_SOURCES = new Set(["web", "talk", "cron"]);

type ConnectorSession = Pick<Session, "source" | "connector" | "replyContext" | "attemptToken"> & { id?: string };

function stableDeliveryKey(
  session: ConnectorSession,
  kind: ConnectorDeliveryKind,
  explicitKey?: string,
): string | undefined {
  if (explicitKey) return `${explicitKey}:${kind}`;
  if (!session.id || !session.attemptToken) return undefined;
  return connectorDeliveryKey(session.id, session.attemptToken, kind);
}

/**
 * Resolve the connector and target a session's outbound traffic belongs to, or
 * `null` when the session has no chat channel behind it. Shared by the text and
 * document relays so both agree on which sessions are reachable.
 */
function resolveConnectorTarget(
  session: ConnectorSession,
  connectors: Map<string, Connector>,
): { connector: Connector; target: Target } | null {
  if (NON_CONNECTOR_SOURCES.has(session.source)) return null;
  if (!session.connector || !session.replyContext) return null;
  const connector = connectors.get(session.connector);
  if (!connector) {
    logger.warn(`Connector delivery dropped for session ${session.id ?? "?"}: no connector registered as "${session.connector}"`);
    return null;
  }
  return { connector, target: connector.reconstructTarget(session.replyContext) };
}

/**
 * Relay a completed turn's assistant text back to the connector channel that
 * originated the session. Inbound connector messages reply through their own
 * surface, but turns started elsewhere (parent callbacks, cron follow-ups,
 * rate-limit resumes) otherwise never reach the channel. No-ops for web/talk/cron
 * sources, empty text, or a missing connector/replyContext; errors are logged and
 * swallowed so delivery failure never breaks completion.
 */
export async function deliverConnectorReply(
  session: ConnectorSession,
  text: string,
  connectors: Map<string, Connector>,
  deliveryKey?: string,
): Promise<void> {
  if (!text) return;
  const resolved = resolveConnectorTarget(session, connectors);
  if (!resolved) return;
  try {
    const stableKey = stableDeliveryKey(session, "reply", deliveryKey);
    if (stableKey && !claimConnectorDelivery(stableKey)) {
      logger.debug(`Connector reply delivery replay suppressed for session ${session.id ?? "?"}`);
      return;
    }
    await resolved.connector.replyMessage(resolved.target, text);
  } catch (err) {
    logger.warn(
      `Connector reply delivery failed for session ${session.id ?? "?"}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Relay text without attaching it to the last inbound message. */
export async function deliverConnectorMessage(
  session: ConnectorSession,
  text: string,
  connectors: Map<string, Connector>,
  deliveryKey?: string,
): Promise<void> {
  if (!text) return;
  const resolved = resolveConnectorTarget(session, connectors);
  if (!resolved) return;
  try {
    const stableKey = stableDeliveryKey(session, "message", deliveryKey);
    if (stableKey && !claimConnectorDelivery(stableKey)) {
      logger.debug(`Connector message delivery replay suppressed for session ${session.id ?? "?"}`);
      return;
    }
    await resolved.connector.sendMessage(resolved.target, text);
  } catch (err) {
    logger.warn(
      `Connector message delivery failed for session ${session.id ?? "?"}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Resolve the connector and target `notifications.logChannel` routes to, or
 * `null` when the deployment has not opted into a separate log channel (the
 * documented fallback: primary target unchanged). `logConnector` defaults to
 * the session's own originating connector, so a channel/group living on the
 * same connector as the session needs only `logChannel` configured.
 */
function resolveLogTarget(
  session: ConnectorSession,
  config: Pick<JinnConfig, "notifications">,
  connectors: Map<string, Connector>,
): { connector: Connector; target: Target } | null {
  const logChannel = config.notifications?.logChannel;
  if (!logChannel) return null;
  const connectorName = config.notifications?.logConnector || session.connector;
  if (!connectorName) return null;
  const connector = connectors.get(connectorName);
  if (!connector) {
    logger.warn(`Log-channel delivery dropped for session ${session.id ?? "?"}: no connector registered as "${connectorName}"`);
    return null;
  }
  return { connector, target: { channel: logChannel } };
}

/**
 * Relay a turn's reply to the configured `notifications.logChannel` instead of
 * the session's originating connector target. Used for a turn triggered only
 * by a routine child-session notification, so status chatter defaults out of
 * the primary chat — see gateway/web-turn-surface.ts for the trigger-source
 * and operator-facing-signal checks that gate this call. No-ops when no log
 * channel is configured or its connector cannot be resolved; errors are logged
 * and swallowed like every other connector delivery here.
 */
export async function deliverLogChannelReply(
  session: ConnectorSession,
  text: string,
  connectors: Map<string, Connector>,
  config: Pick<JinnConfig, "notifications">,
  deliveryKey?: string,
): Promise<void> {
  if (!text) return;
  const resolved = resolveLogTarget(session, config, connectors);
  if (!resolved) return;
  try {
    const stableKey = stableDeliveryKey(session, "log", deliveryKey);
    if (stableKey && !claimConnectorDelivery(stableKey)) {
      logger.debug(`Log-channel delivery replay suppressed for session ${session.id ?? "?"}`);
      return;
    }
    await resolved.connector.sendMessage(resolved.target, text);
  } catch (err) {
    logger.warn(
      `Log-channel delivery failed for session ${session.id ?? "?"}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Relay a published attachment into the connector channel that originated the
 * session. Without this an attachment reaches the web dashboard only, and a
 * Telegram or Slack operator is told a file was published that never arrives.
 * No-ops when the connector has no document support, so a connector that has
 * not implemented `sendDocument` keeps the previous web-only behaviour instead
 * of throwing. Errors are logged and swallowed: the file is already stored and
 * the HTTP response must not fail because a chat send did.
 */
export async function deliverConnectorAttachment(
  session: ConnectorSession,
  doc: OutboundDocument,
  connectors: Map<string, Connector>,
): Promise<void> {
  const resolved = resolveConnectorTarget(session, connectors);
  if (!resolved) return;
  const { connector, target } = resolved;
  if (!connector.sendDocument) {
    logger.info(`Attachment stayed web-only for session ${session.id ?? "?"}: connector "${connector.id}" has no document support`);
    return;
  }
  try {
    await connector.sendDocument(target, doc);
  } catch (err) {
    logger.warn(
      `Connector attachment delivery failed for session ${session.id ?? "?"}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

import type { Connector, JinnConfig, Session, Target } from "../../shared/types.js";
import type { GatewayEmit } from "../../shared/gateway-events.js";
import type { TurnReceipt, TurnSurface } from "./types.js";

const THINKING_STATUS = "is thinking...";
const RUNNING_REACTION = "eyes";
const WAITING_REACTION = "hourglass_flowing_sand";

export interface ConnectorTurnSurfaceOptions {
  connector: Connector;
  target: Target;
  session: Session;
  config: JinnConfig;
  /**
   * Whether the turn is allowed to decorate the channel. Cron turns run silently
   * so a scheduled job doesn't spray reactions over a human's thread.
   */
  decorate: boolean;
  emit?: GatewayEmit;
}

/** Carry a turn over a chat connector: reactions, typing status, and replies. */
export function createConnectorTurnSurface(options: ConnectorTurnSurfaceOptions): TurnSurface {
  const { connector, target, decorate } = options;
  const capabilities = connector.getCapabilities();
  const threadTs = target.thread || target.messageTs;

  const send = async (text: string): Promise<void> => {
    if (!text) return;
    await connector.replyMessage(target, text).catch(() => {});
  };
  const setTyping = async (status: string): Promise<void> => {
    if (!decorate || !connector.setTypingStatus) return;
    await connector.setTypingStatus(target.channel, threadTs, status).catch(() => {});
  };
  const react = async (add: readonly string[], remove: readonly string[]): Promise<void> => {
    if (!decorate || !capabilities.reactions) return;
    for (const emoji of remove) await connector.removeReaction(target, emoji).catch(() => {});
    for (const emoji of add) await connector.addReaction(target, emoji).catch(() => {});
  };

  return {
    async started() {
      await react([RUNNING_REACTION], []);
      await setTyping(THINKING_STATUS);
    },
    delta() {
      // Chat connectors post whole messages; there is no live view to stream into.
    },
    notice: send,
    reply: send,
    async waiting(active: boolean) {
      await setTyping(active ? "" : THINKING_STATUS);
      await react(active ? [WAITING_REACTION] : [RUNNING_REACTION], active ? [RUNNING_REACTION] : [WAITING_REACTION]);
    },
    async settled(receipt: TurnReceipt) {
      await setTyping("");
      await react([], [RUNNING_REACTION, WAITING_REACTION]);
      options.emit?.("session:completed", {
        sessionId: receipt.session.id,
        employee: receipt.session.employee || options.config.portal?.portalName || "Jinn",
        title: receipt.session.title,
        result: receipt.result,
        error: receipt.error,
        cost: receipt.cost,
        durationMs: receipt.durationMs,
      });
    },
  };
}

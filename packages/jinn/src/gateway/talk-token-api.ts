import type { ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { JinnConfig } from "../shared/types.js";
import type { RealtimeTool } from "../shared/voice.js";
import { logger } from "../shared/logger.js";
import { UnknownRealtimeProviderError, createRealtimeProvider } from "../talk/realtime/index.js";
import { json } from "./route-helpers.js";

/**
 * Mint a provider credential, optionally requiring it to outlive a predecessor.
 *
 * Configuration gaps and provider failures are translated into the Talk HTTP
 * contract here so callers only need to decide which tool catalog to expose.
 */
export async function mintTalkToken(
  res: ServerResponse,
  config: JinnConfig,
  tools: RealtimeTool[],
  expiresAfter?: number,
) {
  const mint = async () => {
    let realtime;
    try {
      realtime = createRealtimeProvider(config.realtime ?? {});
    } catch (error) {
      const detail = error instanceof UnknownRealtimeProviderError || error instanceof Error
        ? error.message
        : "realtime is not configured";
      json(res, {
        error: "Voice is not available.",
        reason: "unconfigured",
        detail,
      }, 503);
      return null;
    }
    try {
      return await realtime.mintEphemeralToken({ tools });
    } catch (error) {
      logger.warn(`Realtime token mint failed: ${error instanceof Error ? error.message : String(error)}`);
      json(res, { error: "The realtime provider refused to issue a session credential." }, 502);
      return null;
    }
  };

  const token = await mint();
  if (expiresAfter === undefined || !token || token.expiresAt > expiresAfter) return token;

  // Provider expiries are whole seconds. Waiting out the current second gives
  // a resumed session one chance to receive a genuinely longer-lived token.
  await delay(1000 - (Date.now() % 1000));
  const retried = await mint();
  if (!retried || retried.expiresAt > expiresAfter) return retried;
  json(res, {
    error: "The realtime provider reissued a session credential that expires no later than the one it replaced.",
  }, 502);
  return null;
}

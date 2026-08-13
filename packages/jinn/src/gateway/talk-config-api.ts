/**
 * `GET /api/talk/config` — what the voice surface needs to know before it asks
 * for a session.
 *
 * The orb has to answer "is voice set up here?" without minting anything:
 * minting is a billed call to the provider, so an operator with no provider
 * configured would be charged to be told they have none. This route reports
 * capability only — the providers the gateway implements, and whether the
 * configured one would actually build. The answer is a boolean rather than the
 * `realtime` block itself so that no shape of this response can carry the key.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JinnConfig } from "../shared/types.js";
import { REALTIME_PROVIDERS, isRealtimeConfigured } from "../talk/realtime/index.js";

/**
 * Handle `/api/talk/config`, returning false for anything else so the caller
 * falls through to the rest of the talk router.
 */
export function handleTalkConfigApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  config: JinnConfig,
): boolean {
  if (pathname !== "/api/talk/config" || (req.method ?? "GET") !== "GET") return false;
  const realtime = config.realtime ?? {};
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      configured: isRealtimeConfigured(realtime),
      provider: realtime.provider ?? null,
      providers: REALTIME_PROVIDERS,
    }),
  );
  return true;
}

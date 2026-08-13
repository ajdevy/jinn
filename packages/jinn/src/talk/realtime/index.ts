/**
 * The only place a realtime provider is constructed.
 *
 * Mirrors `createConnector` in gateway/server.ts: switch on the configured
 * name, throw on one we do not implement. README.md in this directory writes up
 * Gemini Live as the second implementation of the same interface.
 */
import { resolveEnvVar } from "../../shared/env-ref.js";
import type { RealtimeConfig, RealtimeProvider } from "../../shared/voice.js";
import { createOpenAiRealtimeProvider } from "./openai.js";

export type { RealtimeConfig };

/** Provider names `createRealtimeProvider` accepts. */
export const REALTIME_PROVIDERS = ["openai"] as const;

export class UnknownRealtimeProviderError extends Error {
  readonly provider: string | undefined;

  constructor(provider: string | undefined) {
    const named = provider ? `Unknown realtime provider "${provider}"` : "realtime.provider is not set";
    super(`${named} — set realtime.provider to one of: ${REALTIME_PROVIDERS.join(", ")}`);
    this.name = "UnknownRealtimeProviderError";
    this.provider = provider;
  }
}

/**
 * Build the provider named by the `realtime` config block. `apiKey` may be a
 * `${ENV_VAR}` reference, so the key can live in the environment rather than in
 * config.yaml. Throws {@link UnknownRealtimeProviderError} for a name we do not
 * implement, and a plain Error when the named provider is missing its key.
 */
export function createRealtimeProvider(config: RealtimeConfig): RealtimeProvider {
  switch (config.provider) {
    case "openai":
      return createOpenAiRealtimeProvider({
        apiKey: resolveEnvVar(config.apiKey) ?? "",
        session: {
          ...(config.model ? { model: config.model } : {}),
          ...(config.voice ? { voice: config.voice } : {}),
          ...(config.turnDetection ? { turnDetection: config.turnDetection } : {}),
        },
      });
    default:
      throw new UnknownRealtimeProviderError(config.provider);
  }
}

/**
 * Whether {@link createRealtimeProvider} would succeed on this block.
 *
 * Answered by building one rather than by re-stating the rules, so the setup
 * surface can never drift from the factory it is describing — a provider name
 * this file does not implement and a `${ENV_VAR}` key whose variable is unset
 * both read as unconfigured, because both are what the factory refuses.
 * Construction opens no socket and mints nothing, so asking costs nothing.
 */
export function isRealtimeConfigured(config: RealtimeConfig): boolean {
  try {
    createRealtimeProvider(config);
    return true;
  } catch {
    return false;
  }
}

import type { SpawnSessionInput, SpawnSessionOutcome } from "../../gateway/spawn-session.js";

/**
 * The two things a plugin's backend needs from a *running* gateway, registered
 * once at boot — the same shape `work-items/live-events.ts` uses, and for the
 * same reason: a plugin's server module is loaded by the plugin loader, which
 * has no request and no `ApiContext` to thread through it.
 *
 * Null is the honest state in tests and in CLI runs with no server. The two
 * verbs answer it differently on purpose: a notice that nobody can show is
 * dropped, because a plugin should not fall over for want of a toast, while a
 * spawn that cannot happen throws, because silently not starting a session is
 * the failure a caller must never have to discover for itself.
 */

export type PluginNoticeLevel = "info" | "warning" | "error";

export interface PluginHostGateway {
  spawnSession: (input: SpawnSessionInput) => Promise<SpawnSessionOutcome>;
  emitNotice: (pluginId: string, message: string, level: PluginNoticeLevel) => void;
}

let gateway: PluginHostGateway | null = null;

export function setPluginHostGateway(next: PluginHostGateway | null): void {
  gateway = next;
}

/** Throws rather than returning null, so every caller that needs the gateway
 *  says why it could not act instead of returning an empty success. */
export function requirePluginHostGateway(verb: string): PluginHostGateway {
  if (!gateway) {
    throw new Error(`host.${verb} needs a running gateway, and none is registered in this process`);
  }
  return gateway;
}

export function emitPluginNotice(pluginId: string, message: string, level: PluginNoticeLevel): void {
  if (!gateway) return;
  try {
    gateway.emitNotice(pluginId, message, level);
  } catch {
    // A broken notification surface is the gateway's bug, and the plugin that
    // asked for the notice is the wrong place for it to land.
  }
}

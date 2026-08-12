import type { ApiContext } from "../gateway/api.js";
import { spawnSession } from "../gateway/spawn-session.js";
import type { JinnConfig } from "../shared/types.js";
import { setPluginHostGateway } from "./host/gateway-link.js";
import { reconcilePluginWatchers, stopAllPluginWatchers } from "./watcher-supervisor.js";

/**
 * Every enabled plugin's runtime, started and stopped as one thing.
 *
 * The order is the point: the typed host verbs get their gateway *before* any
 * plugin module is imported, so a watcher that spawns a session on its first
 * tick finds a gateway rather than an error. Stopping releases it again, so a
 * gateway that has shut down cannot still be spawned into by a plugin that
 * outlived it.
 */
export function startPluginRuntime(
  context: ApiContext,
  getConfig: () => Pick<JinnConfig, "plugins">,
): Promise<void> {
  setPluginHostGateway({
    spawnSession: (input) => spawnSession(context, input),
    emitNotice: (pluginId, message, level) => context.emit("plugin:notice", { pluginId, message, level }),
  });
  return reconcilePluginWatchers(getConfig);
}

export async function stopPluginRuntime(): Promise<void> {
  await stopAllPluginWatchers();
  setPluginHostGateway(null);
}

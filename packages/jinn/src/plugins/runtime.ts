import type { ApiContext } from "../gateway/api.js";
import { spawnSession } from "../gateway/spawn-session.js";
import { redactText } from "../shared/redact.js";
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
    // Read off the context rather than captured at boot: `server.ts` mutates the
    // same object in place across a config reload, so a copy would go stale.
    ...(context.workflowService ? { workflowService: context.workflowService } : {}),
    sendConnectorMessage: async (connector, message) => {
      const target = context.connectors.get(connector);
      if (!target) return { ok: false, error: `no connector "${connector}" is configured` };
      // The same redaction `POST /api/connectors/:name/send` applies, so a
      // plugin cannot use the in-process path to leak what the route would mask.
      await target.sendMessage(
        { channel: message.channel, ...(message.thread ? { thread: message.thread } : {}) },
        redactText(message.text),
      );
      return { ok: true };
    },
  });
  return reconcilePluginWatchers(getConfig);
}

export async function stopPluginRuntime(): Promise<void> {
  await stopAllPluginWatchers();
  setPluginHostGateway(null);
}

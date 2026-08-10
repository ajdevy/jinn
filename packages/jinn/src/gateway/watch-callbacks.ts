import type { GatewayEmit } from "@jinn/gateway-events";
import { loadJobs } from "../cron/jobs.js";
import { reloadScheduler } from "../cron/scheduler.js";
import { scanPlugins } from "../plugins/discovery.js";
import { logger } from "../shared/logger.js";
import type { WatcherCallbacks } from "./watcher.js";

/** The two reloads that only the server can perform, since they own state it holds. */
export interface WatchDependencies {
  reloadConfig: () => void;
  reloadOrg: () => void;
  emit: GatewayEmit;
}

/** What the gateway does when a watched path changes. Each callback re-reads the
 *  thing that changed and tells connected clients, so an edit on disk takes effect
 *  without a restart. */
export function gatewayWatchCallbacks({ reloadConfig, reloadOrg, emit }: WatchDependencies): WatcherCallbacks {
  return {
    onConfigReload: reloadConfig,
    onCronReload: () => {
      const updatedJobs = loadJobs();
      reloadScheduler(updatedJobs);
      logger.info(`Cron jobs reloaded (${updatedJobs.length} job(s))`);
      emit("cron:reloaded", {});
    },
    onOrgChange: reloadOrg,
    onSkillsChange: () => {
      logger.info("Skills changed, notifying clients");
      emit("skills:changed", {});
    },
    onPluginsChange: () => {
      // Rescanning here rather than only on request is what surfaces a broken
      // manifest in the log at the moment it is saved, instead of the next time
      // somebody opens the settings page.
      void scanPlugins()
        .then((plugins) => {
          logger.info(`Plugins rescanned (${plugins.length} installed)`);
          emit("plugins:changed", {});
        })
        .catch((err) => logger.error(`Plugin rescan failed: ${err instanceof Error ? err.message : err}`));
    },
  };
}

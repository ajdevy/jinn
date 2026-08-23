import { logger } from "../shared/logger.js";
import type { Employee, JinnConfig } from "../shared/types.js";
import { scanOrg } from "./org.js";

/**
 * The one place production code asks "who is in the org". `scanOrg` walks the
 * whole org tree off disk on every call; this module caches that walk and is
 * the only production caller of it.
 *
 * Invalidation is the chokidar org watcher (`onOrgChange` → `reloadOrg`) plus
 * the synchronous refresh the employee-update API does right after a write, so
 * a read never trails a write.
 */
export interface OrgRead {
  registry: Map<string, Employee>;
  /** Why the roster is degraded. Set only when the last scan threw. */
  error?: string;
}

/**
 * `config` is held by reference, not by value: `resolveSystemEmployees` derives
 * the system employees' engine/model from it, so a caller that arrives with a
 * different config must not be served a roster built from another one.
 */
let cache: { registry: Map<string, Employee>; config?: JinnConfig; error?: string } | undefined;

/** Re-walk the org tree and cache the result. */
export function refreshOrg(config?: JinnConfig): OrgRead {
  try {
    cache = { registry: scanOrg(config), config };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Keep the last known good roster. Handing back an empty map here would
    // read downstream as "the company has no employees", which is a different
    // and much more damaging claim than "the roster could not be read".
    cache = { registry: cache?.registry ?? new Map(), config, error };
    logger.error(`Org scan failed — serving the last known roster of ${cache.registry.size} employee(s): ${error}`);
  }
  return { registry: cache.registry, error: cache.error };
}

/** The cached roster, scanning only if nothing good was cached for this config. */
export function readOrg(config?: JinnConfig): OrgRead {
  // A degraded cache is not a valid one: retry the scan so a transient failure
  // costs one turn's roster rather than every turn until org/ next changes.
  if (!cache || cache.error || cache.config !== config) return refreshOrg(config);
  return { registry: cache.registry };
}

/** The roster alone, for the many callers that have no use for the failure. */
export function orgRegistry(config?: JinnConfig): Map<string, Employee> {
  return readOrg(config).registry;
}

export function resetOrgRegistryForTests(): void {
  cache = undefined;
}

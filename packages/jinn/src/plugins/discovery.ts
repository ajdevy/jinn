import fs from "node:fs/promises";
import path from "node:path";
import { PLUGINS_DIR } from "../shared/paths.js";
import { validateManifest } from "./manifest.js";

/** `disabled` is applied by the caller that knows the operator's lists, not here. */
export type PluginStatus = "loaded" | "disabled" | "error";

/** One inventory row. A directory that fails validation still gets one, because a
 *  plugin that vanishes from the settings list when it breaks is one nobody can fix. */
export interface PluginRecord {
  id: string;
  name: string;
  version: string;
  kind: "client" | "client+server";
  status: PluginStatus;
  error?: string;
}

/** An inventory row plus the paths the gateway serves that plugin from. */
export interface DiscoveredPlugin extends PluginRecord {
  /** Absolute plugin directory. */
  dir: string;
  /** Absolute client entry, or null when the plugin failed to load. */
  client: string | null;
  /** Absolute server entry, or null when it is absent or was rejected. */
  server: string | null;
}

/** The wire shape, built field by field so a resolved local path cannot ride along. */
export function inventoryRow(plugin: DiscoveredPlugin): PluginRecord {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    kind: plugin.kind,
    status: plugin.status,
    ...(plugin.error ? { error: plugin.error } : {}),
  };
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** An unloadable directory, recorded under its folder name. `kind` states the
 *  minimum a plugin is made of, since a row that never loaded declared nothing. */
function errorRow(dir: string, error: string): DiscoveredPlugin {
  return {
    id: path.basename(dir),
    name: path.basename(dir),
    version: "0.0.0",
    kind: "client",
    status: "error",
    error,
    dir,
    client: null,
    server: null,
  };
}

async function readPlugin(dir: string): Promise<DiscoveredPlugin | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(path.join(dir, "plugin.json"), "utf-8"));
  } catch (err) {
    // The folder can vanish between the scan listing it and this read. Gone is
    // "not installed", not a load error; still there with no manifest is an error.
    if (isMissing(err) && !(await exists(dir))) return null;
    if (isMissing(err)) return errorRow(dir, "plugin.json is missing");
    return errorRow(dir, `plugin.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const result = validateManifest(raw, dir);
  if (!result.ok) return errorRow(dir, result.error);

  const manifest = result.manifest;
  if (!(await exists(manifest.client))) {
    return errorRow(dir, `client entry "${path.relative(dir, manifest.client)}" is missing`);
  }
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    kind: manifest.server ? "client+server" : "client",
    status: "loaded",
    ...(manifest.serverError ? { error: manifest.serverError } : {}),
    dir,
    client: manifest.client,
    server: manifest.server,
  };
}

async function readInstalledPlugins(): Promise<DiscoveredPlugin[]> {
  let entries;
  try {
    entries = await fs.readdir(PLUGINS_DIR, { withFileTypes: true });
  } catch (err) {
    // An absent plugins/ directory is zero plugins, not an error.
    if (isMissing(err)) return [];
    throw err;
  }
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(PLUGINS_DIR, entry.name));
  const plugins = await Promise.all(dirs.map(readPlugin));
  return plugins
    .filter((plugin): plugin is DiscoveredPlugin => plugin !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

let inFlight: Promise<DiscoveredPlugin[]> | null = null;

/**
 * The whole inventory, read from disk.
 *
 * Concurrent callers share one scan: reads can outlast the watcher's debounce
 * window, and a rescan landing on top of a scan that is still running would
 * report an inventory assembled from two different moments.
 */
export function scanPlugins(): Promise<DiscoveredPlugin[]> {
  if (inFlight) return inFlight;
  inFlight = readInstalledPlugins().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** The one plugin an `/api/plugins/<id>/…` request names, or null when nothing is
 *  installed under that id. */
export function loadPlugin(id: string): Promise<DiscoveredPlugin | null> {
  return readPlugin(path.join(PLUGINS_DIR, id));
}

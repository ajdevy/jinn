import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { logger } from "../shared/logger.js";
import type { JinnConfig } from "../shared/types.js";
import { pluginStorage, type PluginStorage } from "./storage.js";

/** One backend route. `req` and `res` are the gateway's own, unwrapped. */
export type PluginRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** What a registrar returns: `"GET /ping"` → handler. A map rather than a router
 *  object, because path parameters are not something a plugin needs yet and a
 *  matcher nobody uses is a matcher nobody has tested. */
export type PluginRoutes = Record<string, PluginRouteHandler>;

/** The context a plugin's `server.js` receives. `emit` (ICI-725) and `host`
 *  (ICI-726) join it later; nothing here forecloses them. */
export interface PluginServerContext {
  id: string;
  log: (message: string) => void;
  storage: PluginStorage;
  /** This plugin's slice of `config.plugins.settings`. A getter, not a snapshot —
   *  see {@link pluginSettings}. */
  readonly settings: Record<string, unknown>;
}

type PluginRegistrar = (context: PluginServerContext) => PluginRoutes | Promise<PluginRoutes>;

export type PluginDispatch =
  | { outcome: "handled" }
  | { outcome: "no-route" }
  /** The plugin failed. `message` is the gateway's own wording — a third party's
   *  error text and stack stay in the log, not on the wire. */
  | { outcome: "failed"; message: string };

export interface PluginDispatchRequest {
  id: string;
  /** Absolute path to the plugin's server entry. */
  server: string;
  method: string;
  /** The path below `/api/plugins/<id>/`, without a leading slash. */
  tail: string;
  readSettings: () => Record<string, unknown>;
}

/** A registrar's routes for one version of one file, or null when that version
 *  failed to import or to register. Failure is cached too: a plugin whose module
 *  throws must not be re-imported on every request until its author fixes it. */
interface BackendEntry {
  version: string;
  routes: PluginRoutes | null;
}

const entries = new Map<string, BackendEntry>();

/** How many times a plugin's backend has been disposed. It joins the import
 *  specifier because dropping our own entry is not enough: Node keeps its module
 *  cache keyed on the specifier, so an unchanged file re-enabled under the same
 *  one hands back the very incarnation the operator turned off. Each generation
 *  leaves its predecessor in that cache, exactly as every file edit already does
 *  — the accepted cost of hot-reloading ESM, which offers no way to evict. */
const generations = new Map<string, number>();

/**
 * The plugin's slice of `config.plugins.settings`, `{}` when the operator has
 * written none. Read through the context's getter rather than captured at import
 * time, so editing `config.yaml` reaches a registrar that loaded before the edit.
 */
export function pluginSettings(id: string, config: Pick<JinnConfig, "plugins">): Record<string, unknown> {
  const settings = config.plugins?.settings?.[id];
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
  return settings;
}

/** The file's half of what the module cache is keyed on. Null when the file is
 *  gone, which drops the entry rather than serving the last version that happened
 *  to import. */
async function fileStamp(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function makeContext(id: string, readSettings: () => Record<string, unknown>): PluginServerContext {
  return {
    id,
    log: (message) => logger.info(`[plugin:${id}] ${message}`),
    storage: pluginStorage(id),
    get settings() {
      return readSettings();
    },
  };
}

/** Import the server entry and call its registrar. Throws on anything the plugin
 *  gets wrong; {@link backendRoutes} is what turns that into a cached failure. */
async function register(request: PluginDispatchRequest, version: string): Promise<PluginRoutes> {
  // The query is what defeats the ESM module cache: same path, new specifier, so
  // an edited file — or a plugin disposed and enabled again — is re-evaluated
  // without a gateway restart or a plugin rescan.
  const specifier = `${pathToFileURL(request.server).href}?v=${encodeURIComponent(version)}`;
  const registrar = (await import(specifier)).default as unknown;
  if (typeof registrar !== "function") {
    throw new TypeError(`${request.server} must default-export a function that returns routes`);
  }
  const routes = await (registrar as PluginRegistrar)(makeContext(request.id, request.readSettings));
  if (!routes || typeof routes !== "object") {
    throw new TypeError(`${request.server} registrar must return an object of "METHOD /path" routes`);
  }
  return routes;
}

/** A manifest may declare a `server` entry that is not on disk — discovery keeps
 *  the plugin loaded and lets its client half run — so "no file" is a route that
 *  does not exist, not a plugin that broke. */
type RoutesResult = { ok: true; routes: PluginRoutes } | { ok: false; reason: "missing" | "failed" };

/** This plugin's routes for the server file as it stands right now. */
async function backendRoutes(request: PluginDispatchRequest): Promise<RoutesResult> {
  const stamp = await fileStamp(request.server);
  if (stamp === null) {
    entries.delete(request.id);
    return { ok: false, reason: "missing" };
  }
  const version = `${generations.get(request.id) ?? 0}:${stamp}`;
  const cached = entries.get(request.id);
  if (cached?.version === version) {
    return cached.routes ? { ok: true, routes: cached.routes } : { ok: false, reason: "failed" };
  }

  try {
    const routes = await register(request, version);
    entries.set(request.id, { version, routes });
    return { ok: true, routes };
  } catch (err) {
    entries.set(request.id, { version, routes: null });
    logger.error(`Plugin "${request.id}" failed to load: ${err instanceof Error ? err.stack ?? err.message : err}`);
    return { ok: false, reason: "failed" };
  }
}

/**
 * Run one request against a plugin's own routes.
 *
 * Every call into third-party code — the registrar and the handler alike — is
 * wrapped, because a plugin failing is an expected event and the gateway serves
 * every other request through the same process. An escaping throw would answer
 * with the plugin's own error text; an unawaited rejection would reach the
 * process as an unhandled rejection. Both stop here, at this plugin's request.
 */
export async function dispatchPluginRequest(
  req: IncomingMessage,
  res: ServerResponse,
  request: PluginDispatchRequest,
): Promise<PluginDispatch> {
  const loaded = await backendRoutes(request);
  if (!loaded.ok) {
    if (loaded.reason === "missing") return { outcome: "no-route" };
    return { outcome: "failed", message: `plugin "${request.id}" failed to load` };
  }

  const handler = loaded.routes[`${request.method} /${request.tail}`];
  if (typeof handler !== "function") return { outcome: "no-route" };

  try {
    await handler(req, res);
    return { outcome: "handled" };
  } catch (err) {
    logger.error(
      `Plugin "${request.id}" failed on ${request.method} /${request.tail}: ` +
        `${err instanceof Error ? err.stack ?? err.message : err}`,
    );
    return { outcome: "failed", message: `plugin "${request.id}" failed to handle the request` };
  }
}

/** Forget a plugin's registrar. Called when it stops being servable, so
 *  re-enabling it imports the module again rather than resurrecting the
 *  incarnation that was running when the operator turned it off. */
export function disposePluginBackend(id: string): void {
  entries.delete(id);
  generations.set(id, (generations.get(id) ?? 0) + 1);
}

/** Forget every loaded backend whose plugin is no longer servable. The request
 *  path disposes lazily, on the first request that finds a plugin disabled — and
 *  that request never arrives when the operator disables and re-enables in one
 *  sitting, which would leave the plugin answering from the incarnation they
 *  turned off. */
export function disposeUnservableBackends(isServable: (id: string) => boolean): void {
  for (const id of [...entries.keys()]) {
    if (!isServable(id)) disposePluginBackend(id);
  }
}

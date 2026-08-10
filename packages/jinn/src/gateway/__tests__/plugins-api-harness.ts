import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import yaml from "js-yaml";

/**
 * The rig plugins-api.test.ts drives the routes through: a private instance home,
 * a plugin installer, and a request that enters handleApiRequest the way the
 * server calls it. It lives beside the test rather than in it because the routes
 * pushed the suite past the size ratchet.
 *
 * JINN_HOME is set here, at module scope, because paths.js reads it once — every
 * gateway import has to come after this file's body has run, which is why the
 * test reaches api.js through `startHarness` instead of importing it.
 */
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-plugins-api-"));
process.env.JINN_HOME = tmpHome;
export const pluginsDir = path.join(tmpHome, "plugins");
const configPath = path.join(tmpHome, "config.yaml");

fs.mkdirSync(path.join(tmpHome, "sessions"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });

type Api = typeof import("../api.js");
let api: Api;

/** The operator's lists, as `config.yaml` carries them. */
export function writeConfig(plugins?: { enabled?: string[]; disabled?: string[] }): void {
  fs.writeFileSync(
    configPath,
    yaml.dump({
      gateway: {},
      engines: { default: "codex", claude: {}, codex: { bin: "codex", model: "gpt-5.5" } },
      portal: { portalName: "Portal COO", setupComplete: true },
      connectors: {},
      mcp: {},
      sessions: {},
      ...(plugins ? { plugins } : {}),
    }),
  );
}

const apiCtx = {
  getConfig: () => yaml.load(fs.readFileSync(configPath, "utf-8")),
  reloadConfig: () => {},
  reloadOrg: () => {},
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map([["codex", {}]]),
    getEngine: () => undefined,
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
  },
} as unknown as import("../api.js").ApiContext;

function makeRes() {
  let status = 200;
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  const res = {
    writeHead(code: number, sent?: Record<string, string>) {
      status = code;
      Object.assign(headers, sent ?? {});
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    headers,
    get status() {
      return status;
    },
    get bodyText() {
      return Buffer.concat(chunks).toString("utf-8");
    },
    get body() {
      return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    },
  };
}

/** A request straight into the dispatch chain, the way the server calls it. */
export async function call(
  method: string,
  urlPath: string,
  headers: Record<string, string> = { authorization: "Bearer test-token" },
) {
  const req = Object.assign(Readable.from([]), {
    method,
    url: urlPath,
    headers: { host: "localhost", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
  return cap;
}

/** A plugin directory. `client.js` is written unless the case replaces it. */
export function install(id: string, manifest: unknown, files: Record<string, string> = {}): void {
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries({ "client.js": "export default { id: 'x' }", ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

/** Boot the gateway modules against the private home, and hand back the two the
 *  auth-namespace assertion needs. */
export async function startHarness(): Promise<{
  authRequiredForRequest: (typeof import("../auth.js"))["authRequiredForRequest"];
  routePrefix: string;
}> {
  writeConfig();
  api = await import("../api.js");
  (await import("../../shared/db.js")).initDb();
  const { authRequiredForRequest } = await import("../auth.js");
  const { PLUGIN_ROUTE_PREFIX } = await import("../plugins-api.js");
  return { authRequiredForRequest, routePrefix: PLUGIN_ROUTE_PREFIX };
}

/** An empty plugins directory, the state every case starts from. */
export function resetPlugins(): void {
  fs.rmSync(pluginsDir, { recursive: true, force: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
}

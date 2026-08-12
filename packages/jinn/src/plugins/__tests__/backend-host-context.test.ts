import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginServerContext } from "../backend.js";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-plugin-ctx-"));
process.env.JINN_HOME = tmpHome;
const pluginsDir = path.join(tmpHome, "plugins");

/**
 * A real plugin on disk, imported by the real loader and started by the real
 * supervisor.
 *
 * The claim is not that a context object exists — it is that a plugin's two
 * entry points are handed the *same* one. A watcher and a route holding
 * different contexts would be two plugins wearing one id: separate storage,
 * separate settings, and a `host` whose provenance no longer names one thing.
 */
const PROBE_SERVER = `
globalThis.__pluginContextProbe = { registrar: null, watcher: null, started: 0 };
export default function register(ctx) {
  globalThis.__pluginContextProbe.registrar = ctx;
  return { "GET /ping": (_req, res) => res.end("ok") };
}
export const watcher = {
  start(ctx) {
    globalThis.__pluginContextProbe.watcher = ctx;
    globalThis.__pluginContextProbe.started += 1;
  },
  stop() {},
};
`;

interface Probe {
  registrar: PluginServerContext | null;
  watcher: PluginServerContext | null;
  started: number;
}

function probe(): Probe {
  return (globalThis as unknown as { __pluginContextProbe: Probe }).__pluginContextProbe;
}

const config = { plugins: { enabled: ["probe"] } };

let reconcilePluginWatchers: typeof import("../watcher-supervisor.js").reconcilePluginWatchers;
let stopAllPluginWatchers: typeof import("../watcher-supervisor.js").stopAllPluginWatchers;

beforeAll(async () => {
  ({ reconcilePluginWatchers, stopAllPluginWatchers } = await import("../watcher-supervisor.js"));
});

beforeEach(() => {
  fs.rmSync(pluginsDir, { recursive: true, force: true });
  const dir = path.join(pluginsDir, "probe");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({ id: "probe", name: "Probe", version: "1.0.0", client: "client.mjs", server: "server.mjs" }),
  );
  fs.writeFileSync(path.join(dir, "client.mjs"), "export default { id: 'probe', register() {} }");
  fs.writeFileSync(path.join(dir, "server.mjs"), PROBE_SERVER);
});

afterEach(async () => {
  await stopAllPluginWatchers();
});

describe("the context a plugin's server module receives", () => {
  it("is one object, reaching the registrar and the watcher alike", async () => {
    await reconcilePluginWatchers(() => config);

    const { registrar, watcher, started } = probe();
    expect(started).toBe(1);
    expect(registrar).not.toBeNull();
    expect(watcher).toBe(registrar);
  });

  it("carries the typed host door, with every verb on it", async () => {
    await reconcilePluginWatchers(() => config);

    const host = probe().registrar?.host;
    expect(typeof host?.todos.list).toBe("function");
    expect(typeof host?.todos.create).toBe("function");
    expect(typeof host?.todos.comment).toBe("function");
    expect(typeof host?.sessions.spawn).toBe("function");
    expect(typeof host?.employees.list).toBe("function");
    expect(typeof host?.notify).toBe("function");
  });

  it("gives the watcher a host scoped to its own plugin", async () => {
    await reconcilePluginWatchers(() => config);

    const created = probe().watcher?.host.todos.create({ title: "minted from a watcher" });

    const store = await import("../../work-items/store.js");
    expect(store.getWorkItem(created!.id)?.createdBy).toBe("plugin:probe");
  });
});

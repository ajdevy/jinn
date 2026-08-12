import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// JINN_HOME before anything reaches paths.js, which reads it once. Starting the
// runtime pulls in the stores behind the typed host verbs, and they resolve their
// databases from it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-plugin-runtime-"));
process.env.JINN_HOME = tmpHome;

type Runtime = typeof import("../runtime.js");
type Host = typeof import("../host/index.js");

let runtime: Runtime;
let host: Host;

beforeAll(async () => {
  runtime = await import("../runtime.js");
  host = await import("../host/index.js");
});

// The host gateway is a module-level singleton every suite in this worker shares,
// so a runtime left running here would answer notices raised in another file.
afterAll(async () => {
  await runtime.stopPluginRuntime();
});

/** The only part of the gateway the notice path travels: the event emitter the
 *  dashboard's socket reads from. */
function gatewayApiContext(emit: ReturnType<typeof vi.fn>) {
  return { emit } as unknown as import("../../gateway/api.js").ApiContext;
}

/** No plugin is enabled, so reconciling starts no watcher and the runtime under
 *  test is exactly the gateway link. */
const noPlugins = () => ({ plugins: {} });

describe("startPluginRuntime", () => {
  it("puts a plugin's notice on the wire as the frame the dashboard listens for", async () => {
    const emit = vi.fn();
    await runtime.startPluginRuntime(gatewayApiContext(emit), noPlugins);

    host.createPluginHost("mailbox").notify("3 new messages", "warning");

    expect(emit).toHaveBeenCalledWith("plugin:notice", {
      pluginId: "mailbox",
      message: "3 new messages",
      level: "warning",
    });
  });

  /* The other half of what the runtime claims: releasing the link is what stops a
   * plugin that outlived shutdown from reaching a gateway that is gone. */
  it("leaves nothing to notify into once it has stopped", async () => {
    const emit = vi.fn();
    await runtime.startPluginRuntime(gatewayApiContext(emit), noPlugins);
    const plugin = host.createPluginHost("mailbox");
    plugin.notify("before shutdown");
    const emittedWhileRunning = emit.mock.calls.length;

    await runtime.stopPluginRuntime();
    plugin.notify("after shutdown");

    expect(emit.mock.calls.length).toBe(emittedWhileRunning);
  });
});

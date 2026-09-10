import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, Engine, EngineRunOpts, IncomingMessage, JinnConfig } from "../../shared/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-connector-attachment-"));
process.env.JINN_HOME = home;

// The route test exercises storage and dispatch only; keep unrelated PTY/native
// engine modules out of the fixture so it also runs on a minimal test host.
vi.mock("../../engines/codex.js", () => ({ removeCodexSessionHome: vi.fn() }));
vi.mock("../../engines/pty-snapshot.js", () => ({ ptySnapshotStore: { deleteSync: vi.fn() } }));
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

type Registry = typeof import("../registry.js");
type ManagerModule = typeof import("../manager.js");
type Paths = typeof import("../../shared/paths.js");
type Dispatch = typeof import("../../gateway/web-session-dispatch.js");

let registry: Registry;
let managerModule: ManagerModule;
let paths: Paths;
let dispatch: Dispatch;

function config(): JinnConfig {
  return {
    gateway: { host: "127.0.0.1", port: 7799 },
    engines: {
      default: "codex",
      codex: { bin: process.execPath, model: "model-alpha" },
    },
    models: {
      codex: { default: "model-alpha", models: [{ id: "model-alpha", label: "Alpha" }] },
    },
    connectors: {},
    logging: { file: false, stdout: false, level: "info" },
    sessions: {},
    mcp: {},
    portal: { setupComplete: true },
  } as unknown as JinnConfig;
}

function connector(): Connector {
  return {
    name: "telegram",
    id: "telegram",
    start: async () => {},
    stop: async () => {},
    getCapabilities: () => ({ threading: false, messageEdits: true, reactions: false, attachments: true }),
    getHealth: () => ({ status: "running", capabilities: { threading: false, messageEdits: true, reactions: false, attachments: true } }),
    reconstructTarget: () => ({ channel: "12345" }),
    sendMessage: async () => undefined,
    replyMessage: async () => undefined,
    addReaction: async () => {},
    removeReaction: async () => {},
    editMessage: async () => {},
    onMessage: () => {},
  };
}

beforeAll(async () => {
  registry = await import("../registry.js");
  managerModule = await import("../manager.js");
  paths = await import("../../shared/paths.js");
  dispatch = await import("../../gateway/web-session-dispatch.js");
  (await import("../../shared/db.js")).initDb();
});

beforeEach(async () => {
  (await import("../../shared/db.js")).initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions; DELETE FROM files;");
});

describe("connector attachment managed-file handoff", () => {
  it("registers a binary Telegram-style download and exposes only managed ID/path to turns", async () => {
    const source = path.join(paths.TMP_DIR, "telegram-download.bin");
    const bytes = Buffer.from([0, 17, 34, 255, 42, 99]);
    fs.mkdirSync(paths.TMP_DIR, { recursive: true });
    fs.writeFileSync(source, bytes);

    const runs: EngineRunOpts[] = [];
    const engine: Engine = {
      name: "codex",
      run: async (opts) => {
        runs.push(opts);
        return { sessionId: "codex-native", result: "received" };
      },
    };
    const manager = new managerModule.SessionManager(config(), new Map([["codex", engine]]), "attachment-test-boot");
    const incoming: IncomingMessage = {
      connector: "telegram",
      source: "telegram",
      sessionKey: "telegram:12345",
      replyContext: { chatId: 12345 },
      messageId: "77",
      channel: "12345",
      user: "tester",
      userId: "42",
      text: "Please inspect the file",
      attachments: [{ name: "sample.bin", url: source, mimeType: "application/octet-stream", localPath: source }],
      raw: { message_id: 77 },
    };

    await manager.route(incoming, connector());

    expect(runs).toHaveLength(1);
    expect(runs[0].prompt).toBe("Please inspect the file");
    expect(runs[0].prompt).not.toContain(bytes.toString("base64"));

    const [managed] = registry.listFiles();
    expect(managed).toMatchObject({ filename: "sample.bin", size: bytes.length, mimetype: "application/octet-stream" });
    expect(managed.path).toBe(path.join(paths.FILES_DIR, managed.id, "sample.bin"));
    expect(fs.readFileSync(managed.path!)).toEqual(bytes);
    expect(fs.existsSync(source)).toBe(false);

    // The exact ID is what delegation accepts; its resolver yields the same
    // durable path used by the originating connector turn.
    expect(dispatch.resolveAttachmentPaths([managed.id])).toEqual([managed.path]);
    expect(runs[0].attachments).toEqual([managed.path]);
    expect(registry.getMessages(registry.listSessions()[0].id)[0]?.media).toMatchObject([
      { url: `/api/files/${managed.id}`, name: "sample.bin", size: bytes.length },
    ]);
  });
});

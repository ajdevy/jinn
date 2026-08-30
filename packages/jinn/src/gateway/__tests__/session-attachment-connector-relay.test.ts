import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { Connector, OutboundDocument, Target } from "../../shared/types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-att-relay-"));
process.env.JINN_HOME = tmp;

type Files = typeof import("../files.js");
let files: Files;

const sendDocument = vi.fn<(t: Target, d: OutboundDocument) => Promise<string>>().mockResolvedValue("m-1");

const telegram = {
  name: "telegram",
  id: "telegram",
  reconstructTarget: (rc: unknown) => ({ channel: String((rc as { chatId?: string }).chatId ?? "") }),
  sendDocument,
} as unknown as Connector;

beforeAll(async () => {
  files = await import("../files.js");
  const db = (await import("../../shared/db.js")).initDb();
  // A session that arrived over Telegram: it has a connector and a reply context,
  // which is exactly what a web-sourced session lacks.
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, connector, reply_context, status, created_at, last_activity)
     VALUES ('sess-tg','claude','telegram','telegram:99','telegram','{"chatId":"99"}','idle','t','t')`,
  ).run();
  db.prepare(
    "INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity) VALUES ('sess-web','claude','web','web:1','idle','t','t')",
  ).run();
});

function fakeReq(body: string): import("node:http").IncomingMessage {
  const r = Readable.from([Buffer.from(body)]) as unknown as import("node:http").IncomingMessage;
  (r as unknown as { headers: Record<string, string> }).headers = {
    "content-type": "application/json",
    authorization: "Bearer test-token",
  };
  return r;
}

function fakeRes() {
  const out: { status?: number; body?: string } = {};
  const res = {
    writeHead(status: number) { out.status = status; return res; },
    end(body?: string) { out.body = body; return res; },
  } as unknown as import("node:http").ServerResponse;
  return { res, out };
}

function fakeContext() {
  return {
    emit: () => {},
    getConfig: () => ({}),
    gatewayAuthToken: "test-token",
    jinnHome: tmp,
    connectors: new Map<string, Connector>([["telegram", telegram]]),
  } as unknown as import("../api.js").ApiContext;
}

async function attach(sessionId: string, name: string, text: string) {
  const src = path.join(tmp, name);
  fs.writeFileSync(src, Buffer.from("REPORT"));
  const { res, out } = fakeRes();
  await files.handleSessionAttachment(fakeReq(JSON.stringify({ path: src, text })), res, sessionId, fakeContext());
  return out;
}

describe("publish_attachment reaches the originating chat", () => {
  it("hands the stored file to the connector the session came from", async () => {
    sendDocument.mockClear();
    const out = await attach("sess-tg", "report.md", "the report");

    expect(out.status).toBe(201);
    expect(sendDocument).toHaveBeenCalledTimes(1);
    const [target, doc] = sendDocument.mock.calls[0];
    expect(target).toEqual({ channel: "99" });
    expect(doc.filename).toBe("report.md");
    expect(doc.caption).toBe("the report");
    // The relayed path is the stored copy, not the agent's source file.
    expect(doc.path).toBe(JSON.parse(out.body!).path);
    expect(fs.existsSync(doc.path)).toBe(true);
  });

  it("does not relay a web session's attachment into any chat", async () => {
    sendDocument.mockClear();
    const out = await attach("sess-web", "web-only.md", "dashboard only");

    expect(out.status).toBe(201);
    expect(sendDocument).not.toHaveBeenCalled();
  });

  it("still stores the file and answers 201 when the chat send fails", async () => {
    sendDocument.mockClear();
    sendDocument.mockRejectedValueOnce(new Error("429 Too Many Requests"));
    const out = await attach("sess-tg", "retry.md", "after a failure");

    expect(out.status).toBe(201);
    expect(fs.existsSync(JSON.parse(out.body!).path)).toBe(true);
  });
});

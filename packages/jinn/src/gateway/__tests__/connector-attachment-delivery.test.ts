import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Connector, OutboundDocument, Session } from "../../shared/types.js";

const warn = vi.fn();
const info = vi.fn();
vi.mock("../../shared/logger.js", () => ({
  logger: { info, warn, debug: vi.fn(), error: vi.fn() },
}));

const { deliverConnectorAttachment } = await import("../connector-reply.js");

const DOC: OutboundDocument = {
  path: "/var/lib/jinn/uploads/report.md",
  filename: "report.md",
  mimetype: "text/markdown",
  caption: "here is the report",
};

type TestSession = Pick<Session, "source" | "connector" | "replyContext"> & { id?: string };

function session(over: Partial<TestSession> = {}): TestSession {
  return { id: "sess-1", source: "telegram", connector: "telegram", replyContext: { chatId: "42" }, ...over };
}

function connector(over: Partial<Connector> = {}): Connector {
  return {
    name: "telegram",
    id: "telegram",
    reconstructTarget: (rc: unknown) => ({ channel: String((rc as { chatId?: string }).chatId ?? "") }),
    sendDocument: vi.fn().mockResolvedValue("777"),
    ...over,
  } as unknown as Connector;
}

beforeEach(() => vi.clearAllMocks());

describe("deliverConnectorAttachment", () => {
  it("sends the document to the channel the session came from", async () => {
    const tg = connector();
    await deliverConnectorAttachment(session(), DOC, new Map([["telegram", tg]]));
    expect(tg.sendDocument).toHaveBeenCalledWith({ channel: "42" }, DOC);
  });

  it.each(["web", "talk", "cron"])("does not send for a %s session", async (source) => {
    const tg = connector();
    await deliverConnectorAttachment(session({ source }), DOC, new Map([["telegram", tg]]));
    expect(tg.sendDocument).not.toHaveBeenCalled();
  });

  it("does not send when the session carries no reply context", async () => {
    const tg = connector();
    await deliverConnectorAttachment(session({ replyContext: null }), DOC, new Map([["telegram", tg]]));
    expect(tg.sendDocument).not.toHaveBeenCalled();
  });

  it("stays web-only, without throwing, for a connector that cannot send documents", async () => {
    const slack = connector({ id: "slack", sendDocument: undefined });
    await expect(
      deliverConnectorAttachment(session({ connector: "slack" }), DOC, new Map([["slack", slack]])),
    ).resolves.toBeUndefined();
  });

  it("swallows a send failure so a stored file never fails its request", async () => {
    const tg = connector({ sendDocument: vi.fn().mockRejectedValue(new Error("413 file too big")) });
    await expect(
      deliverConnectorAttachment(session(), DOC, new Map([["telegram", tg]])),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("413 file too big"));
  });

  it("warns when the session names a connector that is not registered", async () => {
    await deliverConnectorAttachment(session({ connector: "ghost" }), DOC, new Map());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no connector registered as "ghost"'));
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";

const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-telegram-stt-models-"));
process.env.JINN_STT_MODELS_DIR = modelsDir;

const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
const mockGetMe = vi.fn().mockResolvedValue({ id: 999, username: "test_bot" });
const mockStartPolling = vi.fn();
const mockOn = vi.fn();
const mockDownloadFile = vi.fn();
const mockClaimTelegramInbound = vi.fn().mockReturnValue(true);
const mockCompleteTelegramInbound = vi.fn().mockReturnValue(true);
const mockReleaseTelegramInbound = vi.fn().mockReturnValue(true);
const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: spawnMock,
  execFile: execFileMock,
}));

vi.mock("node-telegram-bot-api", () => {
  const MockBot = vi.fn(function (this: any) {
    this.sendMessage = mockSendMessage;
    this.getMe = mockGetMe;
    this.startPolling = mockStartPolling;
    this.stopPolling = vi.fn().mockResolvedValue(undefined);
    this.on = mockOn;
    this.downloadFile = mockDownloadFile;
  });
  return { default: MockBot };
});

vi.mock("../../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../sessions/telegram-inbound-dedupe.js", () => ({
  claimTelegramInbound: mockClaimTelegramInbound,
  completeTelegramInbound: mockCompleteTelegramInbound,
  releaseTelegramInbound: mockReleaseTelegramInbound,
  telegramInboundDedupeKey: (botId: number, chatId: number, messageId: number) =>
    `telegram:${botId}:${chatId}:${messageId}`,
}));

const { TelegramConnector } = await import("../index.js");
const { downloadModel, getSttStatus } = await import("../../../stt/stt.js");

afterAll(() => {
  fs.rmSync(modelsDir, { recursive: true, force: true });
});

describe("Telegram voice STT runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.rmSync(modelsDir, { recursive: true, force: true });
    fs.mkdirSync(modelsDir, { recursive: true });
  });

  it("rejects a corrupt model, then transcribes after the normal model download", async () => {
    const corruptModel = path.join(modelsDir, "ggml-small.bin");
    fs.writeFileSync(corruptModel, "truncated!!!");

    const connector = new TelegramConnector({
      botToken: "test-token",
      stt: { enabled: true, model: "small", languages: ["en"] },
    });
    const handler = vi.fn();
    connector.onMessage(handler);
    await connector.start();
    const messageCallback = mockOn.mock.calls.find((call) => call[0] === "message")?.[1];

    expect(getSttStatus("small").available).toBe(false);
    await messageCallback({
      message_id: 1,
      chat: { id: 12345, type: "private" as const },
      from: { id: 67890, username: "voice_user", is_bot: false },
      date: Math.floor(Date.now() / 1000) + 10,
      voice: { file_id: "voice-1", duration: 2 },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining("STT model 'small' is not downloaded"),
    );

    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const child = new EventEmitter();
      const partialPath = args[args.indexOf("-o") + 1]!;
      fs.mkdirSync(path.dirname(partialPath), { recursive: true });
      fs.writeFileSync(partialPath, "model");
      fs.truncateSync(partialPath, 466_000_000);
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });
    await downloadModel("small", () => undefined);
    expect(getSttStatus("small").available).toBe(true);

    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: null, result: { stdout: string; stderr: string }) => void;
      callback(null, { stdout: "recognized voice", stderr: "" });
    });
    mockDownloadFile.mockResolvedValue(path.join(modelsDir, "incoming.wav"));

    await messageCallback({
      message_id: 2,
      chat: { id: 12345, type: "private" as const },
      from: { id: 67890, username: "voice_user", is_bot: false },
      date: Math.floor(Date.now() / 1000) + 10,
      voice: { file_id: "voice-2", duration: 2 },
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].text).toContain("recognized voice");
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });
});

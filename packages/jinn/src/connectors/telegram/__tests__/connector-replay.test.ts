import fs from "node:fs"
import { describe, expect, it, vi, beforeEach } from "vitest"
import type { IncomingMessage, JinnConfig, Session } from "../../../shared/types.js"
import { createConnectorTurnSurface } from "../../../sessions/turn/connector-surface.js"

const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 1 })
const mockGetMe = vi.fn().mockResolvedValue({ id: 999, username: "test_bot" })
const mockStartPolling = vi.fn()
const mockStopPolling = vi.fn().mockResolvedValue(undefined)
const mockOn = vi.fn()
const mockSendDocument = vi.fn().mockResolvedValue({ message_id: 7 })
const mockDownloadFile = vi.fn()
const mockBotOptions = vi.fn()
const mockClaimTelegramInbound = vi.fn().mockReturnValue(true)
const mockCompleteTelegramInbound = vi.fn().mockReturnValue(true)
const mockReleaseTelegramInbound = vi.fn().mockReturnValue(true)

vi.mock("node-telegram-bot-api", () => {
  const MockBot = vi.fn(function (this: any, _token: string, options: unknown) {
    mockBotOptions(options)
    this.sendMessage = mockSendMessage
    this.getMe = mockGetMe
    this.startPolling = mockStartPolling
    this.stopPolling = mockStopPolling
    this.on = mockOn
    this.sendDocument = mockSendDocument
    this.downloadFile = mockDownloadFile
  })
  return { default: MockBot }
})

vi.mock("../../../shared/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock("../../../sessions/telegram-inbound-dedupe.js", () => ({
  claimTelegramInbound: mockClaimTelegramInbound,
  completeTelegramInbound: mockCompleteTelegramInbound,
  releaseTelegramInbound: mockReleaseTelegramInbound,
  telegramInboundDedupeKey: (botId: number, chatId: number, messageId: number) => `telegram:${botId}:${chatId}:${messageId}`,
}))

const { TelegramConnector } = await import("../index.js")

describe("Telegram connector delivery and reply context", () => {
  let connector: InstanceType<typeof TelegramConnector>

  beforeEach(() => {
    vi.clearAllMocks()
    connector = new TelegramConnector({ botToken: "123456:ABC-DEF" })
  })

  it("disables provider retries that can duplicate an accepted send", () => {
    expect(mockBotOptions).toHaveBeenCalledWith({ polling: false, request: { maxRetriesOn429: 0 } })
  })

  it("adds reply context without creating a second turn or losing current media", async () => {
    const handler = vi.fn()
    connector.onMessage(handler)
    await connector.start()
    const messageCallback = mockOn.mock.calls.find((call) => call[0] === "message")?.[1]
    const renameSync = vi.spyOn(fs, "renameSync").mockImplementation(() => undefined)
    mockDownloadFile.mockResolvedValueOnce("/tmp/downloaded-note.pdf")
    const telegramMsg = {
      message_id: 50,
      chat: { id: 12345, type: "private" as const },
      from: { id: 67890, username: "new_author", first_name: "New", is_bot: false },
      date: Math.floor(Date.now() / 1000) + 10,
      text: "Answer the quoted question",
      document: { file_id: "file-1", file_name: "note.pdf", mime_type: "application/pdf" },
      reply_to_message: {
        message_id: 49,
        chat: { id: 12345, type: "private" as const },
        from: { id: 7, username: "quoted_author", first_name: "Quoted" },
        text: "Quoted question",
      },
    }
    try {
      await messageCallback(telegramMsg)
    } finally {
      renameSync.mockRestore()
    }
    expect(handler).toHaveBeenCalledOnce()
    const incoming: IncomingMessage = handler.mock.calls[0][0]
    expect(incoming.text).toContain("author: @quoted_author")
    expect(incoming.text).toContain("message_id: 49")
    expect(incoming.text).toContain("quoted_text:\nQuoted question")
    expect(incoming.text).toContain("<telegram-user-message>\nAnswer the quoted question")
    expect(incoming.attachments).toEqual([expect.objectContaining({ name: "note.pdf", mimeType: "application/pdf", localPath: expect.any(String) })])
    expect(incoming.raw).toBe(telegramMsg)
    expect(incoming.replyContext).toEqual({ chatId: 12345, messageId: 50 })
    expect(connector.reconstructTarget(incoming.replyContext)).toMatchObject({ channel: "12345", messageTs: "50", replyContext: incoming.replyContext })
  })

  it("does not resend a terminal reply when the delivery callback is replayed three times", async () => {
    const surface = createConnectorTurnSurface({ connector, target: { channel: "12345" }, session: { id: "telegram-replay-session", attemptToken: "telegram-attempt-1" } as Session, config: {} as JinnConfig, decorate: false })
    await Promise.all([surface.reply("Reply once"), surface.reply("Reply once"), surface.reply("Reply once")])
    expect(mockSendMessage).toHaveBeenCalledOnce()
  })
})

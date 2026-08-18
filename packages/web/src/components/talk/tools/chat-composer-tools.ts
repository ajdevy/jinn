import { activeChatComposerControl, type ComposerCommand } from "@/components/chat/chat-composer-control"
import { getPageContext } from "../context/page-context-store"
import { params, str, type TalkTool, type ToolArgs, type ToolResult } from "./tool-spec"

const MESSAGE_LIMIT = 8_000

function messageProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "Say what the chat draft should contain."
  return value.trim().length > MESSAGE_LIMIT
    ? `Keep the chat draft to ${MESSAGE_LIMIT} characters or fewer.`
    : null
}

function currentChatId(): string | null {
  const selection = getPageContext().selection
  return selection?.kind === "chat session" && selection.id.trim() ? selection.id.trim() : null
}

async function run(command: ComposerCommand): Promise<ToolResult> {
  const sessionId = currentChatId()
  if (!sessionId) return { ok: false, error: "Open an existing chat before changing its draft." }
  const composer = activeChatComposerControl()
  if (!composer || composer.sessionId !== sessionId || !composer.isVisible()) {
    return { ok: false, error: "The selected chat composer is not visible yet." }
  }
  const result = await composer.execute(command)
  if (!result.ok) return result
  return { ok: true, data: { performed: command.type, characters: result.characters } }
}

function textCommand(type: "draft" | "replace" | "draft-and-send", args: ToolArgs): ToolResult | Promise<ToolResult> {
  const problem = messageProblem(args.message)
  if (problem) return { ok: false, error: problem }
  return run({ type, message: String(args.message).trim() })
}

const message = str(`The reply text, at most ${MESSAGE_LIMIT} characters.`)

export const CHAT_COMPOSER_TOOLS: readonly TalkTool[] = [
  {
    name: "talk_draft_reply",
    description: "Fill the empty composer in the chat currently on screen. This only drafts; it never sends.",
    exposure: "always",
    parameters: params({ message }, ["message"]),
    execute: (args) => textCommand("draft", args),
  },
  {
    name: "talk_replace_draft",
    description: "Replace the existing visible chat draft. This only edits; it never sends.",
    exposure: "always",
    parameters: params({ message }, ["message"]),
    execute: (args) => textCommand("replace", args),
  },
  {
    name: "talk_send_draft",
    description: "Send exactly the text currently visible in the selected chat composer, once and without another confirmation.",
    exposure: "always",
    parameters: params({}),
    execute: () => run({ type: "send" }),
  },
  {
    name: "talk_draft_and_send",
    description: "Atomically draft and send one reply in the chat currently on screen. Use for an explicit 'draft and send' request.",
    exposure: "always",
    parameters: params({ message }, ["message"]),
    execute: (args) => textCommand("draft-and-send", args),
  },
]


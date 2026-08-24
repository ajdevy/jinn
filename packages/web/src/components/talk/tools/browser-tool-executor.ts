import { FOCUS_ELEMENT_TOOL } from "./focus-element"
import { CHAT_MESSAGE_SEARCH_TOOL } from "./chat-message-search"
import { CHAT_COMPOSER_TOOLS } from "./chat-composer-tools"
import { NAVIGATE_TOOLS } from "./navigate-tools"
import { RESOLVE_TOOLS } from "./resolve-tools"
import { type TalkTool, type ToolResult } from "./tool-spec"
import { parseToolArgs } from "./validate-args"

/**
 * The browser-only catalog that can enter the live orb transport. Legacy
 * situation/consent tools remain available to their isolated harnesses, but
 * importing this lane cannot pull a sheet, preview, or undo surface into Talk.
 *
 * `talk_send_to_session` is deliberately absent: the gateway owns it, where the
 * send is durably claimed, really dispatched, and re-read. The consent twin
 * here only ever drafted and asked.
 */
const BROWSER_TOOLS: readonly TalkTool[] = [
  ...NAVIGATE_TOOLS,
  ...RESOLVE_TOOLS,
  FOCUS_ELEMENT_TOOL,
  CHAT_MESSAGE_SEARCH_TOOL,
  ...CHAT_COMPOSER_TOOLS,
]

const BY_NAME = new Map(BROWSER_TOOLS.map((tool) => [tool.name, tool]))

export async function executeBrowserToolCall(name: string, argsJson?: string): Promise<ToolResult> {
  const tool = BY_NAME.get(name)
  // Compatibility for pre-manifest fixtures and old gateways. Canonical
  // browser operations are all explicit above; only legacy names fall back.
  if (!tool) return (await import("./registry")).executeToolCall(name, argsJson)
  const parsed = parseToolArgs(name, tool.parameters, argsJson)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  try {
    return await tool.execute(parsed.args)
  } catch (error) {
    return { ok: false, error: `"${name}" failed: ${error instanceof Error ? error.message : String(error)}.` }
  }
}

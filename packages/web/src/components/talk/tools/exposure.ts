import { TALK_TOOLS } from "./registry"
import { toolDefinition, type TalkTool, type ToolDefinition, type ToolExposure } from "./tool-spec"

/**
 * The progressive-exposure split, exported as data.
 *
 * A voice session pays for its tool list in every turn, so only the tools the
 * operator reaches for without preamble stay resident. The always-on set is
 * small enough to name: the Todo board, one Todo, chat, reading a Todo, and
 * focusing something on screen. Everything else — workflows, experiments, org,
 * cron, sessions, and the catch-all — loads once the conversation is about it.
 *
 * The transport consumes this rather than re-deriving it, so there is one place
 * the split is decided and one place to change it.
 */

export const TOOL_EXPOSURE: Readonly<Record<string, ToolExposure>> = Object.freeze(
  Object.fromEntries(TALK_TOOLS.map((tool) => [tool.name, tool.exposure])),
)

export function toolsWithExposure(exposure: ToolExposure): TalkTool[] {
  return TALK_TOOLS.filter((tool) => tool.exposure === exposure)
}

/** The resident tool list a session opens with. */
export function alwaysOnDefinitions(): ToolDefinition[] {
  return toolsWithExposure("always").map(toolDefinition)
}

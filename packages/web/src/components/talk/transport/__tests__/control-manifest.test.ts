import { describe, expect, it } from "vitest"
import { findTool } from "../../tools/registry"
import { functionTools, parseTalkControlManifest, type TalkControlManifest } from "../control-manifest"

const operation: TalkControlManifest["operations"][number] = {
  name: "open_todo",
  description: "Open one Todo.",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  target: "browser",
  exposure: "always",
  intent: "todos",
  mutability: "effect",
  operatorOnly: false,
  verification: "browser-receipt",
}

describe("the browser's gateway-issued Talk manifest", () => {
  it("rejects malformed versions and duplicate names", () => {
    expect(parseTalkControlManifest({ version: 2, operations: [operation] })).toBeNull()
    expect(parseTalkControlManifest({ version: 1, operations: [operation, operation] })).toBeNull()
  })

  it("turns declarations into provider functions without losing their schema", () => {
    const manifest = parseTalkControlManifest({ version: 1, operations: [operation] })!
    expect(functionTools(manifest)).toEqual([{ type: "function", name: "open_todo", description: operation.description, parameters: operation.parameters }])
    expect(findTool(operation.name)).toBeDefined()
  })

  it("has a registered browser executor for on-demand chat search", () => {
    const search = {
      ...operation,
      name: "talk_search_chat_messages",
      target: "browser" as const,
      mutability: "read" as const,
      parameters: {
        type: "object" as const,
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false as const,
      },
    }
    const manifest = parseTalkControlManifest({ version: 1, operations: [search] })!

    expect(functionTools(manifest)[0]?.name).toBe("talk_search_chat_messages")
    expect(findTool("talk_search_chat_messages")).toBeDefined()
  })
})

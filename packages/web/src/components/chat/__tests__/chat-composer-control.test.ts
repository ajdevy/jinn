import { describe, expect, it } from "vitest"
import {
  activeChatComposerControl,
  registerChatComposerControl,
  type ChatComposerControl,
} from "../chat-composer-control"

function control(sessionId: string, isActive = () => true): ChatComposerControl {
  return {
    sessionId,
    isActive,
    isVisible: () => true,
    execute: () => ({ ok: true, characters: 0 }),
  }
}

describe("the mounted composer control", () => {
  it("makes stale cleanup generation-safe", () => {
    const cleanA = registerChatComposerControl(control("A"))
    const cleanB = registerChatComposerControl(control("B"))

    cleanA()
    expect(activeChatComposerControl()?.sessionId).toBe("B")
    cleanB()
    expect(activeChatComposerControl()).toBeNull()
  })

  it("selects the focused composer instead of the last mounted pane", () => {
    let focused = "A"
    const cleanA = registerChatComposerControl(control("A", () => focused === "A"))
    const cleanB = registerChatComposerControl(control("B", () => focused === "B"))

    expect(activeChatComposerControl()?.sessionId).toBe("A")
    focused = "B"
    expect(activeChatComposerControl()?.sessionId).toBe("B")

    cleanB()
    cleanA()
  })
})

import { describe, expect, it } from "vitest"
import {
  activeChatComposerControl,
  registerChatComposerControl,
  type ChatComposerControl,
} from "../chat-composer-control"

function control(sessionId: string): ChatComposerControl {
  return {
    sessionId,
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
})


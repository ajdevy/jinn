import { describe, expect, it } from "vitest"
import { emptyTalkUsage, usageDelta } from "../usage-delta"

const READING = {
  inputAudioTokens: 900,
  outputAudioTokens: 400,
  inputTextTokens: 120,
  outputTextTokens: 30,
  cachedInputAudioTokens: 600,
  cachedInputTextTokens: 80,
  inputImageTokens: 765,
  cachedInputImageTokens: 100,
}

describe("usageDelta", () => {
  it("hands back the first reading whole, because nothing has been billed yet", () => {
    expect(usageDelta(emptyTalkUsage(), READING)).toEqual(READING)
  })

  it("bills only what the second reading added to the first", () => {
    const later = { ...READING, inputAudioTokens: 1500, outputAudioTokens: 650, cachedInputAudioTokens: 1100, inputImageTokens: 1530 }

    expect(usageDelta(READING, later)).toEqual({
      inputAudioTokens: 600,
      outputAudioTokens: 250,
      inputTextTokens: 0,
      outputTextTokens: 0,
      cachedInputAudioTokens: 500,
      cachedInputTextTokens: 0,
      inputImageTokens: 765,
      cachedInputImageTokens: 0,
    })
  })

  it("clamps a count that came back lower, which the gateway would reject outright", () => {
    const reset = { ...emptyTalkUsage(), inputAudioTokens: 10 }

    expect(usageDelta(READING, reset)).toEqual({ ...emptyTalkUsage(), inputAudioTokens: 0 })
  })
})

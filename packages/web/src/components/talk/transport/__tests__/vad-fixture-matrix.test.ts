import { describe, expect, it } from "vitest"
import type { InterruptionTelemetry } from "../false-start-recovery"
import { createTalkDriver } from "../session-driver"
import { browserControlFixture } from "./control-fixture"
import { VAD_FIXTURES, type ScriptedProviderEvent, type VadFixtureDisposition } from "./vad-fixtures"

interface FixtureResult {
  disposition: VadFixtureDisposition
  clientCancels: Array<Record<string, unknown>>
  normalResponses: Array<Record<string, unknown>>
  continuationResponses: Array<Record<string, unknown>>
  normalResponseAt: string[]
  interruptions: InterruptionTelemetry[]
}

function isContinuation(frame: Record<string, unknown>): boolean {
  if (frame.type !== "response.create") return false
  const response = frame.response
  return Boolean(response && typeof response === "object" && "instructions" in response)
}

function disposition(
  interruptions: InterruptionTelemetry[],
  continuationResponses: Array<Record<string, unknown>>,
): VadFixtureDisposition {
  if (interruptions.some((event) => !event.recovered)) return "interrupted"
  return continuationResponses.length > 0 ? "recovered" : "playing"
}

function replay(events: readonly ScriptedProviderEvent[]): FixtureResult {
  const sent: Array<Record<string, unknown>> = []
  const normalResponseAt: string[] = []
  const interruptions: InterruptionTelemetry[] = []
  const driver = createTalkDriver({
    sessionId: "talk-synthetic-fixture",
    manifest: browserControlFixture(),
    send: (frame) => { sent.push(frame) },
    onState: () => {},
    onError: () => {},
    onInterruption: (event) => { interruptions.push(event) },
  })

  for (const event of events) {
    const before = sent.length
    driver.receive(JSON.stringify(event.frame))
    const emitted = sent.slice(before)
    if (emitted.some((frame) => frame.type === "response.create" && !isContinuation(frame))) {
      normalResponseAt.push(event.label)
    }
  }

  const clientCancels = sent.filter((frame) => frame.type === "response.cancel")
  const continuationResponses = sent.filter(isContinuation)
  const normalResponses = sent.filter((frame) => frame.type === "response.create" && !isContinuation(frame))
  return {
    disposition: disposition(interruptions, continuationResponses),
    clientCancels,
    normalResponses,
    continuationResponses,
    normalResponseAt,
    interruptions,
  }
}

describe("scripted provider VAD fixture matrix", () => {
  it.each(VAD_FIXTURES)("handles $id through the real parser and driver", (fixture) => {
    const result = replay(fixture.events)
    const finalized = result.interruptions.filter((event) => !event.recovered)

    expect(result.clientCancels).toHaveLength(fixture.expected.clientCancels)
    expect(result.normalResponses).toHaveLength(fixture.expected.normalResponses)
    expect(result.continuationResponses).toHaveLength(fixture.expected.continuationResponses)
    expect(finalized).toHaveLength(fixture.expected.finalizedInterruptions)
    expect(result.interruptions).toEqual(fixture.expected.telemetry)
    expect(result.disposition).toBe(fixture.expected.disposition)
    expect(result.normalResponseAt).toEqual(
      fixture.expected.normalResponseAt ? [fixture.expected.normalResponseAt] : [],
    )
  })

  it("finalizes deliberate speech on the meaningful transcript frame without waiting another tick", () => {
    const fixture = VAD_FIXTURES.find(({ id }) => id === "deliberate-interruption")!
    const result = replay(fixture.events)

    expect(result.normalResponseAt).toEqual(["meaningful-transcript"])
    expect(result.normalResponses).toHaveLength(1)
    expect(result.continuationResponses).toHaveLength(0)
  })
})

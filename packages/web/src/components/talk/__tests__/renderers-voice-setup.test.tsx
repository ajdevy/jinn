import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SituationPayload } from "../situation-payload"
import { VoiceSetupSituation, voiceSetupSpeech } from "../renderers/voice-setup"

const updateConfig = vi.fn()
vi.mock("@/lib/api", () => ({ api: { updateConfig: (...args: unknown[]) => updateConfig(...args) } }))

const PAYLOAD: Extract<SituationPayload, { kind: "voice-setup" }> = {
  kind: "voice-setup",
  providers: ["openai"],
}

function setup(onAnswer = vi.fn()) {
  render(<VoiceSetupSituation payload={PAYLOAD} onAnswer={onAnswer} />)
  return {
    onAnswer,
    provider: screen.getByRole("combobox", { name: "Voice provider" }),
    key: screen.getByLabelText("Voice API key"),
    save: screen.getByRole("button", { name: /save/i }),
  }
}

beforeEach(() => {
  updateConfig.mockReset()
  updateConfig.mockResolvedValue({})
})

describe("the voice setup card", () => {
  it("offers exactly the providers the gateway said it implements", () => {
    setup()

    const options = screen.getAllByRole("option").map((option) => option.textContent)
    expect(options).toEqual(["openai"])
  })

  it("writes the realtime block and answers so the orb can try again", async () => {
    const { key, save, onAnswer } = setup()

    fireEvent.change(key, { target: { value: "  sk-account-key  " } })
    fireEvent.click(save)

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ realtime: { provider: "openai", apiKey: "sk-account-key" } }),
    )
    expect(onAnswer).toHaveBeenCalledWith("saved")
  })

  it("takes an environment reference in place of a key", async () => {
    const { key, save } = setup()

    fireEvent.change(key, { target: { value: "${OPENAI_API_KEY}" } })
    fireEvent.click(save)

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ realtime: { provider: "openai", apiKey: "${OPENAI_API_KEY}" } }),
    )
  })

  it("will not save an empty key, so a save cannot clear a working one", () => {
    const { key, save } = setup()

    expect((save as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(key, { target: { value: "   " } })
    expect((save as HTMLButtonElement).disabled).toBe(true)
  })

  it("keeps the operator on the card when the save is refused, and says why", async () => {
    updateConfig.mockRejectedValue(new Error("Unknown config keys: realtime"))
    const { key, save, onAnswer } = setup()

    fireEvent.change(key, { target: { value: "sk-account-key" } })
    fireEvent.click(save)

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Unknown config keys: realtime")
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it("puts the key down the wire and never back on the screen", async () => {
    const { key, save } = setup()

    fireEvent.change(key, { target: { value: "sk-account-key" } })
    fireEvent.click(save)
    await waitFor(() => expect(updateConfig).toHaveBeenCalled())

    // The field holds what was typed; nothing else in the card repeats it, and
    // the field itself is masked.
    expect(key.getAttribute("type")).toBe("password")
    expect(document.body.textContent).not.toContain("sk-account-key")
  })

  it("puts the operator down without saving anything", () => {
    const { onAnswer } = setup()

    fireEvent.click(screen.getByRole("button", { name: "Not now" }))

    expect(updateConfig).not.toHaveBeenCalled()
    expect(onAnswer).toHaveBeenCalledWith("not-now")
  })

  it("speaks the providers it was given rather than a fixed line", () => {
    expect(voiceSetupSpeech(PAYLOAD)).toContain("openai")
  })
})

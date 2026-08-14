import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearTalkActions, talkActions } from "../../talk-action-log"
import { answerSituation, askSituation, currentSituation, dismissSituation } from "../../talk-situation-store"
import { FOCUS_HIGHLIGHT_CLASS } from "../focus-element"
import { executeToolCall } from "../registry"

vi.mock("@/lib/api", () => ({ api: {} }))

/** A page with nothing the orb has a dedicated tool for, plus the orb's own
 *  surface rendered exactly as its components mark it. */
function page(): void {
  document.body.innerHTML = `
    <main>
      <button id="save">Save changes</button>
      <button id="discard">Discard</button>
      <input id="name" placeholder="Vendor name" />
      <input id="secret" type="password" placeholder="Password" />
      <p id="note">Nothing happened yet</p>
      <button id="hidden-one" hidden>Discard</button>
    </main>
    <div data-situation-phase="open">
      <aside data-situation-sheet="consent-1"><button id="sheet-go">Leave it</button></aside>
    </div>
    <div data-talk-undo-strip><button data-talk-undo id="undo">Undo</button></div>
    <div data-talk-orb-overlay><button data-talk-orb id="orb" aria-label="End voice session"></button></div>
  `
}

function clicked(id: string): string[] {
  const seen: string[] = []
  document.getElementById(id)!.addEventListener("click", () => seen.push(id))
  return seen
}

/** Every generic action, with a call that would land if it were allowed to. */
const GENERIC: Array<{ tool: string; args: string }> = [
  { tool: "click_by_text", args: '{"text":"Save changes"}' },
  { tool: "type_into", args: '{"field":"Vendor name","text":"Acme"}' },
  { tool: "find_element_by_text", args: '{"text":"Nothing happened yet"}' },
  { tool: "scroll_to", args: '{"text":"Nothing happened yet"}' },
]

/** What the page looks like, so "nothing was performed" can be asserted as a
 *  whole rather than one effect at a time. */
function pageState(): string {
  const value = (document.getElementById("name") as HTMLInputElement).value
  const marked = document.getElementsByClassName(FOCUS_HIGHLIGHT_CLASS).length
  return `${value}|${marked}`
}

beforeEach(() => {
  page()
  clearTalkActions()
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  dismissSituation()
  document.body.innerHTML = ""
})

describe("no generic action happens before the operator answers", () => {
  it.each(GENERIC)("$tool waits for the sheet rather than acting on the model's word", async ({ tool, args }) => {
    const saves = clicked("save")
    const before = pageState()
    const pending = executeToolCall(tool, args)

    await vi.waitFor(() => expect(currentSituation()).not.toBeNull())
    expect(saves).toEqual([])
    expect(pageState()).toBe(before)

    answerSituation("go")
    expect(await pending).toMatchObject({ ok: true })
  })

  it.each(GENERIC)("$tool does nothing at all when the operator waves it off", async ({ tool, args }) => {
    const saves = clicked("save")
    const before = pageState()
    const pending = executeToolCall(tool, args)

    await vi.waitFor(() => expect(currentSituation()).not.toBeNull())
    dismissSituation()
    const result = await pending

    expect(saves).toEqual([])
    expect(pageState()).toBe(before)
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Refused") })
  })

  it.each(GENERIC)("$tool records one entry for the attempt, in the consent lane", async ({ tool, args }) => {
    const pending = executeToolCall(tool, args)
    await vi.waitFor(() => expect(currentSituation()).not.toBeNull())
    answerSituation("go")
    await pending

    expect(talkActions()).toEqual([expect.objectContaining({ tool, lane: "consent", consent: "granted" })])
  })
})

describe("the orb cannot be driven by the orb", () => {
  it.each([
    { what: "the situation sheet's own card", text: "Leave it" },
    { what: "the undo strip", text: "Undo" },
    { what: "the orb", text: "End voice session" },
  ])("refuses to reach $what", async ({ text }) => {
    // Asked with no situation up, so the refusal is about WHERE the element is
    // and not about the sheet being busy.
    const result = await executeToolCall("click_by_text", JSON.stringify({ text }))

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Nothing on this page") })
    expect(currentSituation()).toBeNull()
  })

  it("refuses outright while a situation is up, so it cannot answer its own card", async () => {
    const asked = askSituation({ id: "other-1", title: "Something else?", payload: { kind: "options", options: [{ id: "go", label: "Go" }] } })
    const saves = clicked("save")

    const result = await executeToolCall("click_by_text", '{"text":"Save changes"}')

    expect(saves).toEqual([])
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("being asked") })
    dismissSituation()
    expect(await asked).toBeNull()
  })
})

describe("clicking a page the orb has no tool for", () => {
  it("runs the button's own handler once the operator agrees", async () => {
    const saves = clicked("save")
    const pending = executeToolCall("click_by_text", '{"text":"Save changes"}')
    await vi.waitFor(() => expect(currentSituation()).not.toBeNull())
    answerSituation("go")

    expect(await pending).toMatchObject({ ok: true, data: { performed: 'Clicked "save changes".' } })
    expect(saves).toEqual(["save"])
  })

  it("refuses words that fit two things, and names them both", async () => {
    document.getElementById("hidden-one")!.removeAttribute("hidden")

    const result = await executeToolCall("click_by_text", '{"text":"Discard"}')

    expect(result).toMatchObject({ ok: false })
    if (result.ok) throw new Error("expected a refusal")
    expect(result.error).toContain("2 things")
    expect(result.error).toContain('<button> "discard"')
  })

  it("takes the exact match over the one that merely contains it", async () => {
    const saves = clicked("save")
    document.body.insertAdjacentHTML("afterbegin", '<button id="exact">Save</button>')
    const pending = executeToolCall("click_by_text", '{"text":"Save"}')
    await vi.waitFor(() => expect(currentSituation()).not.toBeNull())
    answerSituation("go")

    expect(await pending).toMatchObject({ ok: true })
    expect(saves).toEqual([])
  })

  it("refuses words nothing on the page says", async () => {
    const result = await executeToolCall("click_by_text", '{"text":"Publish"}')

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('says "Publish"') })
    expect(currentSituation()).toBeNull()
  })

  it("refuses text that is not something to click", async () => {
    const result = await executeToolCall("click_by_text", '{"text":"Nothing happened yet"}')

    expect(result).toMatchObject({ ok: false })
    expect(currentSituation()).toBeNull()
  })

  it("does nothing when the control leaves the page while the operator is answering", async () => {
    const pending = executeToolCall("click_by_text", '{"text":"Save changes"}')
    await vi.waitFor(() => expect(currentSituation()).not.toBeNull())
    document.getElementById("save")!.remove()
    answerSituation("go")

    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining("left the page") })
  })
})

describe("typing into a page the orb has no tool for", () => {
  it("puts the operator's words in the field and tells the app about it", async () => {
    const field = document.getElementById("name") as HTMLInputElement
    const changes: string[] = []
    field.addEventListener("input", () => changes.push(field.value))
    const pending = executeToolCall("type_into", '{"field":"Vendor name","text":"Acme Supplies"}')
    await vi.waitFor(() => expect(currentSituation()).not.toBeNull())
    answerSituation("go")

    expect(await pending).toMatchObject({ ok: true })
    expect(field.value).toBe("Acme Supplies")
    expect(changes).toEqual(["Acme Supplies"])
  })

  it("refuses a password field without asking anybody", async () => {
    const result = await executeToolCall("type_into", '{"field":"Password","text":"hunter2"}')

    expect(currentSituation()).toBeNull()
    expect((document.getElementById("secret") as HTMLInputElement).value).toBe("")
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("password field") })
  })
})

describe("looking without touching", () => {
  it("says what it found and whether it can be used", async () => {
    const pending = executeToolCall("find_element_by_text", '{"text":"Save changes"}')
    await vi.waitFor(() => expect(currentSituation()).not.toBeNull())
    answerSituation("go")

    expect(await pending).toMatchObject({ ok: true, data: { tag: "button", text: "save changes", interactive: true } })
  })

  it("marks what it scrolled to, so the operator can see which one it meant", async () => {
    const pending = executeToolCall("scroll_to", '{"text":"Nothing happened yet"}')
    await vi.waitFor(() => expect(currentSituation()).not.toBeNull())
    answerSituation("go")
    await pending

    expect(document.getElementById("note")!.classList.contains(FOCUS_HIGHLIGHT_CLASS)).toBe(true)
  })
})

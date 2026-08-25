import { fireEvent, screen } from "@testing-library/react"
import { beforeAll, describe, expect, it } from "vitest"

import {
  choose,
  expectValidApprovalConfig,
  expectValidWaitConfig,
  installInspectorDomPolyfills,
  nodeConfig,
  renderApproval,
  renderUnhandledWait,
  renderWait,
} from "./inspector-form-harness"

beforeAll(installInspectorDomPolyfills)

describe("approval inspector who-decides gate", () => {
  it("reserves the gate for the operator and drops any approver, since the two contradict", async () => {
    const store = renderApproval({ description: "Merge?", approver: { source: "fixed", value: "platform-lead" } })

    await choose("Who decides?", "Only the operator")

    expect(nodeConfig(store)).toEqual({ description: "Merge?", operatorOnly: true })
    expect(screen.queryByLabelText("Approver (optional)")).toBeNull()
    expectValidApprovalConfig(nodeConfig(store))
  })

  it("hands the gate to the COO and drops any approver, since the two contradict", async () => {
    const store = renderApproval({ description: "Merge?", approver: { source: "fixed", value: "platform-lead" } })

    await choose("Who decides?", "The COO")

    expect(nodeConfig(store)).toEqual({ description: "Merge?", decidableBy: "coo" })
    expect(screen.queryByLabelText("Approver (optional)")).toBeNull()
    expectValidApprovalConfig(nodeConfig(store))
  })

  it("shows a COO gate as the COO's and leaves the field alone until it is changed", () => {
    const store = renderApproval({ description: "Merge?", decidableBy: "coo" })

    expect(screen.getByLabelText("Who decides?").textContent).toBe("The COO")
    expect(screen.getByText("Handed to the COO's own lane. No employee can decide it, and escalating it does not open it up.")).toBeTruthy()
    expect(screen.queryByLabelText("Approver (optional)")).toBeNull()
    expect(nodeConfig(store)).toEqual({ description: "Merge?", decidableBy: "coo" })
    expectValidApprovalConfig(nodeConfig(store))
  })

  it("clears the reservation entirely rather than writing operatorOnly: false", async () => {
    const store = renderApproval({ description: "Merge?", operatorOnly: true })

    await choose("Who decides?", "Routed up the org")

    expect(nodeConfig(store)).toEqual({ description: "Merge?" })
    expect(screen.getByLabelText("Approver (optional)")).toBeTruthy()
  })

  it("clears a COO gate entirely rather than leaving the field behind", async () => {
    const store = renderApproval({ description: "Merge?", decidableBy: "coo" })

    await choose("Who decides?", "Routed up the org")

    expect(nodeConfig(store)).toEqual({ description: "Merge?" })
  })

  it("swaps a COO gate for the operator without keeping both", async () => {
    const store = renderApproval({ description: "Merge?", decidableBy: "coo" })

    await choose("Who decides?", "Only the operator")

    expect(nodeConfig(store)).toEqual({ description: "Merge?", operatorOnly: true })
  })

  it("swaps an operator gate for the COO without keeping both", async () => {
    const store = renderApproval({ description: "Merge?", operatorOnly: true })

    await choose("Who decides?", "The COO")

    expect(nodeConfig(store)).toEqual({ description: "Merge?", decidableBy: "coo" })
  })
})

describe("approval inspector fixed choices", () => {
  it("writes plain labels the gateway would accept", () => {
    const store = renderApproval({ description: "Which direction?" })

    fireEvent.click(screen.getByLabelText("Offer fixed choices"))
    fireEvent.change(screen.getByLabelText("Choice 1"), { target: { value: "Rewrite it" } })
    fireEvent.change(screen.getByLabelText("Choice 2"), { target: { value: "Patch it" } })

    expect(nodeConfig(store).options).toEqual(["Rewrite it", "Patch it"])
    expectValidApprovalConfig(nodeConfig(store))
  })

  it("blocks a duplicate label inline without committing it", () => {
    const store = renderApproval({ description: "Which?", options: ["Rewrite it", "Patch it"] })

    fireEvent.change(screen.getByLabelText("Choice 1"), { target: { value: "Patch it" } })

    expect(screen.getByText("Use a unique label.")).toBeTruthy()
    expect(nodeConfig(store).options).toEqual(["Rewrite it", "Patch it"])
  })

  it("treats a label that only differs by surrounding space as a duplicate", () => {
    const store = renderApproval({ description: "Which?", options: ["Rewrite it", "Patch it"] })

    fireEvent.change(screen.getByLabelText("Choice 1"), { target: { value: "  Patch it  " } })

    expect(screen.getByText("Use a unique label.")).toBeTruthy()
    expect(nodeConfig(store).options).toEqual(["Rewrite it", "Patch it"])
  })

  it("commits a label trimmed, the way the gateway stores it", () => {
    const store = renderApproval({ description: "Which?", options: ["Rewrite it", "Patch it"] })

    fireEvent.change(screen.getByLabelText("Choice 1"), { target: { value: "  Ship it  " } })

    expect(nodeConfig(store).options).toEqual(["Ship it", "Patch it"])
    expectValidApprovalConfig(nodeConfig(store))
  })

  it("blocks an emptied label inline without committing it", () => {
    const store = renderApproval({ description: "Which?", options: ["Rewrite it", "Patch it"] })

    fireEvent.change(screen.getByLabelText("Choice 2"), { target: { value: "" } })

    expect(screen.getByText("Give every choice a label.")).toBeTruthy()
    expect(nodeConfig(store).options).toEqual(["Rewrite it", "Patch it"])
  })

  it("blocks a label past the length the gateway takes", () => {
    const store = renderApproval({ description: "Which?", options: ["Rewrite it", "Patch it"] })

    fireEvent.change(screen.getByLabelText("Choice 2"), { target: { value: "x".repeat(81) } })

    expect(screen.getByText("Keep a choice to 80 characters or fewer.")).toBeTruthy()
    expect(nodeConfig(store).options).toEqual(["Rewrite it", "Patch it"])
  })

  it("adds a unique label and stops at eight", () => {
    const seven = ["Option 1", "Option 2", "Option 3", "Option 4", "Option 5", "Option 6", "Option 7"]
    const store = renderApproval({ description: "Which?", options: seven })
    const add = screen.getByRole("button", { name: "Add choice" }) as HTMLButtonElement

    fireEvent.click(add)

    expect(nodeConfig(store).options).toEqual([...seven, "Option 8"])
    expectValidApprovalConfig(nodeConfig(store))
    expect(add.disabled).toBe(true)
  })

  it("removes a choice but never below two", () => {
    const store = renderApproval({ description: "Which?", options: ["A", "B", "C"] })

    fireEvent.click(screen.getByRole("button", { name: "Remove choice 3" }))

    expect(nodeConfig(store).options).toEqual(["A", "B"])
    expect((screen.getByRole("button", { name: "Remove choice 1" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Remove choice 2" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("keeps every choice control at a 34px tap target", () => {
    renderApproval({ description: "Which?", options: ["Rewrite it", "Patch it"] })

    expect(screen.getByLabelText("Choice 1").classList.contains("min-h-[34px]")).toBe(true)
    expect(screen.getByRole("button", { name: "Remove choice 1" }).classList.contains("size-[34px]")).toBe(true)
    expect(screen.getByRole("button", { name: "Add choice" }).classList.contains("h-[34px]")).toBe(true)
  })

  it("removes the options key entirely when the choices are turned off", () => {
    const store = renderApproval({ description: "Which?", options: ["Rewrite it", "Patch it"] })

    fireEvent.click(screen.getByLabelText("Offer fixed choices"))

    expect("options" in nodeConfig(store)).toBe(false)
    expect(screen.queryByLabelText("Choice 1")).toBeNull()
  })

  it("keeps authored choices while an unrelated field is edited", () => {
    const options = ["Rewrite it", "Patch it", "Leave it"]
    const store = renderApproval({ description: "Which?", options })

    fireEvent.change(screen.getByLabelText("What needs approval?"), { target: { value: "Which direction?" } })

    expect(nodeConfig(store)).toEqual({ description: "Which direction?", options })
  })
})

describe("wait inspector modes", () => {
  it("writes the gateway's default when the Todo-comment mode is picked", async () => {
    const store = renderWait({ mode: "duration", minutes: 60 })

    await choose("Wait", "Until a Todo comment")

    expect(nodeConfig(store)).toEqual({ mode: "todo-comment", timeoutMinutes: 10_080 })
    expectValidWaitConfig(nodeConfig(store))
  })

  it("blocks a timeout past the range inline without committing it", () => {
    const store = renderWait({ mode: "todo-comment", timeoutMinutes: 10_080 })

    fireEvent.change(screen.getByLabelText("Timeout (minutes)"), { target: { value: "43201" } })

    expect(screen.getByText("Enter between 1 and 43200 minutes.")).toBeTruthy()
    expect(nodeConfig(store)).toEqual({ mode: "todo-comment", timeoutMinutes: 10_080 })
    expectValidWaitConfig(nodeConfig(store))
  })

  it("blocks a zero timeout inline instead of substituting the default", () => {
    const store = renderWait({ mode: "todo-comment", timeoutMinutes: 10_080 })

    fireEvent.change(screen.getByLabelText("Timeout (minutes)"), { target: { value: "0" } })

    expect(screen.getByText("Enter between 1 and 43200 minutes.")).toBeTruthy()
    expect(nodeConfig(store)).toEqual({ mode: "todo-comment", timeoutMinutes: 10_080 })
  })

  it("stays valid switching from a Todo comment to a duration and back", async () => {
    const store = renderWait({ mode: "todo-comment", timeoutMinutes: 240 })

    await choose("Wait", "For a duration")
    expect(nodeConfig(store)).toEqual({ mode: "duration", minutes: 60 })
    expectValidWaitConfig(nodeConfig(store))

    await choose("Wait", "Until a Todo comment")
    expect(nodeConfig(store)).toEqual({ mode: "todo-comment", timeoutMinutes: 10_080 })
    expectValidWaitConfig(nodeConfig(store))
  })

  it("explains a mode it cannot render read-only instead of downgrading it", () => {
    const config = { mode: "signal", channel: "deploys" }
    const store = renderUnhandledWait(config)

    expect(screen.getByText(/does not\s+know/)).toBeTruthy()
    // Every control in this form replaces the whole config, so one appearing here
    // is the data loss itself: the mode and its own keys would be gone on first touch.
    expect(screen.queryByRole("combobox", { name: "Wait" })).toBeNull()
    expect(screen.queryByLabelText("Minutes")).toBeNull()
    expect(screen.queryByLabelText("Timeout (minutes)")).toBeNull()
    expect(screen.queryByLabelText("Timestamp (ISO)")).toBeNull()
    expect(nodeConfig(store)).toEqual(config)
    expect(store.getState().serial).toBe(0)
  })

  it("keeps an unhandled mode intact while an unrelated field is edited", () => {
    const config = { mode: "signal", channel: "deploys" }
    const store = renderUnhandledWait(config)

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Await the deploy signal" } })

    expect(store.getState().nodes[0]!.data.node.name).toBe("Await the deploy signal")
    expect(nodeConfig(store)).toEqual(config)
  })

  it("keeps the timeout input at a 34px tap target", () => {
    renderWait({ mode: "todo-comment", timeoutMinutes: 10_080 })

    expect(screen.getByLabelText("Timeout (minutes)").classList.contains("min-h-[34px]")).toBe(true)
  })

  it("still edits a duration wait", () => {
    const store = renderWait({ mode: "duration", minutes: 60 })

    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "30" } })

    expect(nodeConfig(store)).toEqual({ mode: "duration", minutes: 30 })
  })
})

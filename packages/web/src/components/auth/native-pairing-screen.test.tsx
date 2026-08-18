import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NativePairingScreen } from "./native-pairing-screen"

const pairAndInstall = vi.fn()
vi.mock("@/lib/native-gateway-bootstrap", () => ({
  pairAndInstallNativeGateway: (...args: unknown[]) => pairAndInstall(...args),
}))

describe("NativePairingScreen", () => {
  beforeEach(() => pairAndInstall.mockReset())

  it("pairs an explicit gateway origin and code", async () => {
    pairAndInstall.mockResolvedValue("http://127.0.0.1:7779")
    const onPaired = vi.fn()
    render(<NativePairingScreen onPaired={onPaired} />)
    fireEvent.change(screen.getByLabelText("Pair code"), { target: { value: "ABCD-EFGH" } })
    fireEvent.click(screen.getByRole("button", { name: "Pair gateway" }))
    await waitFor(() => expect(onPaired).toHaveBeenCalledWith("http://127.0.0.1:7779"))
    expect(pairAndInstall).toHaveBeenCalledWith("http://127.0.0.1:7779", "ABCD-EFGH")
  })
})

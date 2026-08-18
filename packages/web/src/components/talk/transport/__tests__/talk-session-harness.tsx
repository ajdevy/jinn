/* How a talk session is mounted, opened, and answered. What a session is
 * supposed to do lives next door in use-talk-session.test.tsx, and what it does
 * across a tab switch in park-while-hidden.test.tsx; this is only the harness. */
import { act, waitFor } from "@testing-library/react"
import { expect, vi, type Mock } from "vitest"

/** The gateway's answers, in one place, so a test only mocks what it changes.
 *  Owned here rather than per file because both suites drive the same session
 *  through the same four endpoints. */
export const authFetch: Mock = vi.fn()

const { useTalkSession } = await import("../use-talk-session")
const { useTalkSessionId, setTalkSessionId } = await import("@/components/talk/talk-session-store")
const { clearResumableTalkSession } = await import("@/components/talk/talk-session-store")
const { FakeConnection, connect } = await import("./fake-connection")
const { resetPageContext } = await import("@/components/talk/context/page-context-store")
const { browserControlFixture } = await import("./control-fixture")
const { browserInstanceId } = await import("@/components/talk/context/browser-instance")

export const OPENED = {
  id: "talk-1",
  browserInstanceId: browserInstanceId(),
  credentialGeneration: 1,
  token: "secret-1",
  expiresAt: 1_700_000_600,
  model: "gpt-realtime-2.1",
  manifest: browserControlFixture(),
}
export const CONFIGURED = { configured: true, provider: "openai", providers: ["openai"] }

/** The live handle the probe last rendered with. A `let` so the tests read the
 *  current one rather than the one that existed when they imported this. */
export let handle: ReturnType<typeof useTalkSession>

export function Probe() {
  handle = useTalkSession(connect)
  return <span data-testid="open-session">{useTalkSessionId() ?? "none"}</span>
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

/** Every request this test made against one path suffix. */
export function calls(match: string) {
  return authFetch.mock.calls.filter(([url]) => String(url).endsWith(match))
}

export function openSucceeds() {
  authFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url === "/api/talk/config") return json(CONFIGURED)
    if (url === "/api/talk/sessions" && init.method === "POST") return json(OPENED, 201)
    if (url.endsWith("/resume")) return json({
      token: "secret-2",
      expiresAt: 1_700_001_200,
      browserInstanceId: OPENED.browserInstanceId,
      credentialGeneration: 2,
    })
    return json({ ok: true })
  })
}

export async function activate() {
  await act(async () => handle.toggle())
  await waitFor(() => expect(handle.active).toBe(true))
}

export function resetHarness() {
  authFetch.mockReset()
  connect.mockClear()
  FakeConnection.opened = []
  setTalkSessionId(null)
  clearResumableTalkSession()
  resetPageContext()
}

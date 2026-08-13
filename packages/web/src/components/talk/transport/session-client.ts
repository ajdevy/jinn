/**
 * The talk session's HTTP half: open, keep alive, park, resume, close, and post
 * what a turn cost.
 *
 * Everything here is `authFetch` and JSON — no media, no peer connection, no
 * React. The provider connection is `webrtc-connection.ts`'s job, and keeping
 * the two apart is what lets the lifecycle be driven by a test at wall-clock
 * speed under fake timers.
 *
 * `docs/talk-session-runtime.md` is the contract these routes implement.
 */
import { authFetch } from "@/lib/auth"
import type { TalkUsage } from "./usage-delta"

/** The gateway reaps a session after three missed beats (`TALK_SESSION_TTL_MS`,
 *  90s), so this is the slowest rate that keeps one alive. */
export const HEARTBEAT_INTERVAL_MS = 30_000

export interface OpenTalkSession {
  id: string
  /** The provider credential, minted for this open and never stored. */
  token: string
  /** Unix seconds. */
  expiresAt: number
  model: string
}

export interface TalkToken {
  token: string
  expiresAt: number
}

function sessionPath(id: string, action?: string): string {
  const base = `/api/talk/sessions/${encodeURIComponent(id)}`
  return action ? `${base}/${action}` : base
}

/** What the gateway reports when voice has no provider it could use. It is a
 *  refusal with an answer, so callers offer setup rather than repeat a message —
 *  which is why it is a type and not a string to match against. */
export class VoiceUnconfiguredError extends Error {}

/** The gateway's own words for what went wrong, because it is the only party
 *  that knows whether voice is unconfigured, the provider refused, or the
 *  session is gone. A body with nothing to say falls back to the status. */
async function failure(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: unknown; reason?: unknown }
    const message = typeof body.error === "string" && body.error ? body.error : null
    if (body.reason === "unconfigured") {
      return new VoiceUnconfiguredError(message ?? "Voice is not available.")
    }
    if (message) return new Error(message)
  } catch {
    /* a body that is not JSON says nothing the status does not */
  }
  return new Error(`The gateway answered ${response.status} for ${response.url || "the talk session"}.`)
}

async function talkFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authFetch(path, { method: "POST", ...init })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as T
}

function jsonBody(body: unknown): RequestInit {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
}

/**
 * Open a session. This is the call that mints a paid provider credential, so it
 * belongs to an operator gesture and nothing else — never a mount, never a
 * route change. `lib/talk-capability.ts` is what asks whether that is even
 * possible, and asking costs nothing.
 */
export async function openTalkSession(): Promise<OpenTalkSession> {
  const opened = await talkFetch<Partial<OpenTalkSession>>("/api/talk/sessions")
  if (typeof opened.id !== "string" || typeof opened.token !== "string") {
    throw new Error("The gateway opened a talk session without an id and a credential.")
  }
  return { id: opened.id, token: opened.token, expiresAt: opened.expiresAt ?? 0, model: opened.model ?? "" }
}

/** `keepalive` because this is also what a closing tab sends, and an unload
 *  cancels ordinary requests in flight. Closing is idempotent server-side. */
export async function closeTalkSession(id: string): Promise<void> {
  await talkFetch(sessionPath(id), { method: "DELETE", keepalive: true })
}

export async function heartbeatTalkSession(id: string): Promise<void> {
  await talkFetch(sessionPath(id, "heartbeat"))
}

export async function parkTalkSession(id: string): Promise<void> {
  await talkFetch(sessionPath(id, "park"))
}

/** Resume returns a fresh credential, because the one the session was parked
 *  with expires within its 600 seconds. */
export async function resumeTalkSession(id: string): Promise<TalkToken> {
  const resumed = await talkFetch<TalkToken>(sessionPath(id, "resume"))
  return { token: resumed.token, expiresAt: resumed.expiresAt }
}

/** `usage` is this turn's delta. See `usage-delta.ts` for why that matters. */
export async function postTalkTurn(id: string, usage: TalkUsage, transcript: string): Promise<void> {
  await talkFetch(sessionPath(id, "turn"), jsonBody({ usage, transcript }))
}

/**
 * Beat until the returned function is called. A failed beat is swallowed rather
 * than stopping the interval: the network drops for less time than the reaper's
 * ninety seconds far more often than it drops for longer, and the next beat is
 * what re-attaches.
 */
export function startTalkHeartbeat(id: string): () => void {
  const timer = setInterval(() => {
    void heartbeatTalkSession(id).catch(() => {})
  }, HEARTBEAT_INTERVAL_MS)
  return () => clearInterval(timer)
}

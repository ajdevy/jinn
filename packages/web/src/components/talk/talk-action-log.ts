import { authFetch } from "@/lib/auth"

/**
 * Every write the orb ATTEMPTS, including the ones it refused to make.
 *
 * A talk write goes out as the authenticated operator, so the gateway's own
 * audit can say what changed but not that a voice asked for it, and nothing
 * anywhere records the consent decision that came first — least of all a refusal,
 * which by definition leaves no trace on the thing it did not touch. This is the
 * log that does.
 *
 * The entries live here, and this is not a cache in front of something sturdier.
 * The gateway's copy is a list on an in-memory talk session, so it lasts exactly
 * as long as that session does and no longer; an entry recorded with no session
 * bound — on the orb bench, or between sessions — lives in page memory alone.
 * What IS persisted of a talk write is `origin: "talk"` on the work-item event
 * the gateway appends; the consent decisions and refusals recorded here have no
 * such row behind them.
 */

export type ActionLane = "fast" | "consent"
export type ActionConsent = "not-required" | "granted" | "refused"

export interface TalkActionEntry {
  at: number
  tool: string
  /** What it acted on, as an app-visible id. Null when there is no one subject. */
  subject: string | null
  lane: ActionLane
  consent: ActionConsent
  /** Set when this entry is the reversal of an earlier one, naming its id. */
  undoOf?: string
  /** The gateway's id for this entry, once it has one. */
  id?: string
}

/** Generous: a voice session that writes more than this has other problems. */
const KEPT = 200

const entries: TalkActionEntry[] = []
let sessionId: string | null = null

/** Bind the talk session the gateway's copy of the log belongs to. Null while
 *  there is no session, which is every moment the orb is not live. */
export function bindTalkActionLog(id: string | null): void {
  sessionId = id
}

/**
 * Record one attempted write. Posting is deliberately not awaited: the audit
 * must not sit in the latency path of a voice turn, and an entry that fails to
 * reach the gateway is still readable here.
 */
export function recordTalkAction(entry: Omit<TalkActionEntry, "at">): TalkActionEntry {
  const recorded: TalkActionEntry = { ...entry, at: Date.now() }
  entries.push(recorded)
  if (entries.length > KEPT) entries.splice(0, entries.length - KEPT)
  void persist(recorded)
  return recorded
}

async function persist(entry: TalkActionEntry): Promise<void> {
  if (!sessionId) return
  try {
    const response = await authFetch(`/api/talk/sessions/${encodeURIComponent(sessionId)}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: entry.tool,
        subject: entry.subject,
        lane: entry.lane,
        consent: entry.consent,
        ...(entry.undoOf ? { undoOf: entry.undoOf } : {}),
      }),
    })
    if (!response.ok) return
    const stored = (await response.json()) as { id?: unknown }
    if (typeof stored.id === "string") entry.id = stored.id
  } catch {
    // The in-memory entry above is the record either way; a session that has
    // gone away must not turn an audit write into a failed tool call.
  }
}

/** What has been attempted this page, oldest first. */
export function talkActions(): readonly TalkActionEntry[] {
  return entries
}

/** Test seam: the log outlives any one situation, so it has to be resettable. */
export function clearTalkActions(): void {
  entries.length = 0
  sessionId = null
}

/**
 * The talk-session runtime's own model. These types live here rather than in
 * shared/types.ts because nothing outside src/talk/session and the gateway's
 * talk router consumes them.
 */

/**
 * `parked` means the browser dropped its provider connection — the mic is cold
 * and the provider bills nothing — while the gateway keeps the turn history and
 * the exposed-tool set. `closed` is terminal.
 */
export type TalkSessionState = "live" | "parked" | "closed";

/** One completed exchange. The transcript is kept only to estimate context; the
 *  gateway never replays it to the provider. */
export interface TalkTurnRecord {
  at: number;
  text: string;
  estimatedTokens: number;
}

export interface TalkSession {
  id: string;
  /** The `sessions` row this talk session bills through, so its spend shows up
   *  in the cost report alongside every other session. */
  sessionId: string;
  state: TalkSessionState;
  model: string;
  openedAt: number;
  /** Last heartbeat. The reaper closes a session that stops sending them. */
  lastSeenAt: number;
  turns: TalkTurnRecord[];
  /** How many turns truncation has dropped over this session's life. */
  truncatedTurns: number;
  /** Tool names already in the provider's session, always-on set included. */
  exposedTools: string[];
  /** Intents already expanded, so asking twice adds nothing a second time. */
  expandedIntents: string[];
}

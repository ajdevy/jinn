# Talk: the session runtime in the gateway

This subsystem is what the gateway does for a voice conversation, and the short
version is: as little as possible. It mints a short-lived provider credential,
keeps one in-memory record per open talk session, and prices each turn into the
existing session ledger. It is a credential minter and an accounting authority.
**No conversation audio passes through it.** The browser holds the provider
connection and carries the microphone and speaker bytes both ways; the gateway
holds the credential policy, the tool set, the context budget, and the bill. The
gateway does still serve two audio routes — `POST /api/stt/transcribe` for the
chat composer's dictation and `GET/POST /api/tts` for reading a chat message
aloud — but both belong to the text chat surface and neither is called on a voice
turn. `/api/tts` is reached through this router only because it was moved here
verbatim; see the endpoint table below.

The code lives in `packages/jinn/src/talk/session/`:

| File | Owns |
|---|---|
| `types.ts` | `TalkSession`, `TalkSessionState`, `TalkTurnRecord` |
| `registry.ts` | the in-memory `Map<id, TalkSession>`: open, park, resume, heartbeat, turn, close, reap |
| `tools.ts` | the tool catalog: always-on set, on-intent groups, token cost of a tool list |
| `context.ts` | rolling truncation against a token budget, and the handoff predicate |
| `pricing.ts` | `RealtimeUsage` to USD, per model, from a rate table |

The provider adapters it mints through are ICI-751's, in
`packages/jinn/src/talk/realtime/`. Their billing and transport facts are written
up in `docs/realtime-providers.md`.

---

## Dependency on retired Talk code

Nothing here depends on code PLA-59 deleted, and PLA-59 is not pending: its
payload is already merged to `main` as commit `f4f7eab7`, "refactor(talk): retire
the Talk voice orchestrator". This runtime imports none of the symbols that
commit removed.

So that a reader can grep rather than take this on trust, the removed surface was:

- Whole files: `talk/graph.ts`, `talk/attachments.ts`, `talk/mute-state.ts`,
  `talk/orchestrator-persona.ts`, `talk/INTEGRATION.md`.
- The card model and the whole wire-event set in `talk/protocol.ts`.
- The sentence-buffer half of `talk/tts-stream.ts`: `feedTalkText`,
  `flushTalkSpeech`, `discardTalkSpeech`, `extractSentences`.
- In `sessions/callbacks.ts`: `talkLabel`, `buildTalkWake`,
  `notifyAttachedTalkSessions`.
- In `sessions/context.ts`: `TalkThreadSummary` and `buildTalkThreadsSection()`.
- In the config type: `JinnConfig.talk.{enabled, engine, orchestratorModel}`.

The only couplings this runtime has into `src/talk` at all are three, all of them
to code that is live on `main`:

1. `talk/realtime/index.ts`, for `createRealtimeProvider` and
   `UnknownRealtimeProviderError`.
2. `shared/types.ts`, for the ICI-751 realtime types: `RealtimeProvider`,
   `RealtimeUsage`, `RealtimeTool`, `RealtimeSessionOptions`,
   `RealtimeEphemeralToken`, `RealtimeTurnDetection`.
3. `talk/tts-stream.ts`, and only because the two existing `/api/tts` read-aloud
   routes were moved into the new talk router without behaviour change. Those
   routes were never part of the orchestrator, PLA-59 did not touch them, and the
   exports they use (`ttsStatus`, `validateTtsText`, `streamTtsSentences`) are
   all still on `main`.

A stale worktree branch named `simplify/PLA-59-retire-talk-orchestrator` still
exists locally in some checkouts. It is residue from before the merge and is
many commits behind. Do not rebase it, apply it, or read it as the current state
of PLA-59.

---

## Five structural differences from the retired Talk surface

Each of these names a concrete mechanism on both sides, so each is checkable
against code rather than a claim about quality.

### 1. The gateway stopped being the audio pipe for a conversation

**Before.** Every voice turn made a full round trip through the gateway:
microphone capture to `POST /api/stt/transcribe`, then `POST /api/talk/turn`,
then a server-side model call, then whole-turn Kokoro text-to-speech, then a
`talk:say` / `talk:audio` broadcast over the WebSocket to every connected client.
Time to first audio was measured in seconds, and a voice conversation could not
happen at all without the Python virtualenv sidecar that runs Kokoro.

**Now.** The gateway mints an ephemeral provider token with a TTL of at most 600
seconds and returns it to the browser, which opens its own connection directly to
the provider and carries the audio both ways. A voice turn makes no gateway call
that touches audio: no transcription hop, no server-side model call, no
synthesis, no broadcast, and no dependency on the sidecar. The account key stays
server-side and never appears in a response body.

Two audio routes do survive in the gateway, and the realtime session calls
neither: `POST /api/stt/transcribe` (`gateway/api.ts`) still transcribes a
recording for the chat composer's dictation, and `GET/POST /api/tts`
(`gateway/talk-tts-api.ts`) still synthesizes Kokoro WAV frames to read a chat
message aloud. Both are text-chat features that outlived the orchestrator, which
is why `template/migrations/0.29.1/MIGRATION.md` promises read-aloud and
push-to-talk dictation are unaffected. `talk-api.ts` hands `/api/tts` to
`talk-tts-api.ts` before matching its own routes — that is the move, not a
coupling — and no `/api/talk/sessions/*` path reaches either route. Nothing under
`talk/session/` mentions them at all.

### 2. Behaviour moved from a prompt-injected persona to typed tool declarations

**Before.** Behaviour was two Markdown files loaded from the operator's Jinn home
with hot-reload, `orchestrator-persona.md` and `card-reference.md`, plus a
13-type "card" grammar the model was expected to emit as text and a fail-closed
validator that rejected malformed cards. Every persona revision moved the
behaviour.

**Now.** Behaviour is a list of `RealtimeTool` values with JSON Schema
`parameters`, declared in `talk/session/tools.ts` and passed to the provider's
own tool-calling protocol. There is no persona file to load, no card grammar to
parse, and no validator: a malformed call is the provider's schema error, not a
text-parsing failure. The UI payload contract is a typed union owned in code by
ICI-754.

### 3. State collapsed from three stores into one registry plus one ledger row

**Before.** State lived in three places at once: module-level `Map`s, a
`talkAttachments` array merged into the session row's `transport_meta` JSON blob,
and a `/api/talk/graph` snapshot endpoint. The WebSocket deltas were documented
as best-effort with the snapshot as the real truth, so a client had to
reconcile them.

**Now.** One `TalkSessionRegistry`, an in-memory `Map<id, TalkSession>` keyed by
talk-session id, is the only store of session state. Alongside it there is
exactly one `sessions` row, created solely so spend reuses the existing ledger.
Nothing writes `transport_meta`, and there is no snapshot endpoint to reconcile
against: `GET /api/talk/sessions/:id` reads the same object every write path
mutates.

### 4. Handoff creates a real Session instead of polling child status

**Before.** The retired surface's own `INTEGRATION.md` recorded the constraint:
"the /talk turn is NOT itself a gateway Session, so `notifyParentSession`
injection won't reach us". Because the callback could not arrive, delegation was
a poll loop over child session status.

**Now.** `POST /api/talk/sessions/:id/handoff` spawns an ordinary text Session
through the existing spawn path, with the talk session's `sessions` row as its
parent, and returns that session's id. The existing `notifyParentSession`
callback machinery reaches it because it is a Session like any other. No polling
code exists in this subsystem.

### 5. Context went from whole-payload-per-turn to progressive exposure plus rolling truncation

**Before.** Every turn re-injected the whole payload into the system prompt: the
persona file, the card reference, and a live roster of attached threads. The
per-turn cost grew with the roster and could not be bounded from the client.

**Now.** The token minted at open carries only the always-on tool set;
`POST /api/talk/sessions/:id/tools` adds a named group when the client hears the
matching intent, and returns an empty array if that group is already exposed.
Turn history is truncated against `TALK_CONTEXT_BUDGET_TOKENS` by dropping oldest
turns. Both numbers are reported back:
`GET /api/talk/sessions/:id` returns `contextTokens` and `exposedTools`, and
`POST .../turn` returns `contextTokens` and `truncatedTurns`.

---

## Endpoints

All under `/api/talk/*`. All writes are operator-authenticated.

| Method and path | Does |
|---|---|
| `POST /api/talk/sessions` | Open. Creates the `sessions` row, mints a token scoped to the always-on tool set, returns `{ id, token, expiresAt, model, tools, contextBudgetTokens }`. |
| `POST /api/talk/sessions/:id/token` | Re-mint, on expiry or on resume. |
| `POST /api/talk/sessions/:id/park` | live to parked. |
| `POST /api/talk/sessions/:id/resume` | parked to live, returns a fresh token. |
| `POST /api/talk/sessions/:id/heartbeat` | Refresh `lastSeenAt`. |
| `POST /api/talk/sessions/:id/tools` | `{ intents: string[] }` returns the additional `RealtimeTool[]` to inject plus the new total token cost. Never returns a tool already exposed. |
| `POST /api/talk/sessions/:id/turn` | `{ usage: RealtimeUsage, transcript? }` prices the delta, calls `recordTurnAccounting`, appends to history, applies rolling truncation, returns `{ spendUsd, contextTokens, truncatedTurns, handoffSuggested }`. |
| `POST /api/talk/sessions/:id/handoff` | `{ prompt }` spawns a normal text Session with the talk session as parent, returns `{ sessionId }`. |
| `GET /api/talk/sessions/:id` | `{ state, openedAt, turns, spendUsd, contextTokens, exposedTools }`. |
| `DELETE /api/talk/sessions/:id` | Close. Idempotent. |
| `GET/POST /api/tts` | Moved verbatim out of `gateway/api.ts`. Behaviour unchanged: `GET` returns `{ available, voice }`, `POST` streams length-prefixed WAV frames, 503s when Kokoro is unavailable, 400s on invalid text. |

State is `live`, `parked`, or `closed` (`TalkSessionState` in
`talk/session/types.ts`). `parked` means the browser dropped its provider
connection: the microphone is cold and the provider bills nothing, while the
gateway keeps the turn history and the exposed-tool set. `resume` mints a fresh
token because the old one expires within 600 seconds. `park` on an
already-parked session and `resume` on a live one are 409, not silent no-ops.

Liveness is a heartbeat, never a socket binding. The client keeps the talk-session
id in `sessionStorage` (per tab, cleared on tab close) and re-attaches after each
route change, so a navigation costs nothing. A closed tab stops heartbeating, and
the reaper closes any session whose `lastSeenAt` is older than
`TALK_SESSION_TTL_MS` (90 seconds, three missed 30-second heartbeats). Talk
sessions do not survive a gateway restart, which is the same death by a blunter
instrument.

---

## Cost model

The repo rule is derive, never store, and this runtime follows it exactly.

Opening a talk session inserts one `sessions` row with `source: "talk"`. That
source string is deliberately reused rather than invented: `f4f7eab7` kept
`"talk"` in `NON_CONNECTOR_SOURCES` precisely because rows carry it.

Each `POST /api/talk/sessions/:id/turn` prices that turn's usage and passes the
result to `recordTurnAccounting(sessionId, { cost, numTurns: 1 })`, which is the
single accounting entry point in `sessions/registry.ts`. `spendUsd` is then read
back through `getSessionSpend`. Nothing accumulates a running total anywhere else:
there is no new spend column, no counter on the `TalkSession` record, and no
addition outside `recordTurnAccounting`. The consequence is that a talk session
appears in `/api/cost/report` and every other spend surface for free, with no
per-surface wiring.

**The client posts per-turn usage, not a session-to-date total.** This is the one
place a caller can get it wrong and silently over-bill. The provider's
`turn_done` event carries a *running* total for the session, so the caller must
subtract the previous reading before posting. `priceTurn(model, usage)` in
`talk/session/pricing.ts` documents this in its signature comment and treats its
`usage` argument as a delta unconditionally. Two identical turns are expected to
add twice.

### The rate table, and the model that is missing from it

`pricing.ts` holds a `RATES` table keyed by model id, with per-1M-token rates for
input audio, output audio, input text, output text, and a separate cached rate for
each input modality. Cached input gets two numbers because the vendor charges two:
on `gpt-realtime-2.1-mini` a cached text token is $0.06 against a cached audio
token's $0.30, so a single blended cached rate would be wrong by 5x on a
tool-heavy turn. The numbers come from `docs/realtime-providers.md`, which quotes
the vendor pricing pages verbatim as checked on 2026-08-06. The keys are the
versioned ids the pricing page actually lists: `gpt-realtime-2.1` and
`gpt-realtime-2.1-mini`.

The unversioned `gpt-realtime` alias is deliberately absent. An alias resolves to
whichever version the vendor currently points it at, and that mapping changes
without notice, so putting a row under that key would encode a guess in a table
whose entire value is that its numbers were read off a published page. A wrong
rate is worse than a missing one, because it is invisible.

So `priceTurn` returns `{ costUsd: 0, pricingKnown: false }` for any model it
does not have a rate for, and `isPricingKnown(model)` feeds the same flag onto the
status response. `pricingKnown: false` means: this turn really did cost money, the
gateway recorded $0 because it does not know the rate, and the number you are
looking at is a floor rather than a measurement. A silent zero with no flag would
read as a free turn, which would be a lie. The fix for an operator seeing the flag
is to pin a versioned model id in `realtime.model`.

Two cost facts from `docs/realtime-providers.md` shape what this subsystem is even
for. Realtime input tokens grow with conversation length because the whole
conversation is re-sent on every response, and prompt caching offsets that only
while the history is left alone: changing or removing content busts the cache from
the point of the change onward. The provider reports the cached share *inside* the
input counts rather than beside them, and splits it by modality, so `priceTurn`
deducts each modality's cached count before the full rate applies and charges it at
that modality's own cached rate — billing both buckets would charge the cached
prefix twice, at roughly eighty times its real cost. When a `response.done` carries
a cached total but no modality breakdown, the adapter charges the remainder to
whichever modality bills it highest, because an over-report shows up in the cost
line and an under-report does not. That is not the dearer cached rate, which is the
comparison it looks like: a cached token also cancels the full input rate it would
otherwise have been charged at. On `gpt-realtime-2.1-mini` cached audio is $0.30
against text's $0.06, yet charging the remainder to audio bills *less*, because it
discounts a $10 input token where text discounts a $0.60 one. The remainder fills
its modality's own input count first and spills to the other, so the cached counts
stay the subsets everything downstream reads them as. Rolling truncation therefore
trades cache hits for a bounded context, which is the right trade only because the
budget is generous enough that most sessions never truncate at all.

---

## Context and tools

### Token estimation is an estimate, and says so

`estimateTokens(text)` in `context.ts` is `Math.ceil(text.length / 4)`: four
characters per token. This is a documented estimate, not the provider's count.
Nothing is billed from it. Its only jobs are to decide when to truncate and to
make the cost of adding a tool group visible before it is added. The real numbers
arrive with each turn's `RealtimeUsage` and are what `priceTurn` charges.
`estimateToolTokens` uses the same four-characters-per-token rule over the tool
list's JSON.

### Truncation drops the oldest and always keeps the newest

`truncateTurns(turns, budgetTokens)` shifts turns off the front until the
estimated total fits the budget, and stops at one. The newest turn is retained
even when it exceeds the budget on its own, because a session with nothing in
context cannot answer the thing the user just said. The budget is
`TALK_CONTEXT_BUDGET_TOKENS` (6000), chosen to bound cost rather than to avoid a
provider window error. The registry accumulates `truncatedTurns` over the
session's life and reports it on every turn response.

The oversized-single-turn case is what `handoffSuggested` exists for: a turn over
`TALK_HANDOFF_TURN_TOKENS` (1500) is a research request wearing a conversation's
clothes, and the client offers a text session instead of answering it out loud.

### Progressive tool exposure

`tools.ts` splits the catalog into an always-on set and named on-intent groups.
The token minted at open carries only the always-on set. When the client hears a
matching intent it posts to `POST /api/talk/sessions/:id/tools`, and
`toolsForIntents` returns only the tools not already exposed. Asking twice for the
same intent returns an empty array rather than a duplicate declaration, because a
provider session carrying two tools of the same name is rejected. Two invariants
are tested: the always-on list is a strict subset of the full catalog, and the
endpoint is idempotent per intent.

What ships here is the mechanism plus a small read-only seed. `search_knowledge`
and `hand_off_to_chat` are always on; `todos`, `sessions`, and `org` are the seed
groups. **ICI-756 owns the full catalog** and extends `tools.ts`; the seed here is
not a proposal for what that catalog should contain. **ICI-757 owns write actions**
along with their consent and undo lanes, so every tool in this file is read-only
by construction.

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
| `types.ts` | `TalkSession`, `TalkSessionState`, `TalkTurnRecord`, `TalkActionRecord` |
| `registry.ts` | the in-memory `Map<id, TalkSession>`: open, park, resume, heartbeat, turn, action, close, reap |
| `tools.ts` | provider declarations derived from the authoritative control manifest, plus token-cost reporting |
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
`parameters`, sourced from `talk/control/manifest.ts` and passed to the
provider's own tool-calling protocol. There is no persona file to load or card
grammar to parse. The gateway validates arguments again before execution, so a
malformed or schema-breaking replay fails closed even if a provider emits it.

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

### 5. Context went from whole-payload-per-turn to a bounded manifest plus rolling truncation

**Before.** Every turn re-injected the whole payload into the system prompt: the
persona file, the card reference, and a live roster of attached threads. The
per-turn cost grew with the roster and could not be bounded from the client.

**Now.** The token minted at open and every browser `session.update` carry
declarations derived from the same versioned control manifest. The compatibility
`POST /api/talk/sessions/:id/tools` route returns no duplicates while the current
manifest is universally exposed.
Turn history is truncated against `TALK_CONTEXT_BUDGET_TOKENS` by dropping oldest
turns. Both numbers are reported back:
`GET /api/talk/sessions/:id` returns `contextTokens` and `exposedTools`, and
`POST .../turn` returns `contextTokens` and `truncatedTurns`.

---

## Endpoints

All under `/api/talk/*`. All writes are operator-authenticated.

| Method and path | Does |
|---|---|
| `POST /api/talk/sessions` | Open. Creates the `sessions` row, mints a token scoped to the authoritative manifest, builds the standing brief, returns `{ id, token, expiresAt, model, tools, manifest, brief, contextBudgetTokens }`. |
| `POST /api/talk/sessions/:id/token` | Re-mint, on expiry or on resume. |
| `POST /api/talk/sessions/:id/park` | live to parked. |
| `POST /api/talk/sessions/:id/resume` | parked to live, returns a fresh token. |
| `POST /api/talk/sessions/:id/heartbeat` | Refresh `lastSeenAt`. |
| `POST /api/talk/sessions/:id/tools` | `{ intents: string[] }` returns the additional `RealtimeTool[]` to inject plus the new total token cost. Never returns a tool already exposed. |
| `POST /api/talk/sessions/:id/turn` | `{ usage: RealtimeUsage, transcript?, visualReceipts? }` prices the delta including image input, stores bounded public capture telemetry, calls `recordTurnAccounting`, appends to history, applies rolling truncation, returns `{ spendUsd, contextTokens, truncatedTurns, handoffSuggested }`. |
| `POST /api/talk/sessions/:id/actions` | `{ tool, subject, lane, consent, undoOf? }` logs one attempted write, refusals included, and returns the stored record with the id and timestamp the gateway stamped. |
| `POST /api/talk/sessions/:id/control` | Routes one provider call through the manifest. Gateway-target writes require operator authority, reuse the provider call id as the domain idempotency key, re-read authoritative state, and return a verified receipt plus a typed UI effect. |
| `POST /api/talk/sessions/:id/handoff` | `{ prompt }` spawns a normal text Session with the talk session as parent, returns `{ sessionId }`. |
| `GET /api/talk/sessions/:id` | `{ state, openedAt, turns, actions, spendUsd, contextTokens, briefChars, briefTokens, exposedTools }`. |
| `DELETE /api/talk/sessions/:id` | Close. Idempotent. |
| `GET/POST /api/tts` | Moved verbatim out of `gateway/api.ts`. Behaviour unchanged: `GET` returns `{ available, voice }`, `POST` streams length-prefixed WAV frames, 503s when Kokoro is unavailable, 400s on invalid text. |

State is `live`, `parked`, or `closed` (`TalkSessionState` in
`talk/session/types.ts`). `parked` means the browser dropped its provider
connection: the microphone is cold and the provider bills nothing, while the
gateway keeps the turn history and the exposed-tool set. `resume` mints a fresh
token because the old one expires within 600 seconds. `park` on an
already-parked session and `resume` on a live one are 409, not silent no-ops.

Liveness is a heartbeat, never a socket binding. A navigation costs nothing
because nothing tears the session down: `TalkOrbOverlay` is mounted once above
the router, so a route change never unmounts the transport and there is nothing
to re-attach to. Nothing is kept in `sessionStorage` either, and deliberately —
a reload has already lost the peer connection, and re-opening one on load would
put a live microphone and a paid credential behind a page load rather than
behind an operator's gesture. A reload starts a new session. A closed tab stops
heartbeating, and the reaper closes any session whose `lastSeenAt` is older than
`TALK_SESSION_TTL_MS` (90 seconds, three missed 30-second heartbeats) — though
the client sends a `DELETE` on `pagehide` rather than leaving a credential to be
collected ninety seconds later. Talk sessions do not survive a gateway restart,
which is the same death by a blunter instrument.

A parked session keeps heartbeating. Park drops the provider connection, not the
session: the reaper does not read state, so a parked session that stopped beating
would be collected like any other and the history park exists to preserve would
go with it.

---

## The browser half

`packages/web/src/components/talk/transport/` is the client this runtime was
built for. Split so the parts with a rule in them can be tested without a peer
connection:

| File | Owns |
|---|---|
| `session-client.ts` | the HTTP lifecycle: open, 30s heartbeat, park, resume, close, post turn |
| `usage-delta.ts` | running session total to per-turn delta |
| `realtime-events.ts` | one `oai-events` frame to the narrow union the orb acts on |
| `session-driver.ts` | the conversation loop: declare tools, run tool calls, price turns, report orb state |
| `webrtc-connection.ts` | `RTCPeerConnection`, microphone, remote audio, and the orb's level meter |
| `use-talk-session.ts` | the React lifecycle: activate, park on hide, resume on show, close on unload |

**Nothing opens on mount.** `POST /api/talk/sessions` mints a paid credential, so
it happens on the operator activating the orb and on nothing else. The orb's
sphere is the control: a `button` with `aria-pressed`, so it is reachable by
keyboard, and a press that travelled more than a few pixels is a drag rather than
an activation. An open that fails leaves nothing behind — the orb stays idle, the
store stays `null`, and a session that opened but never connected is closed
rather than left for the reaper.

**The SDP exchange goes straight to the provider** at
`https://api.openai.com/v1/realtime/calls`, carrying the ephemeral credential and
no model parameter: the model, voice, and tool scope are bound to the credential
when the gateway mints it, and a browser that could name its own model could name
a dearer one.

**The gateway issues one control manifest.** The browser validates its version,
uses its declarations for every `session.update`, and dispatches by each entry's
target. Navigation, focus, resolution, and the bounded visual fallback execute
in the browser. Company reads and writes post back to `/control`; browser
executors cannot override those names. A successful company write is not spoken
until the gateway re-reads its authoritative store and returns `verified: true`.
Only then does the browser invalidate exact caches and await visible navigation.

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

### Authoritative control manifest

`talk/control/manifest.ts` is the only provider catalog. Each closed schema names
its execution target, mutability, operator requirement, intent, and verification
rule. `talk/session/tools.ts` only projects these entries into provider function
declarations. The open response carries the same manifest to the browser, so a
page update cannot replace it with a second catalog.

Gateway calls are deduplicated by `(talk session id, provider call id)` before
their adapter awaits. The same call and arguments await or replay one receipt;
changed arguments under the same call id fail closed. Domain adapters propagate
that stable key into Todo edits, delegations, and Workflow starts, and every
success is checked by an authoritative re-read. The compatibility `/tools`
endpoint remains idempotent and derives from the manifest rather than owning
another list.

### Authoritative screen context

The orb is told what the operator is actually looking at. `APP_ROUTES` is the
router's canonical manifest, and every route has a matching entry in
`TALK_SURFACE_COVERAGE`; `docs/talk-control-coverage.md` is generated from those
two typed inventories. `TalkContextBridge` combines the location with the
page's existing react-query cache and safe rendered semantics: title, selected
object, relations and retrieval anchor, visible items, controls, focus, and
declared visual gaps. Query-cache changes on an unchanged URL therefore publish
new context. A cold selected object is explicitly `partial` with a named missing
field instead of being invented or fetched behind the operator's back.

Private DOM is excluded from semantic text and image fallback: the orb overlay,
hidden content, explicit secret markers, password inputs, and password-like
autocomplete fields. The plugin wildcard is also honest: until the host SDK can
publish contributed-page semantics it reports `plugin-context-unavailable`
rather than guessing from arbitrary DOM.

**The browser composes `instructions`.** `RealtimeConfig` carries model, voice
and turn detection only, and `createRealtimeProvider` forwards nothing else, so
the provider is never handed instructions at mint time — the browser writes the
whole field on the data channel. It holds two things, in this order: the standing
brief the gateway built at session-open (below), then the live page snapshot. It
is a *replaced* field rather than a conversation item, which is exactly the shape
both want: they cost their length once and are overwritten on the next push,
instead of accumulating down the transcript one page view at a time. That is also
why the brief is re-sent on every push — a push carrying the page alone would
erase it.

**Every push carries the full tool list.** `sendSessionConfig` sends tools and
instructions together rather than relying on the provider to merge one field at a
time — a context push that silently cleared the catalog would take the whole orb
down, and the bytes are on a local data channel.

**Bounded semantic transport.**
`PAGE_CONTEXT_BUDGET_CHARS` is 1200, about 300 tokens at the four-characters-per-token
estimate above, against the 6000-token rolling budget. Instance, route, params and
selection are clipped field by field and always survive; the object list then
takes whatever room is left, one entry at a time, and says `+N more` for what it
dropped. A 400-card board renders in about a dozen entries and stays under the cap.

**Semantic changes only, then debounced.** The context store normalizes semantic
state and increments its revision only when meaning changes; timestamps, fresh
object identities, and reordered maps do not cause a push. The driver then uses
a 400 ms trailing debounce. `driver.stop()` lets go of the store wherever the
connection is dropped.

**Visual fallback is one declared exception.** Workflow graph spatial layout is
marked as a visual-only gap. For a provider user-item id, context revision, and
gap reason, the driver may append exactly one sanitized `input_image`. It clones
only the application root (the portalled orb is outside it), rasterizes at most
1280 by 1280 and 180,000 bytes, and fails closed when the gap was not declared,
structured context is complete, or the raster exceeds the bound. The next turn
stores only public telemetry — dimensions, bytes, estimated image tokens and
latency — while image tokens are priced alongside audio and text. The image
bytes themselves never enter the gateway turn route or Talk history.

### The standing brief

The page snapshot says where the operator is. The brief says what this instance
is, so the orb does not spend its first turn being told what a Workflow is.
`talk/session/brief.ts` builds it once, when the session opens, and the open
response carries it to the browser alongside the credential.

**Everything instance-specific is read at runtime.** The company name and Todo
prefix come from `config.portal` through the same `resolveTodoIdPrefix` the Todo
store uses; the roster comes from `scanOrg` resolved through
`resolveOrgHierarchy`. Nothing about any particular operator, company or project
is compiled in — the module's own text is the posture, what Jinn is, the blocks
glossary, and the eight Todo statuses.

**Bounded, and the roster is the only part that gives ground.**
`TALK_BRIEF_BUDGET_CHARS` is 3000. The four doctrine sections are fixed-size, and
the roster steps down a ladder to fit whatever room is left: `full` is one row per
employee with their reporting line, `summary` is one row per department with its
headcount and leaders, and `counts` is a single headcount line naming as many
departments as fit. An org with no employees at all reports `empty` and the
section is simply absent. A large org therefore loses employee rows before it
loses the glossary, because an orb that can name three hundred people but cannot
say what a Workflow is has kept the wrong half.

**It is not in the turn budget.** `GET /api/talk/sessions/:id` reports
`briefChars` and `briefTokens` next to `contextTokens`, but the brief rides
`instructions`, which the provider replaces rather than accumulates.
`TALK_CONTEXT_BUDGET_TOKENS` meters the turn transcript, which is the thing that
grows, and truncation is unaffected by the brief.

**It does not change under a live session.** The org is scanned once at open. A
hire made mid-conversation reaches the next session, not this one; re-reading it
per heartbeat would pay for a roster that is stable in practice.

### The consent policy

Voice is a lossy consent channel: a transcription error and a spoken sentence are
the same bytes by the time a tool call arrives. So every write tool sits in one
of two lanes, and the line between them is that **the fast lane requires a
reversal that actually exists and costs nothing to take.** Where an action is
usually reversible but this instance of it has no reversal, it falls back to the
consent lane rather than shipping an undo that lies.

| Tool | Lane | Why | Reversal |
|---|---|---|---|
| `talk_comment_todo` | fast | Internal, cheap, fully reversible. | Tombstone the comment. |
| `talk_create_todo` | fast | Creates a draft nobody has acted on yet. | Archive it — the row and its audit survive. |
| `talk_set_todo_status` | fast **only when the board can move it back, and only out of a status that is not `blocked`** | A status move is a board gesture, but the edge map is one-way in places: nothing returns from `done` except to `backlog`, and `executing`/`in_review` have no edge back to where work started. `cancelled` asks whatever the edges say — closing work is not a gesture, and agents have no cancel tool server-side. Leaving `blocked` asks whatever the edges say too: `blocked → assigned` is a reversible edge, so the fast lane would have taken "move it to assigned" on the model's word, and that sentence is an unblock. | Re-`PUT` the previous status. When `canDropOn(to, from)` is false, or the Todo is leaving `blocked`, the move takes the consent lane and gets no undo, which is why it asks. |
| `talk_assign_todo` | fast | Internal, idempotent, reversible. | Re-assign (or clear the assignee through the version-fenced edit lane), then put the status back — assigning out of `backlog` moves the item too. |
| `talk_label_todo` | fast | Full-set replace, idempotent by construction. | `PUT` the previous set. |
| `talk_start_workflow_run` | consent | Spends money and wakes agents the moment it starts. Cancelling later un-bills nothing. | None. |
| `talk_record_reading` | consent | No delete route and no way to edit: a wrong reading corrupts a measurement series permanently. | None — which is exactly why it cannot be fast. |
| `talk_send_to_session` | consent | Outward-facing. Whoever is on the session may act on the world before any window could close. | None. |
| `jinn_action` | consent, always | The least predictable surface: the model reaches it when it has stopped matching a request to anything the app can do. | None. |
| `talk_decide_approval` | consent | An outward-facing decision: whatever was waiting on the gate moves the moment it lands, and the gateway has no route that un-decides one. | None. |
| `talk_decide_workflow_approval` | consent | Approving the node a run waits on lets the run carry on — on a land gate, that merges a branch. | None. |
| `talk_unblock_todo` | consent | Unblocking releases the work to whoever picks it up; a fifteen-second window does not reach the agent that already started. | None. |
| `click_by_text` | consent | The orb cannot see what a control does before it does it, so what it agrees to is the click, not the consequence. | None. |
| `type_into` | consent | Replaces what is in the field, on a page whose save semantics the orb does not know. | None — the previous contents are not read back first. |
| `find_element_by_text` | consent | Read-only, and asks anyway: it is how the model learns what a generic click would land on, and a probe that costs nothing to make is a probe worth making silently. Asking to look is a deliberate over-ask, and the one lane assignment here worth revisiting. | Nothing to reverse. |
| `scroll_to` | consent | Read-only, and asks for the same reason as `find_element_by_text`. | Nothing to reverse. |

A dismissal is a refusal, not a failure — it reports `{ ok: false, error }` so a
model cannot read "the operator said no" as a transport error and retry it. The
fast lane's window is `UNDO_WINDOW_MS` (15 seconds), and letting it lapse commits
the write silently.

### Driving the page directly

The four generic actions exist so the orb can reach a feature nobody wrote a tool
for. That makes them the least bounded thing it has — the model decides what they
mean by reading words off a screen — so `dom-target.ts` is where the bound is,
and every rule in it is there because the alternative is a class of silent wrong
action:

- **Text is compared, never compiled.** An element matches on what it says —
  `aria-label`, `placeholder`, its own `value`, its text — case-insensitively and
  with whitespace collapsed. A spoken string never becomes a CSS selector, for the
  same reason `focus_element` refuses one: a model naming a selector is addressing
  internals it cannot see, and a selector it got slightly wrong acts on the wrong
  thing without saying so. An exact match beats a containing one, so "Save" reaches
  Save on a page that also has "Save and close".
- **Two matches is a refusal.** The refusal names the candidates and asks the
  operator which they meant. It never takes the first: on a voice channel there is
  no way for them to notice that a silent pick was the wrong one. Ancestors are not
  counted as candidates — every element up to `<body>` contains the text, and a
  page is not ambiguous because it has a body.
- **Click and type only reach controls.** `button`, `a[href]`, `input`, `textarea`,
  `select`, `[role="button"]` and `contenteditable`. Text that merely reads like a
  button is reported as text.
- **The orb's own surface is not addressable.** Anything inside
  `[data-situation-phase]`, `[data-talk-undo-strip]` or `[data-talk-orb-overlay]`
  is invisible to the resolver. Without that, a generic click could answer or
  dismiss the very consent card raised to ask about it, and the sheet would be
  decoration.
- **Nothing runs while a situation is up.** The check comes before the resolver, so
  a generic action cannot act on a page the operator is being asked a question
  about — including the question that action itself provoked.
- **A password field is never typed into.** A spoken password is said out loud in a
  room, transcribed by a third party and typed by a model; no page needs that.
- **The element has to still be there.** Consent is asked about an element resolved
  before the sheet went up, so the write re-checks that it is still on the page.
  A page that rerendered it away reports that, rather than clicking into nothing.

### What voice still cannot reach

The board has verbs the orb has no tool for. They are listed rather than built,
because each needs a decision this pass did not make:

| Verb | Why it was left |
|---|---|
| Request an approval | No web client method exists at all — the request surface is a gateway route and an MCP tool. Adding a client method is its own ticket. |
| Escalate an approval | `escalateWorkItemApproval` exists but has no non-test caller in the web app, so voice would be the only way to reach it and there is no de-escalate. |
| Archive a Todo | No unarchive anywhere in the client or the gateway, so it has no honest reversal — it is reachable only as `talk_create_todo`'s own undo, on a Todo made seconds earlier. |
| Link / unlink Todos | Reversible, but naming two Todos in one spoken sentence needs the resolver to disambiguate twice; that is a design question, not a wiring one. |
| Dispatch a Todo | Spawns a live session — outward-facing with no reversal, and the same shape as `talk_start_workflow_run`, which is the tool to copy when it is built. |
| Attachments | There is nothing to attach in a voice turn. |
| Edit priority, due date, title or body | The version-fenced edit lane needs an `expectedVersion` and a conflict story the orb has no surface for. |
| Edit a comment | Talk can leave a comment and take it back, but not amend one; the prior text is not retained, so there is no reversal. |
| Cron: trigger, enable, disable | `triggerCronJob` has no reversal. There is no create or delete route in the client at all, for the board either. |
| Workflow: enable, disable, author | Revision-fenced, same conflict story as the edit lane; authoring a graph is not a voice shape. |
| Conclude an experiment | No reopen route — a verdict is permanent, like a reading. |
| Stop or reset a session | Reset destroys transcript state with no way back. |

### The action log

`POST /api/talk/sessions/:id/actions` records one entry per *attempted* write,
and the word attempted is the whole point. A write the operator waved off in the
consent sheet changes nothing and reaches the gateway through no other route, so
without this entry the refusal would be the one decision the audit could not
show. Each record carries the tool, the subject it acted on (`null` for a tool
with no single subject), its `lane` (`fast` or `consent`), and its `consent`
(`not-required` for the fast lane's undo-backed default, or the operator's actual
`granted` / `refused`).

The log is append-only. A reversal is a new entry whose `undoOf` names the id of
the entry it undoes, rather than a flag set on the original, because a record
that can be amended after the fact is not a record. `undoOf` must name an entry
this session already logged; an undo of nothing is a client bug and answers 400.

`id` and `at` are stamped by the registry and a body carrying either is ignored,
for the same reason comment authorship is stamped server-side: a caller that can
name and date its own entry can forge one over an earlier one. The list is capped
at `TALK_ACTION_LOG_LIMIT` (500) and drops oldest first — a bound on a runaway
client, not on the audit, since no spoken conversation comes near it. `GET
/api/talk/sessions/:id` returns the log alongside `turns`.

**How long it lasts, stated plainly, because the word "audit" invites the wrong
assumption.** The log is a list on a `TalkSession`, and a `TalkSession` is an
entry in an in-memory `Map` — so the log lives exactly as long as the session
does: it goes when the session is closed or reaped, and it goes with the gateway
process. Nothing writes it to disk. The browser posts into it for exactly as
long as a session is open: `transport/use-talk-session.ts` calls
`setTalkSessionId` when `POST /api/talk/sessions` returns one, the store hands
that id down to the surface, and the surface binds `talk-action-log.ts` to it.
Outside a session — on the orb bench, or between sessions — the id is `null` and
every entry the orb records stays in page memory and reaches no gateway.

What survives independently of any of this is the write itself: a talk-issued
work-item mutation carries `origin: "talk"` in the persisted work-item event log
(`X-Jinn-Origin`, above). The action log adds the things that log cannot hold —
consent decisions, and refusals, which by definition touch nothing.

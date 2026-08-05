# ICI-688 — Unicode attachment filenames break, and the message renders twice

## The bug, in one paragraph

`packages/jinn/src/gateway/files.ts` builds its multipart parsers without
`defParamCharset`. Busboy then falls back to latin-1 for header parameters, so the UTF-8
filename the browser sends in `Content-Disposition` is decoded as latin-1 and persisted as
mojibake (`тест документ.pdf` → `ÑÐµÑÑ Ð´Ð¾ÐºÑÐ¼ÐµÐ½Ñ.pdf`).

That one defect produces both symptoms the operator reported:

- **Broken symbols** — the stored filename is mojibake.
- **Double message** — `messageIdentityKey` in `packages/web/src/lib/conversations.ts:54`
  fingerprints a message by `x.name || x.type || x.url`. The optimistic bubble carries the
  correct Unicode name, the persisted row carries the mojibake name, the two keys differ, so
  reconciliation never matches them and both render. A reload drops the optimistic one.

File **contents** are never touched — only the header parameter is misdecoded. The tests
below assert that explicitly rather than assuming it.

## Scope decision: all three parsers, not one

`files.ts` constructs Busboy three times, all with the same defect:

| Line | Function | Lane |
| --- | --- | --- |
| 789 | `readMultipartFile` | Todo attachments (`api.ts:4425`) |
| 872 | `handleMultipartUpload` | `POST /api/files` — the chat lane the operator hit |
| 1267 | `handleAttachmentMultipart` | `POST /api/sessions/:id/attachments` — agent `publish_attachment` |

The previous round fixed line 872 only and handed the other two back. The operator's ask is
"can we not break the file names & content if possible" — three instances of one defect, in
one file, each fixed by the same single option. Fixing one and leaving two identical
landmines is more moving parts, not fewer. This is stated here so the expansion is explicit,
not silent (jinn-taste §4).

## Change

1. `packages/jinn/src/gateway/files.ts` — add `defParamCharset: "utf8"` to the Busboy
   constructions at lines 789 and 1267. Line 872 already carries it from `0db6bcf8`.
2. `packages/jinn/src/gateway/__tests__/file-read.test.ts` — extend with a lane test per
   parser, mirroring the existing `postMultipartFile` helper.
3. `packages/web/src/lib/__tests__/reconcile-messages.test.ts` — the single-row
   reconciliation regression (already present from `0db6bcf8`).

Prove each lane through the narrowest **real** entry point that actually constructs the
parser. Do not build new test harness scaffolding: if a lane cannot be reached without new
infrastructure, still apply the fix and say so plainly, with RED/GREEN proof on the lanes
that are reachable.

## Acceptance criteria

1. `POST /api/files` with filename `тест документ.pdf` returns 201 and the filename is
   byte-identical in the response body, in the file registry row, and as the on-disk entry.
2. The uploaded bytes are identical on disk, including non-UTF-8 bytes
   (`00 ff 80 …`) — contents are provably untouched.
3. `readMultipartFile` (Todo-attachment lane) returns that filename unmangled.
4. `POST /api/sessions/:id/attachments` (agent publish lane) persists that filename
   unmangled.
5. `reconcileMessages` collapses an optimistic + persisted user message carrying that
   filename to exactly **one** row.
6. **RED proof.** With `defParamCharset: "utf8"` removed from all three sites, the tests for
   (1), (3) and (4) fail showing mojibake; restored, they pass. Both outputs pasted verbatim
   into the Todo.
7. **Leak-grep is diff-scoped.** `git diff <baseHead>..HEAD -- packages` matched against
   `hristo|jimmyenglish|pravko|movekit|sqlnoir|homy|spycam|asomaniac|kiwilabs|tucker@|/Users/`
   returns **zero** matches.
8. `pnpm typecheck`, `pnpm build` and `pnpm test` pass on a clean worktree; tails pasted.

## Explicitly out of scope

- **Pre-existing whole-tree leak-grep matches.** The 23 whole-tree hits are all present
  unchanged on `main`: the `hristo2612` GitHub/brew handle, which `skills/jinn-platform`
  names as an explicitly OK hit, and generic placeholder paths (`/Users/x`, `/Users/test`,
  `/Users/you`) in test fixtures and `TESTING.md`. None originate here. Round 1 blocked on a
  whole-tree reading of this criterion; criterion 7 is diff-scoped for that reason, matching
  the rule as actually written in `CLAUDE.md` ("leak-grep your **staged diff**"). Treating
  pre-existing `main` content as this task's Blocker is out of scope.
- **Forward-only.** Filenames already persisted as mojibake stay mojibake. No migration, no
  backfill.
- No change to file **content** handling, storage layout, or the 50 MB ceiling.
- No UI or design change. Nothing visual moves, so `skills/jinn-design` does not apply and no
  screenshot gate is owed.
- RFC 5987 `filename*` handling beyond what Busboy already does.

## Verification

- Focused: the gateway lane tests and the web reconciliation test.
- Full gates: `pnpm typecheck`, `pnpm build`, `pnpm test` after the final commit, worktree
  clean.
- Manual: optional CLI check on a `jinn-sandbox` instance (port 7778+) — upload a
  Cyrillic-named file, read the registry row back. **Never port 7777, never 7788, never
  `~/.jinn`.** Destroy the sandbox afterwards even if the run failed.

## Base

- Branch: `build/ICI-688-unicode-attachment-filenames`
- Worktree: `~/Projects/.worktrees/jinn-build-ICI-688`
- Base: `main` @ `7051685598e9044eebd962bc0be78b4d178dc52a`, merged in at plan time.
  `files.ts` auto-merged cleanly; only this file conflicted.

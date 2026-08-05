# ICI-688 — Unicode attachment filenames (duplicate message + mojibake)

**Branch:** `build/ICI-688-unicode-attachment-filenames`
**Base:** `698c1e98127989af6e0ecff9030855a6d116c76c` (main)
**Mode:** direct · **Complexity:** standard

## Operator feedback driving this round

> "check if it was merged to main. merge if it wasn't & provide a comment."
> — operator note on ICI-688, 2026-08-05T11:39:25Z

**Answer, established before planning:** it was NOT merged. The fix lives only on
`fix/ici-688-unicode-attachments` @ `0db6bcf8`, which is not reachable from `main`
(`git branch --contains 0db6bcf8` → that branch only). So this round's job is to land it,
re-proven against current `main`, not to redesign it.

## The bug, confirmed in code (not taken on trust)

Both reported symptoms have one cause.

1. `packages/jinn/src/gateway/files.ts:870` — `handleMultipartUpload` (the `POST /api/files`
   lane the browser chat composer uploads through) constructs Busboy without
   `defParamCharset`. Busboy's default is `latin1`. Browsers send the
   `Content-Disposition` `filename` parameter as raw UTF-8 bytes, so a Cyrillic filename is
   decoded byte-per-char and persisted as mojibake. → **symptom 2 (broken symbols)**.
2. `packages/web/src/lib/conversations.ts:47` — `messageIdentityKey` fingerprints media on
   `x.name`, i.e. the filename. The optimistic row carries the correct UTF-8 name from the
   browser `File`; the persisted row carries the mojibake name. Keys differ, so
   `reconcileMessages` does not collapse them and the optimistic row survives in `pending`
   (lines 131-139). → **symptom 1 (two messages)**. A reload drops the optimistic row, which
   is exactly what the operator observed.

File *bytes* were never affected — only the filename parameter is charset-decoded. The
regression test asserts this rather than assuming it.

## Change

Reuse the existing verified commit; do not re-derive it.

1. Merge `fix/ici-688-unicode-attachments` (`0db6bcf8`) into this branch. Verified
   conflict-free: none of its three files changed on `main` since merge-base
   `27b6a213`. If a conflict appears anyway, stop and report — do not resolve blind.
   - `packages/jinn/src/gateway/files.ts` — one word: `defParamCharset: "utf8"`.
   - `packages/jinn/src/gateway/__tests__/file-read.test.ts` — route-level regression:
     multipart POST with a Cyrillic filename; asserts the persisted `filename` is byte-identical
     to what was sent AND the stored bytes are unchanged.
   - `packages/web/src/lib/__tests__/reconcile-messages.test.ts` — regression: an optimistic +
     persisted pair carrying that filename reconciles to exactly one row.
2. Replace the test fixture filename `"ЕСИФ фиксирана лихва.pdf"` (both test files) with a
   neutral Cyrillic string, e.g. `"тест документ.pdf"`. The fixture is arbitrary; the current
   value reads like a real personal financial document and `packages/**` ships to npm. §3
   privacy hygiene, zero functional cost.
3. Re-prove RED→GREEN on current `main`: revert the one word, watch the gateway test fail with
   mojibake, restore it, watch it pass. A regression test that never failed proves nothing.

## Acceptance criteria

1. `POST /api/files` with `Content-Disposition` filename `"тест документ.pdf"` (UTF-8 bytes)
   returns `filename` exactly equal to the sent string, and `registry.getFile(id).filename`
   equals it too — no mojibake, no replacement chars.
2. The bytes of that upload on disk are byte-identical to the bytes sent, including
   non-UTF-8-decodable bytes (`0x00`, `0xff`, `0x80`).
3. `reconcileMessages` collapses an optimistic + persisted user message pair whose media share
   that Cyrillic filename to exactly **one** row, keeping the optimistic id and the canonical
   `/api/files/` url.
4. Temporarily reverting `defParamCharset: "utf8"` makes criterion 1 fail; restoring it makes
   it pass. Both outputs pasted in the report.
5. No new string under `packages/**` matches the privacy leak pattern from the brief, and no
   real-document-looking fixture remains.
6. `pnpm typecheck`, `pnpm build`, and full `pnpm test` pass from a clean worktree, run after
   the final edit. Verbatim tails in the report.

## Out of scope — written down and handed back, per taste §4

- **Two sibling multipart parsers have the identical defect and are NOT fixed here:**
  `readMultipartFile` (`files.ts:787`, shared helper — Todo/work-item attachments) and
  `handleAttachmentMultipart` (`files.ts:1264`, `POST /api/sessions/:id/attachments`, the
  agent-push lane behind `publish_attachment`). Both still default to `latin1`, so a Cyrillic
  filename mojibakes there too. The operator asked for a KISS fix to the two reported chat
  symptoms; these are adjacent, so they get reported, not silently swept in. Recommend a
  follow-up Todo.
- **Filenames already persisted as mojibake are not repaired.** Forward-only; no data
  migration, no backfill.
- No change to `messageIdentityKey` or the reconcile algorithm. It is correct given a correct
  filename; the fix is upstream of it.
- Note the test seam honestly: criterion 3 exercises `reconcileMessages` in isolation with a
  correct name on both sides. It guards the collapse rule, it does not prove the end-to-end
  browser flow. Criterion 1 is what proves the name arrives correct. No browser QA is planned —
  this change has no visual surface, so the design gate does not apply.

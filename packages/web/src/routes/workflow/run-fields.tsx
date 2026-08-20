import { AttachmentRefs, AttachmentRefText, attachmentRefsOf } from "@/components/attachment-ref-preview"

function formatFieldValue(value: unknown): string {
  if (typeof value === "string") return value
  return JSON.stringify(value) ?? String(value)
}

/** A field holding attachment refs is something to look at, not a token to
 *  read. Every other value keeps its text rendering. */
function FieldValue({ value }: { value: unknown }) {
  const refs = attachmentRefsOf(value)
  if (refs) return <AttachmentRefs refs={refs} />
  if (typeof value === "string") return <AttachmentRefText text={value} />
  return <>{formatFieldValue(value)}</>
}

/** A node run's declared output, one row per field. */
export function FieldsTable({ fields }: { fields: Record<string, unknown> }) {
  const entries = Object.entries(fields)
  if (entries.length === 0) return null
  return (
    <div className="overflow-hidden rounded-[10px] bg-[var(--fill-quaternary)]">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-3 border-b border-[var(--separator)] px-3 py-2 last:border-b-0">
          <span
            className="w-[92px] shrink-0 truncate pt-px text-[length:var(--text-caption1)] text-[var(--text-tertiary)]"
            style={{ fontFamily: "var(--font-code)" }}
          >
            {key}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[length:var(--text-caption1)] text-[var(--text-primary)]">
            <FieldValue value={value} />
          </span>
        </div>
      ))}
    </div>
  )
}

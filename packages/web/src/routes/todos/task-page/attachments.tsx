import { useRef } from "react"
import { FileText, Image as ImageIcon, Paperclip, X } from "lucide-react"
import { api, type WorkItemAttachmentWire } from "@/lib/api"
import { AttachmentTile, isImageMime, useAttachmentPreview } from "./attachment-preview"

/* Todos v2 — attachments are one quiet action under the description, not a
 * titled section: a paperclip that opens the picker, and whatever is already
 * attached riding beside it as chips. Previewable files reuse the same dense
 * tile the activity feed renders, so the page speaks one visual language about
 * an attachment wherever it appears. Item-level only — comment-level
 * attachments belong to their comment in the feed (ICI-1438). */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function AttachmentsSection({
  attachments,
  onUpload,
  onRemove,
}: {
  attachments: WorkItemAttachmentWire[]
  onUpload: (files: File[]) => void
  onRemove: (attachment: WorkItemAttachmentWire) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const preview = useAttachmentPreview()
  const itemLevel = attachments.filter((attachment) => attachment.commentId === null)
  const previewable = itemLevel.filter((attachment) => preview.canPreview(attachment))

  const removeButton = (attachment: WorkItemAttachmentWire, className: string) => (
    <button
      type="button"
      aria-label={`Remove ${attachment.filename}`}
      data-testid={`attachment-remove-${attachment.id}`}
      onClick={() => onRemove(attachment)}
      className={`focus-ring grid place-items-center opacity-0 outline-none transition-opacity focus-visible:opacity-100 ${className}`}
    >
      <X size={12} strokeWidth={2.2} aria-hidden />
    </button>
  )

  return (
    <section data-testid="task-attachments" className="mt-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        aria-label="Attach a file"
        data-testid="attachment-add"
        onClick={() => inputRef.current?.click()}
        className="focus-ring -ml-2 grid size-[34px] flex-none place-items-center rounded-[10px] text-[var(--text-quaternary)] outline-none transition-colors hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)]"
      >
        <Paperclip size={15} strokeWidth={1.8} aria-hidden />
      </button>
      {itemLevel.length > 0 && (
        <div data-testid="attachment-strip" className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {itemLevel.map((attachment) =>
            preview.canPreview(attachment) ? (
              <AttachmentTile
                key={attachment.id}
                attachment={attachment}
                preview={preview}
                gallery={previewable}
                dense
                action={removeButton(
                  attachment,
                  "absolute right-1.5 top-1.5 size-[26px] rounded-full bg-[var(--material-thick)] text-[var(--text-secondary)] shadow-[var(--shadow-subtle)] backdrop-blur-[20px] hover:text-[var(--text-primary)] group-hover/tile:opacity-100",
                )}
              />
            ) : (
              <div
                key={attachment.id}
                className="group/att flex h-10 items-center gap-2 rounded-[10px] bg-[var(--fill-tertiary)] px-2 shadow-[var(--shadow-ambient)]"
              >
                <a
                  href={api.workItemAttachmentUrl(attachment.workItemId, attachment.id)}
                  download={attachment.filename}
                  data-testid={`attachment-chip-${attachment.id}`}
                  aria-label={`Download ${attachment.filename}`}
                  className="focus-ring flex min-w-0 items-center gap-2 rounded-lg outline-none"
                >
                  <span className="grid size-6 flex-none place-items-center rounded-[7px] bg-[var(--fill-secondary)] text-[var(--text-tertiary)]">
                    {isImageMime(attachment.mime) ? <ImageIcon size={12} strokeWidth={1.8} aria-hidden /> : <FileText size={12} strokeWidth={1.8} aria-hidden />}
                  </span>
                  <span className="max-w-[160px] truncate text-[12.5px] font-medium text-[var(--text-primary)]">{attachment.filename}</span>
                </a>
                {removeButton(attachment, "size-6 flex-none rounded-md text-[var(--text-quaternary)] hover:text-[var(--text-secondary)] group-hover/att:opacity-100")}
              </div>
            ),
          )}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        aria-hidden
        data-testid="attachment-file-input"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ""
          if (files.length > 0) onUpload(files)
        }}
      />
      {preview.lightbox}
    </section>
  )
}

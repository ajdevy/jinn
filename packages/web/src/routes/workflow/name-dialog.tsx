import { useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"

/** Both workflow dialogs end in the same pair — a quiet Cancel beside a filled
 *  action — and they are shared so the pair keeps one height. They drifted apart
 *  at 32px, under the 34px tap target a phone needs. */
export const DIALOG_CANCEL_CLASS =
  "h-[34px] rounded-full px-3.5 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] hover:bg-[var(--fill-tertiary)]"
export const DIALOG_ACTION_CLASS =
  "h-[34px] rounded-full bg-[var(--accent)] px-3.5 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] disabled:opacity-50"

/** Workflow IDs are lowercase slugs — derive one from the human title. */
export function slugFromTitle(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 64)
  return slug || "workflow"
}

function DialogButtons({ onCancel, submitLabel, pendingLabel, pending, disabled }: {
  onCancel: () => void
  submitLabel: string
  pendingLabel: string
  pending: boolean
  disabled: boolean
}) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        className={DIALOG_CANCEL_CLASS}
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={disabled || pending}
        className={DIALOG_ACTION_CLASS}
      >
        {pending ? pendingLabel : submitLabel}
      </button>
    </div>
  )
}

function NameForm({ initialTitle, error, onCancel, onSubmit, ...labels }: {
  initialTitle: string
  submitLabel: string
  pendingLabel: string
  error: unknown
  pending: boolean
  onCancel: () => void
  onSubmit: (input: { id: string; title: string }) => void
}) {
  const [title, setTitle] = useState(initialTitle)

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (title.trim()) onSubmit({ id: slugFromTitle(title), title: title.trim() })
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Workflow title"
        aria-label="Workflow title"
        className="mt-1 h-9 w-full rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--fill-quaternary)] px-3 text-[length:var(--text-subheadline)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus-visible:border-[var(--accent)] focus-visible:ring-[3px] focus-visible:ring-[var(--accent-fill)]"
      />
      {title.trim() && (
        <p className="mt-1.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]" style={{ fontFamily: "var(--font-code)" }}>
          {slugFromTitle(title)}
        </p>
      )}
      {error != null && (
        <p role="alert" className="mt-2 text-[length:var(--text-caption1)] text-[var(--system-red)]">
          {error instanceof Error ? error.message : "Could not save the workflow."}
        </p>
      )}
      <DialogButtons onCancel={onCancel} disabled={!title.trim()} {...labels} />
    </form>
  )
}

/** Naming a Workflow: once when it is created, once when it is copied. Both need
 *  the same title field, derived-slug preview, and inline failure — an ID already
 *  in use is the answer the operator has to see before the dialog closes.
 *
 *  The form is mounted only while the dialog is open, so reopening it offers the
 *  suggested name again rather than whatever the last attempt was left holding. */
export function WorkflowNameDialog({ open, onClose, heading, description, initialTitle = "", ...form }: {
  open: boolean
  onClose: () => void
  heading: string
  description: string
  initialTitle?: string
  submitLabel: string
  pendingLabel: string
  error: unknown
  pending: boolean
  onSubmit: (input: { id: string; title: string }) => void
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="max-w-[380px]">
        <DialogTitle>{heading}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        {open && <NameForm initialTitle={initialTitle} onCancel={onClose} {...form} />}
      </DialogContent>
    </Dialog>
  )
}

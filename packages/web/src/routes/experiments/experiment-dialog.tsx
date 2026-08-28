import { Dialog as DialogPrimitive } from "radix-ui"

const CARD_CLASS = "fixed inset-x-3 bottom-3 z-50 max-h-[calc(100dvh-24px)] overflow-y-auto rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] px-5 py-5 pb-[max(20px,env(safe-area-inset-bottom))] shadow-[var(--shadow-overlay)] outline-none motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:slide-in-from-bottom-3 sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[min(460px,calc(100vw-32px))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:px-6 sm:py-6 sm:motion-safe:data-[state=open]:zoom-in-95"

function DialogActions({
  submitLabel,
  submittingLabel,
  submitting,
  canSubmit,
  testId,
  onClose,
}: {
  submitLabel: string
  submittingLabel: string
  submitting: boolean
  canSubmit: boolean
  testId: string
  onClose: () => void
}) {
  return (
    <div className="mt-6 flex items-center justify-end gap-2">
      <button
        type="button"
        disabled={submitting}
        onClick={onClose}
        className="focus-ring min-h-11 rounded-full px-4 text-[length:var(--text-subheadline)] font-medium text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--fill-secondary)] disabled:opacity-40"
      >
        Cancel
      </button>
      <button
        type="submit"
        data-testid={`${testId}-submit`}
        disabled={!canSubmit || submitting}
        className="focus-ring min-h-11 rounded-full bg-[var(--accent)] px-5 text-[length:var(--text-subheadline)] font-semibold text-[var(--accent-contrast)] outline-none transition-transform hover:scale-[0.98] disabled:opacity-40" // jinn-shell: ok dialog submit, not page chrome
      >
        {submitting ? submittingLabel : submitLabel}
      </button>
    </div>
  )
}

/**
 * The chrome shared by the two experiment actions: a centred card on desktop, a
 * sheet on mobile. Radix owns focus trapping, scroll lock, Escape and focus
 * restoration; the caller owns the fields and what submitting them means.
 *
 * A failed submit keeps the dialog open and shows the gateway's own words, so a
 * rejected value can be corrected in place instead of retyped from scratch.
 */
export function ExperimentDialog({
  title,
  error,
  testId,
  onSubmit,
  onClose,
  children,
  ...actions
}: {
  title: string
  submitLabel: string
  submittingLabel: string
  submitting: boolean
  canSubmit: boolean
  error: string | null
  testId: string
  onSubmit: () => void
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open && !actions.submitting) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[var(--scrim)] motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:fade-out-0 motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content data-testid={testId} aria-describedby={undefined} className={CARD_CLASS}>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (actions.canSubmit && !actions.submitting) onSubmit()
            }}
          >
            <DialogPrimitive.Title className="text-[length:var(--text-headline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
              {title}
            </DialogPrimitive.Title>
            <div className="mt-4 space-y-4">{children}</div>
            {error && (
              <div
                data-testid={`${testId}-error`}
                className="mt-4 rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-3 py-2 text-[length:var(--text-footnote)] text-[var(--system-red)]"
              >
                {error}
              </div>
            )}
            <DialogActions {...actions} testId={testId} onClose={onClose} />
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function DialogField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[0.1em] text-[var(--text-quaternary)]">
        {label}
      </div>
      <div className="mt-1.5">{children}</div>
    </div>
  )
}

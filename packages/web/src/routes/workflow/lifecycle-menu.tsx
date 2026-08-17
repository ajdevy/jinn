import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Archive, ArchiveRestore, Copy, EllipsisVertical, MoreHorizontal, Pause, Play } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SESSION_MENU_CONTENT_CLASS,
  SESSION_MENU_ITEM_CLASS,
  SESSION_MENU_SEPARATOR_CLASS,
} from "@/components/chat/session-row-menu"
import { api, type WorkflowDefinitionV2Wire } from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"
import { WorkflowNameDialog } from "./name-dialog"

/** What a lifecycle action needs to know about its Workflow. The list row and the
 *  editor header both already hold every field, so neither has to fetch. */
export interface LifecycleWorkflow {
  id: string
  title: string
  enabled: boolean
  retiredAt: string | null
  revision: number
}

type LifecycleAction = "enable" | "disable" | "archive" | "unarchive"

/** The row grammar is the chat sidebar's: an always-visible `⋯` at a 44pt target,
 *  because a hover-only affordance does not exist on a phone. The header grammar
 *  is the Todo crumb bar's, which is what sits beside controls of that size. */
const TRIGGER_CLASS = {
  row: "flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
  header: "focus-ring grid size-[34px] flex-none place-items-center rounded-[10px] text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)]",
} as const

function ArchiveConfirmDialog({ title, open, onCancel, onConfirm, pending }: {
  title: string
  open: boolean
  onCancel: () => void
  onConfirm: () => void
  pending: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent className="max-w-[380px]">
        <DialogTitle>Archive “{title}”?</DialogTitle>
        <DialogDescription>
          It stops running and leaves the list. Its runs are kept, and you can unarchive it at any time.
        </DialogDescription>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 rounded-full px-3.5 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] hover:bg-[var(--fill-tertiary)]"
          >
            Cancel
          </button>
          <button
            type="button"
            autoFocus
            disabled={pending}
            onClick={onConfirm}
            className="h-8 rounded-full bg-[var(--accent)] px-3.5 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] disabled:opacity-50"
          >
            {pending ? "Archiving…" : "Archive"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function LifecycleItems({ enabled, retired, onAction, onDuplicate }: {
  enabled: boolean
  retired: boolean
  onAction: (action: LifecycleAction) => void
  onDuplicate: () => void
}) {
  return (
    <>
      {!retired && (
        <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={() => onAction(enabled ? "disable" : "enable")}>
          {enabled ? <Pause aria-hidden /> : <Play aria-hidden />}
          {enabled ? "Disable" : "Enable"}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={onDuplicate}>
        <Copy aria-hidden />
        Duplicate…
      </DropdownMenuItem>
      <DropdownMenuSeparator className={SESSION_MENU_SEPARATOR_CLASS} />
      <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={() => onAction(retired ? "unarchive" : "archive")}>
        {retired ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
        {retired ? "Unarchive workflow" : "Archive workflow"}
      </DropdownMenuItem>
    </>
  )
}

/** Every write carries the revision the caller is holding, so a Workflow that moved
 *  underneath comes back as a 409 rather than overwriting the other change. */
function useLifecycleWrites(workflow: LifecycleWorkflow, settled: () => void,
  onChanged: ((definition: WorkflowDefinitionV2Wire) => void) | undefined, onFailure: (error: unknown) => void) {
  const queryClient = useQueryClient()
  const cache = (saved: WorkflowDefinitionV2Wire) => {
    settled()
    queryClient.setQueryData(queryKeys.workflows.definition(saved.id), saved)
    void queryClient.invalidateQueries({ queryKey: queryKeys.workflows.all })
  }

  const lifecycle = useMutation({
    mutationFn: (action: LifecycleAction) =>
      action === "archive" || action === "unarchive"
        ? api.setWorkflowRetiredV2(workflow.id, action === "archive", workflow.revision)
        : api.setWorkflowEnabledV2(workflow.id, action === "enable", workflow.revision),
    onSuccess: (saved) => { cache(saved); onChanged?.(saved) },
    onError: onFailure,
  })
  // A duplicate is a different Workflow, so it never reaches `onChanged` — handing
  // it to a caller holding this one would swap it out from under the operator.
  const duplicate = useMutation({
    mutationFn: (input: { id: string; title: string }) => api.duplicateWorkflowV2(workflow.id, input),
    onSuccess: cache,
  })
  return { lifecycle, duplicate }
}

function LifecycleDialogs({ workflow, dialog, onClose, onArchive, archiving, duplicating, duplicateError, onDuplicate }: {
  workflow: LifecycleWorkflow
  dialog: "archive" | "duplicate" | null
  onClose: () => void
  onArchive: () => void
  archiving: boolean
  duplicating: boolean
  duplicateError: unknown
  onDuplicate: (input: { id: string; title: string }) => void
}) {
  return (
    <>
      <ArchiveConfirmDialog
        title={workflow.title}
        open={dialog === "archive"}
        onCancel={onClose}
        onConfirm={onArchive}
        pending={archiving}
      />
      <WorkflowNameDialog
        open={dialog === "duplicate"}
        onClose={onClose}
        heading="Duplicate workflow"
        description="The copy starts disabled, at revision 1, with no run history."
        initialTitle={`Copy of ${workflow.title}`}
        submitLabel="Duplicate"
        pendingLabel="Duplicating…"
        error={duplicateError}
        pending={duplicating}
        onSubmit={onDuplicate}
      />
    </>
  )
}

/**
 * Enable/disable, duplicate, archive and unarchive for one Workflow.
 *
 * The list row is a Link, and React carries portalled events up the component tree
 * rather than the DOM one — so a click in the menu or either dialog would reach the
 * Link and open the workflow. The wrapping span stops that for all three. Only the
 * trigger sits inside the anchor for real, so only it also has to cancel the
 * browser's own follow-the-link default.
 */
export function WorkflowLifecycleMenu({ workflow, variant, onChanged, onFailure }: {
  workflow: LifecycleWorkflow
  variant: "row" | "header"
  onChanged?: (definition: WorkflowDefinitionV2Wire) => void
  onFailure: (error: unknown) => void
}) {
  const [dialog, setDialog] = useState<"archive" | "duplicate" | null>(null)
  const { lifecycle, duplicate } = useLifecycleWrites(workflow, () => setDialog(null), onChanged, onFailure)
  const retired = workflow.retiredAt !== null
  const Glyph = variant === "row" ? EllipsisVertical : MoreHorizontal

  return (
    <span className="contents" onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Workflow actions for ${workflow.title}`}
            onClick={(event) => event.preventDefault()}
            className={TRIGGER_CLASS[variant]}
          >
            <Glyph className="size-[18px]" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={SESSION_MENU_CONTENT_CLASS}>
          <LifecycleItems
            enabled={workflow.enabled}
            retired={retired}
            onDuplicate={() => setDialog("duplicate")}
            onAction={(action) => { if (action === "archive") setDialog("archive"); else lifecycle.mutate(action) }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <LifecycleDialogs
        workflow={workflow}
        dialog={dialog}
        onClose={() => setDialog(null)}
        onArchive={() => lifecycle.mutate("archive")}
        archiving={lifecycle.isPending}
        duplicating={duplicate.isPending}
        duplicateError={duplicate.error}
        onDuplicate={(input) => duplicate.mutate(input)}
      />
    </span>
  )
}

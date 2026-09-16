import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, type WorkItemAttachmentWire } from "@/lib/api"

/* Todos v2 slice 6 — the task page's attachment lane, lifted out of the page
 * unchanged: the item's attachment list plus the two multipart mutations that
 * write it. Upload and remove both settle the same pair of caches (the list and
 * the Todo detail, which carries its own count), so they belong together and
 * not spread through the page body. Both of the page's refusal lanes ride in:
 * `onError` for a mutation that failed outright, `onUploadFailures` for the
 * files an otherwise-successful batch could not take. */

export function useTaskAttachments({
  id,
  enabled,
  onError,
  onUploadFailures,
}: {
  id: string | null
  enabled: boolean
  onError: (fallback: string) => (error: unknown) => void
  onUploadFailures: (filenames: string[]) => void
}) {
  const qc = useQueryClient()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["work-item-attachments", id] })
    if (id) void qc.invalidateQueries({ queryKey: ["work-item", id] })
  }
  // A drop of five files is five independent uploads, so one refusal reports
  // itself and the other four still land. Failures are collected instead of
  // thrown: rejecting here would abort the batch at the first bad file.
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const failed: string[] = []
      for (const file of files) {
        try {
          await api.uploadWorkItemAttachment(id!, file)
        } catch {
          failed.push(file.name)
        }
      }
      return failed
    },
    onSuccess: (failed) => {
      if (failed.length > 0) onUploadFailures(failed)
    },
    onSettled: invalidate,
  })
  const remove = useMutation({
    mutationFn: (attachment: WorkItemAttachmentWire) => api.deleteWorkItemAttachment(id!, attachment.id),
    onError: onError("Couldn't remove the attachment"),
    onSettled: invalidate,
  })
  const list = useQuery({
    queryKey: ["work-item-attachments", id],
    queryFn: async () => (await api.listWorkItemAttachments(id!)).attachments,
    enabled: !!id && enabled,
    staleTime: 10_000,
  })
  return { files: list.data ?? [], upload, remove }
}

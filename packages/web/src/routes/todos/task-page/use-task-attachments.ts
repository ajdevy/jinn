import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, type WorkItemAttachmentWire } from "@/lib/api"

/* Todos v2 slice 6 — the task page's attachment lane, lifted out of the page
 * unchanged: the item's attachment list plus the two multipart mutations that
 * write it. Upload and remove both settle the same pair of caches (the list and
 * the Todo detail, which carries its own count), so they belong together and
 * not spread through the page body. `onError` stays the page's refusal lane. */

export function useTaskAttachments({
  id,
  enabled,
  onError,
}: {
  id: string | null
  enabled: boolean
  onError: (fallback: string) => (error: unknown) => void
}) {
  const qc = useQueryClient()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["work-item-attachments", id] })
    if (id) void qc.invalidateQueries({ queryKey: ["work-item", id] })
  }
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) await api.uploadWorkItemAttachment(id!, file)
    },
    onError: onError("Couldn't attach the file"),
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

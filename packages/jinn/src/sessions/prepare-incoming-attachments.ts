import type { Attachment } from "../shared/types.js"
import { registerIncomingAttachment } from "../gateway/files.js"

export interface PreparedIncomingAttachments {
  attachmentPaths: string[]
  cleanupPaths: string[]
  managedAttachmentIds: string[]
}

/** Persist connector files before queueing a turn, retaining a temp fallback. */
export function prepareIncomingAttachments(attachments: readonly Attachment[]): PreparedIncomingAttachments {
  const prepared: PreparedIncomingAttachments = {
    attachmentPaths: [],
    cleanupPaths: [],
    managedAttachmentIds: [],
  }
  for (const attachment of attachments) {
    if (attachment.localPath) prepared.cleanupPaths.push(attachment.localPath)
    const meta = registerIncomingAttachment(attachment)
    if (meta) {
      prepared.managedAttachmentIds.push(meta.id)
      if (meta.path) prepared.attachmentPaths.push(meta.path)
    } else if (attachment.localPath) {
      prepared.attachmentPaths.push(attachment.localPath)
    }
  }
  return prepared
}

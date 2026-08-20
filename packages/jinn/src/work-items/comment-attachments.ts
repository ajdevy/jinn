import { initDb } from '../shared/db.js';
import type { WorkItemAttachment } from './attachments.js';

/**
 * What a comment carries. Its own module because it exists for one reason a
 * plain attachment listing does not: a parked workflow Wait resumes on an
 * operator's reply, and the files attached to that reply are half the answer.
 */

/** Just enough of an attachment row to reference it: no filename, no on-disk
 *  path. What a surface outside the store is given to point at the bytes. */
export type WorkItemAttachmentHandle = Pick<WorkItemAttachment, 'id' | 'mime'>;

/** The handles for one comment's own attachments, oldest first. Tombstoning a
 *  comment leaves its rows in place, so a run resumed by a reply still sees
 *  what was attached to it. */
export function listCommentAttachments(commentId: string): WorkItemAttachmentHandle[] {
  return (
    initDb()
      .prepare('SELECT id, mime FROM work_item_attachments WHERE comment_id = ? ORDER BY created_at, rowid')
      .all(commentId) as Record<string, unknown>[]
  ).map((row) => ({ id: row.id as string, mime: row.mime as string }));
}

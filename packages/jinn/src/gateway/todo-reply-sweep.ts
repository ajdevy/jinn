import { logger } from "../shared/logger.js";
import { setTodoAttachmentListener } from "../work-items/comment-attachments.js";
import { setTodoCommentListener } from "../work-items/comments.js";

/** How long a freshly committed comment is given before a parked Wait may
 *  consume it. A reply is a comment PLUS the uploads that follow it: the
 *  comment row commits and notifies before any attachment row exists, and the
 *  client only starts sending files once that request returns. Sweeping
 *  promptly would harvest an empty list, and the node it completes never looks
 *  again — so the first look waits out an unhurried upload. */
const COMMENT_SETTLE_MS = 12_000;

/** How long a landed upload defers the sweep. Uploads arrive one request at a
 *  time, so each one re-arms this short window and a long sequence keeps
 *  extending it; the sweep runs once the last file has settled. */
const UPLOAD_SETTLE_MS = 2_000;

/** The live half of a parked `todo-comment` Wait; `recover` on boot is the
 *  backstop. Filtered to the operator, because every employee and system
 *  comment would otherwise sweep the whole run table — and a workflow's own
 *  comment could kick the sweep that wrote it.
 *
 *  Returns the teardown that stops listening and cancels a pending sweep. */
export function watchTodoReplies(recover: () => Promise<unknown>): () => void {
  let timer: NodeJS.Timeout | null = null;
  const settle = (delay: number): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void recover().catch((error) => {
        logger.warn(`Workflow Todo comment recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, delay);
    timer.unref?.();
  };
  setTodoCommentListener((comment) => {
    if (comment.authorKind === "operator" && comment.author === "operator") settle(COMMENT_SETTLE_MS);
  });
  setTodoAttachmentListener((attachment) => {
    if (attachment.commentId && attachment.uploadedBy === "operator") settle(UPLOAD_SETTLE_MS);
  });
  return () => {
    setTodoCommentListener(null);
    setTodoAttachmentListener(null);
    if (timer) clearTimeout(timer);
  };
}

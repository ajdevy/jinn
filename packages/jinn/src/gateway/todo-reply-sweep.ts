import { logger } from "../shared/logger.js";
import { setTodoCommentListener } from "../work-items/comments.js";

/** How long a Todo reply is given to finish arriving before a parked
 *  `todo-comment` Wait may consume it. */
const REPLY_SETTLE_MS = 3_000;

/** The live half of a parked `todo-comment` Wait; `recover` on boot is the
 *  backstop. Two things make this a settling sweep rather than a bare kick.
 *
 *  It is filtered to the operator, because every employee and system comment
 *  would otherwise sweep the whole run table — and a workflow's own comment
 *  could kick the sweep that wrote it.
 *
 *  And it waits, because a reply is a comment PLUS the uploads that follow it
 *  in the same submit: the comment row commits and notifies before any
 *  attachment row exists, so sweeping the instant it lands would harvest an
 *  empty attachment list, and the node it completes never looks again. The
 *  window covers an ordinary upload, not an arbitrarily slow one — closing that
 *  tail needs the store to announce attachment writes, which it does not do
 *  today.
 *
 *  Returns the teardown that stops listening and cancels a pending sweep. */
export function watchTodoReplies(recover: () => Promise<unknown>): () => void {
  let timer: NodeJS.Timeout | null = null;
  const settle = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void recover().catch((error) => {
        logger.warn(`Workflow Todo comment recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, REPLY_SETTLE_MS);
    timer.unref?.();
  };
  setTodoCommentListener((comment) => {
    if (comment.authorKind === "operator" && comment.author === "operator") settle();
  });
  return () => {
    setTodoCommentListener(null);
    if (timer) clearTimeout(timer);
  };
}

import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkItemAttachment } from "../../work-items/attachments.js";
import { announceAttachment } from "../../work-items/comment-attachments.js";
import type { WorkItemComment } from "../../work-items/comments.js";
import { notifyTodoComment } from "../../work-items/comments.js";
import { watchTodoReplies } from "../todo-reply-sweep.js";

/** Mirrors of the module's own constants: the sweep's timing IS the contract
 *  here, so the test states the numbers rather than importing them. */
const COMMENT_SETTLE_MS = 12_000;
const UPLOAD_SETTLE_MS = 2_000;

function comment(overrides: Partial<WorkItemComment> = {}): WorkItemComment {
  return {
    id: "wic_0000000000a1",
    workItemId: "PLA-1",
    parentCommentId: null,
    authorKind: "operator",
    author: "operator",
    body: "here are the shots",
    createdAt: "2026-01-01T00:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function attachment(overrides: Partial<WorkItemAttachment> = {}): WorkItemAttachment {
  return {
    id: "wia_0000000000b1",
    workItemId: "PLA-1",
    commentId: "wic_0000000000a1",
    filename: "desktop.png",
    mime: "image/png",
    bytes: 4096,
    sha256: "a".repeat(64),
    storagePath: "/dev/null",
    uploadedBy: "operator",
    createdAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

describe("watchTodoReplies", () => {
  let recover: Mock<() => Promise<unknown>>;
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    recover = vi.fn<() => Promise<unknown>>(async () => undefined);
    stop = watchTodoReplies(recover);
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("holds the comment's window open while a reply's uploads arrive one at a time", () => {
    notifyTodoComment(comment());

    vi.advanceTimersByTime(1_000);
    announceAttachment(attachment());

    vi.advanceTimersByTime(2_000);
    expect(recover).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    announceAttachment(attachment({ id: "wia_0000000000b2" }));

    vi.advanceTimersByTime(COMMENT_SETTLE_MS - 4_000 - 1);
    expect(recover).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(recover).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("carries the sweep past the comment's window for an upload that lands late", () => {
    notifyTodoComment(comment());

    vi.advanceTimersByTime(11_500);
    announceAttachment(attachment());

    vi.advanceTimersByTime(500);
    expect(recover).not.toHaveBeenCalled();

    vi.advanceTimersByTime(UPLOAD_SETTLE_MS - 500);
    expect(recover).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("sweeps a lone operator comment once its window ends", () => {
    notifyTodoComment(comment());

    vi.advanceTimersByTime(COMMENT_SETTLE_MS - 1);
    expect(recover).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("arms nothing for a comment that is not the operator's", () => {
    notifyTodoComment(comment({ authorKind: "employee", author: "a-lead" }));

    vi.advanceTimersByTime(60_000);
    expect(recover).not.toHaveBeenCalled();
  });

  it("arms nothing for an attachment on the Todo itself", () => {
    announceAttachment(attachment({ commentId: null }));

    vi.advanceTimersByTime(60_000);
    expect(recover).not.toHaveBeenCalled();
  });

  it("arms nothing for an attachment uploaded by anyone but the operator", () => {
    announceAttachment(attachment({ uploadedBy: "a-lead" }));

    vi.advanceTimersByTime(60_000);
    expect(recover).not.toHaveBeenCalled();
  });

  it("cancels a pending sweep on teardown", () => {
    notifyTodoComment(comment());
    stop();

    vi.advanceTimersByTime(60_000);
    expect(recover).not.toHaveBeenCalled();
  });
});

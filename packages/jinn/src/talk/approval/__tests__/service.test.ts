import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { migrateTalkApprovalSchema } from "../schema.js";
import { TalkApprovalRepository } from "../repository.js";
import { TalkApprovalService, type TodoApprovalSnapshot } from "../service.js";

const operator = { kind: "operator" as const };
const identity = { talkSessionId: "talk-1", browserInstanceId: "browser-1", credentialGeneration: 1 };

function fixture(now = 10_000) {
  const db = new Database(":memory:");
  migrateTalkApprovalSchema(db);
  let snapshot: TodoApprovalSnapshot = {
    todoId: "ABC-1", todoVersion: 4, approvalId: "wap_gate_1", request: "Ship this change?",
    options: null, state: "pending",
  };
  const decide = vi.fn((input: { decision: "approve" | "reject" }) => {
    snapshot = { ...snapshot, state: input.decision === "approve" ? "approved" : "rejected", todoVersion: snapshot.todoVersion + 1 };
    return { ok: true as const, version: snapshot.todoVersion };
  });
  const repository = new TalkApprovalRepository(db);
  const service = new TalkApprovalService({ repository, now: () => now, todo: { snapshot: () => snapshot, decide } });
  return { db, repository, service, decide, mutate: (patch: Partial<TodoApprovalSnapshot>) => { snapshot = { ...snapshot, ...patch }; } };
}

function transcript(repository: TalkApprovalRepository, item: string, text: string, ordinalTime: number, options: { event?: string; overrides?: Record<string, unknown> } = {}) {
  return repository.recordTranscript({ ...identity, providerItemId: item, providerEventId: options.event ?? `${item}-event`, transcript: text, recordedAt: ordinalTime, ...options.overrides });
}

function prepare(service: TalkApprovalService, overrides: Record<string, unknown> = {}) {
  return service.prepareTodo({ ...identity, providerCallId: "prepare-call-1", providerTranscriptItemId: "prepare-item", caller: operator, todoId: "ABC-1", ...overrides });
}

function commit(service: TalkApprovalService, challengeId: string, overrides: Record<string, unknown> = {}) {
  return service.commitTodo({ ...identity, providerCallId: "commit-call-1", providerTranscriptItemId: "spoken-item-1", caller: operator, challengeId, ...overrides });
}

function staged(now = 10_000) {
  const f = fixture(now);
  transcript(f.repository, "prepare-item", "Please prepare that approval", 10_000);
  const prepared = prepare(f.service);
  if (!prepared.ok) throw new Error("expected preparation");
  return { ...f, prepared };
}

describe("durable voice approval", () => {
  it.each(["approve", "reject"] as const)("derives %s only from a newer recorded final utterance and commits once", (spoken) => {
    const f = staged();
    transcript(f.repository, "spoken-item-1", `  ${spoken.toUpperCase()}  `, 10_001, { event: "spoken-event-1" });

    const result = commit(f.service, f.prepared.challengeId);

    expect(result).toMatchObject({ ok: true, replayed: false, decision: spoken, transcript: spoken });
    expect(f.decide).toHaveBeenCalledOnce();
    expect(f.decide).toHaveBeenCalledWith({ id: "ABC-1", decision: spoken });
    expect(f.repository.listAudit(f.prepared.challengeId)).toMatchObject([{
      providerCallId: "commit-call-1", providerTranscriptItemId: "spoken-item-1",
      providerTranscriptEventId: "spoken-event-1", outcome: "committed",
      code: spoken === "approve" ? "approved" : "rejected", transcript: spoken,
    }]);
  });

  it.each([
    ["approve maybe", "ambiguous"], ["yes", "ambiguous"], ["approve after changing the title", "modify"],
    ["what am I looking at?", "unrelated"], ["approve or reject", "ambiguous"],
  ])("refuses %s as %s", (spoken, code) => {
    const f = staged();
    transcript(f.repository, "spoken-item-1", spoken, 10_001);
    expect(commit(f.service, f.prepared.challengeId)).toMatchObject({ ok: false, code });
    expect(f.decide).not.toHaveBeenCalled();
  });

  it("requires a newer transcript in the same browser, session, and credential generation", () => {
    const f = staged();
    expect(commit(f.service, f.prepared.challengeId, { providerTranscriptItemId: "prepare-item" }))
      .toMatchObject({ ok: false, code: "transcript-not-newer" });
    expect(commit(f.service, f.prepared.challengeId, { providerCallId: "wrong-browser", browserInstanceId: "browser-2" }))
      .toMatchObject({ ok: false, code: "approval-identity-mismatch" });
    expect(commit(f.service, f.prepared.challengeId, { providerCallId: "wrong-generation", credentialGeneration: 2 }))
      .toMatchObject({ ok: false, code: "approval-identity-mismatch" });
    expect(f.decide).not.toHaveBeenCalled();
  });

  it("fails closed when the gate changes after preparation", () => {
    const f = staged();
    f.mutate({ approvalId: "wap_replaced", request: "A different decision", todoVersion: 5 });
    transcript(f.repository, "spoken-item-1", "approve", 10_001);
    expect(commit(f.service, f.prepared.challengeId)).toMatchObject({ ok: false, code: "approval-modified" });
    expect(f.decide).not.toHaveBeenCalled();
  });

  it("supports exact choice approval and rejects bare approval for a choice gate", () => {
    const f = fixture();
    f.mutate({ options: ["Ship now", "Wait"] });
    transcript(f.repository, "prepare-item", "Prepare the choice", 10_000);
    const prepared = prepare(f.service);
    if (!prepared.ok) throw new Error("expected preparation");
    transcript(f.repository, "spoken-item-1", "approve Ship now", 10_001);
    expect(commit(f.service, prepared.challengeId)).toMatchObject({ ok: true, decision: "approve", choice: "Ship now" });
    expect(f.decide).toHaveBeenCalledWith({ id: "ABC-1", decision: "approve", choice: "Ship now" });
  });

  it("refuses unauthorized, stale, replayed, duplicate, and changed-call speech", () => {
    const f = staged();
    transcript(f.repository, "spoken-item-1", "approve", 10_001);
    expect(commit(f.service, f.prepared.challengeId, { providerCallId: "unauthorized", caller: { kind: "session", callerId: "worker" } }))
      .toMatchObject({ ok: false, code: "operator-required" });
    const committed = commit(f.service, f.prepared.challengeId);
    expect(committed).toMatchObject({ ok: true, replayed: false });
    expect(commit(f.service, f.prepared.challengeId)).toMatchObject({ ok: true, replayed: true });
    expect(commit(f.service, f.prepared.challengeId, { providerTranscriptItemId: "different-item" }))
      .toMatchObject({ ok: false, code: "provider-call-conflict" });
    expect(commit(f.service, f.prepared.challengeId, { providerCallId: "duplicate-speech" }))
      .toMatchObject({ ok: false, code: "transcript-replayed" });
    expect(f.decide).toHaveBeenCalledOnce();

    const stale = staged();
    transcript(stale.repository, "spoken-item-1", "approve", 10_001);
    const later = new TalkApprovalService({
      repository: stale.repository, now: () => stale.prepared.expiresAt + 1,
      todo: { snapshot: () => ({ todoId: "ABC-1", todoVersion: 4, approvalId: "wap_gate_1", request: "Ship this change?", options: null, state: "pending" }), decide: stale.decide },
    });
    expect(commit(later, stale.prepared.challengeId)).toMatchObject({ ok: false, code: "approval-stale" });
  });

  it("replays the exact receipt after reopening the repository and service", () => {
    const f = staged();
    transcript(f.repository, "spoken-item-1", "approve", 10_001);
    const first = commit(f.service, f.prepared.challengeId);
    const reopened = new TalkApprovalService({ repository: new TalkApprovalRepository(f.db), now: () => 10_002, todo: { snapshot: () => null, decide: f.decide } });
    expect(commit(reopened, f.prepared.challengeId)).toEqual({ ...first, replayed: true });
    expect(f.decide).toHaveBeenCalledOnce();
  });
});

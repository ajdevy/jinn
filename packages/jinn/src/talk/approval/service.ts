import { createHash, randomUUID } from "node:crypto";
import type { CallerIdentity } from "../../gateway/session-comm-guards.js";
import { classifyApprovalTranscript, normalizeApprovalTranscript } from "./classifier.js";
import type { ApprovalChallenge, TalkApprovalRepository, VoiceTranscript } from "./repository.js";

export interface TodoApprovalSnapshot {
  todoId: string;
  todoVersion: number;
  approvalId: string;
  request: string;
  options: string[] | null;
  state: "pending" | "approved" | "rejected";
}

export interface TodoApprovalPort {
  snapshot: (id: string) => TodoApprovalSnapshot | null;
  decide: (input: { id: string; decision: "approve" | "reject"; choice?: string }) =>
    { ok: boolean; version?: number; code?: string; message?: string };
}

interface ServiceOptions {
  repository: TalkApprovalRepository;
  todo: TodoApprovalPort;
  now?: () => number;
  ttlMs?: number;
}

type ApprovalFailure = { ok: false; code: string; error: string; replayed?: boolean };
type ApprovalCommit = {
  ok: true;
  receiptId: string;
  replayed: boolean;
  challengeId: string;
  todoId: string;
  decision: "approve" | "reject";
  choice?: string;
  transcript: string;
  version: number;
};

interface BoundInput {
  talkSessionId: string;
  browserInstanceId: string;
  credentialGeneration: number;
  providerCallId: string;
  providerToolItemId?: string;
  providerToolEventId?: string;
  providerTranscriptItemId: string;
  caller: CallerIdentity;
}

interface RefusalReason { code: string; error: string }
interface AuditInput {
  input: BoundInput & { challengeId: string };
  challenge: ApprovalChallenge | null;
  requestFingerprint: string;
  transcript: VoiceTranscript | null;
  outcome: "committed" | "refused";
  code: string;
  result: ApprovalFailure | ApprovalCommit;
}
interface CommitContext {
  input: BoundInput & { challengeId: string };
  challenge: ApprovalChallenge;
  transcript: VoiceTranscript;
  requestFingerprint: string;
  live: TodoApprovalSnapshot;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function principal(caller: CallerIdentity): string | null {
  return caller.kind === "operator" ? "operator" : null;
}

function snapshotFingerprint(snapshot: TodoApprovalSnapshot): string {
  return digest(snapshot);
}

function snapshotMatches(snapshot: TodoApprovalSnapshot | null, challenge: ApprovalChallenge): snapshot is TodoApprovalSnapshot {
  if (!snapshot) return false;
  return [snapshot.state === "pending", snapshot.approvalId === challenge.approvalId,
    snapshotFingerprint(snapshot) === challenge.approvalFingerprint].every(Boolean);
}

function nullable(value: string | undefined): string | null { return value ?? null; }
function normalizedOrNull(transcript: VoiceTranscript | null): string | null {
  return transcript ? normalizeApprovalTranscript(transcript.transcript) : null;
}

function actionableClassification(transcript: string, options: readonly string[] | null):
  | { ok: true; decision: "approve" | "reject"; choice?: string }
  | { ok: false; reason: RefusalReason } {
  const classified = classifyApprovalTranscript(transcript, options);
  if (classified.kind === "approve") return { ok: true, decision: "approve", ...(classified.choice ? { choice: classified.choice } : {}) };
  if (classified.kind === "reject") return { ok: true, decision: "reject" };
  return { ok: false, reason: { code: classified.kind, error: `The final utterance was classified as ${classified.kind}; nothing was approved.` } };
}

function decisionInput(id: string, classified: { decision: "approve" | "reject"; choice?: string }) {
  return Object.fromEntries(Object.entries({ id, decision: classified.decision, choice: classified.choice })
    .filter((entry) => entry[1] !== undefined)) as { id: string; decision: "approve" | "reject"; choice?: string };
}
function decisionCode(decision: "approve" | "reject"): "approved" | "rejected" {
  return decision === "approve" ? "approved" : "rejected";
}

export class TalkApprovalService {
  private readonly repository: TalkApprovalRepository;
  private readonly todo: TodoApprovalPort;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.todo = options.todo;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 120_000;
  }

  prepareTodo(input: BoundInput & { todoId: string }): ApprovalFailure | {
    ok: true;
    replayed: boolean;
    challengeId: string;
    expiresAt: number;
    todoId: string;
    request: string;
    allowedUtterances: string[];
  } {
    const operatorPrincipal = principal(input.caller);
    if (!operatorPrincipal) return { ok: false, code: "operator-required", error: "Approval requires the authenticated operator." };
    const source = this.repository.getTranscript(input.talkSessionId, input.credentialGeneration, input.providerTranscriptItemId);
    if (!source || source.browserInstanceId !== input.browserInstanceId) {
      return { ok: false, code: "transcript-not-found", error: "Preparation requires a recorded final operator transcript." };
    }
    const snapshot = this.todo.snapshot(input.todoId);
    if (!snapshot || snapshot.state !== "pending") return { ok: false, code: "no-pending-approval", error: "The Todo has no pending approval." };
    const requestFingerprint = digest({ todoId: input.todoId, sourceItemId: source.providerItemId });
    const scopeJson = stable({ request: snapshot.request, options: snapshot.options, consequence: "Commit the live Todo approval decision." });
    const at = this.now();
    const created = this.repository.createChallenge({
      talkSessionId: input.talkSessionId, operatorPrincipal, browserInstanceId: input.browserInstanceId,
      credentialGeneration: input.credentialGeneration, prepareProviderCallId: input.providerCallId,
      requestFingerprint, preparedAfterOrdinal: source.inputOrdinal, todoId: snapshot.todoId,
      approvalId: snapshot.approvalId, approvalFingerprint: snapshotFingerprint(snapshot), scopeJson,
      createdAt: at, expiresAt: at + this.ttlMs,
    });
    if (created.challenge.requestFingerprint !== requestFingerprint) {
      return { ok: false, code: "provider-call-conflict", error: "This provider call id was reused for a different approval challenge." };
    }
    return {
      ok: true, replayed: created.replayed, challengeId: created.challenge.id,
      expiresAt: created.challenge.expiresAt, todoId: created.challenge.todoId, request: snapshot.request,
      allowedUtterances: snapshot.options?.length
        ? ["reject", ...snapshot.options.map((choice) => `approve ${choice}`)]
        : ["approve", "reject"],
    };
  }

  commitTodo(input: BoundInput & { challengeId: string }): ApprovalFailure | ApprovalCommit {
    const requestFingerprint = digest({
      challengeId: input.challengeId, providerTranscriptItemId: input.providerTranscriptItemId,
      browserInstanceId: input.browserInstanceId, credentialGeneration: input.credentialGeneration,
    });
    const prior = this.repository.findAuditByCall(input.talkSessionId, input.credentialGeneration, input.providerCallId);
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint) {
        return { ok: false, code: "provider-call-conflict", error: "This provider call id was reused with different approval evidence." };
      }
      return { ...(JSON.parse(prior.result) as ApprovalFailure | ApprovalCommit), replayed: true };
    }
    return this.repository.transaction(() => this.commitNew(input, requestFingerprint));
  }

  private commitNew(input: BoundInput & { challengeId: string }, requestFingerprint: string): ApprovalFailure | ApprovalCommit {
    const challenge = this.repository.getChallenge(input.challengeId);
    const transcript = this.repository.getTranscript(input.talkSessionId, input.credentialGeneration, input.providerTranscriptItemId);
    const validated = this.validateCommit(input, challenge, transcript);
    if (!validated.ok) return this.refuse({ input, challenge, requestFingerprint, transcript, reason: validated.reason });
    const live = this.todo.snapshot(validated.challenge.todoId);
    if (!snapshotMatches(live, validated.challenge))
      return this.refuse({ input, challenge, requestFingerprint, transcript, reason: { code: "approval-modified", error: "The approval changed after it was prepared." } });
    return this.applyDecision({ input, challenge: validated.challenge, transcript: validated.transcript, requestFingerprint, live });
  }

  private applyDecision(context: CommitContext): ApprovalFailure | ApprovalCommit {
    const { input, challenge, transcript, requestFingerprint, live } = context;
    const classified = actionableClassification(transcript.transcript, live.options);
    if (!classified.ok) return this.refuse({ input, challenge, requestFingerprint, transcript, reason: classified.reason });
    const decided = this.todo.decide(decisionInput(challenge.todoId, classified));
    if (![decided.ok, decided.version].every(Boolean))
      return this.refuse({ input, challenge, requestFingerprint, transcript, reason: { code: decided.code ?? "decision-refused", error: decided.message ?? "The live gate refused the decision." } });
    if (!this.repository.markCommitted(challenge.id, this.now()))
      return this.refuse({ input, challenge, requestFingerprint, transcript, reason: { code: "approval-replayed", error: "This approval challenge was already consumed." } });
    const result: ApprovalCommit = {
      ok: true, receiptId: randomUUID(), replayed: false, challengeId: challenge.id, todoId: challenge.todoId,
      decision: classified.decision, ...(classified.choice ? { choice: classified.choice } : {}),
      transcript: normalizeApprovalTranscript(transcript.transcript), version: decided.version!,
    };
    this.audit({ input, challenge, requestFingerprint, transcript, outcome: "committed", code: decisionCode(classified.decision), result });
    return result;
  }

  private validateCommit(input: BoundInput & { challengeId: string }, challenge: ApprovalChallenge | null, transcript: VoiceTranscript | null):
    | { ok: false; reason: RefusalReason }
    | { ok: true; challenge: ApprovalChallenge; transcript: VoiceTranscript } {
    const checks: Array<() => RefusalReason | null> = [
      () => !challenge || challenge.talkSessionId !== input.talkSessionId ? { code: "approval-challenge-not-found", error: "The approval challenge is not active in this Talk session." } : null,
      () => !challenge || principal(input.caller) !== challenge.operatorPrincipal ? { code: "operator-required", error: "Approval requires the authenticated operator." } : null,
      () => !challenge || challenge.browserInstanceId !== input.browserInstanceId || challenge.credentialGeneration !== input.credentialGeneration ? { code: "approval-identity-mismatch", error: "This approval belongs to a different browser or credential generation." } : null,
      () => !transcript || transcript.browserInstanceId !== input.browserInstanceId ? { code: "transcript-not-found", error: "No final operator transcript matches this approval attempt." } : null,
      () => !challenge || !transcript || transcript.inputOrdinal <= challenge.preparedAfterOrdinal ? { code: "transcript-not-newer", error: "Approval requires a newer final utterance than the preparation request." } : null,
      () => this.repository.committedTranscriptWasUsed(input.talkSessionId, input.credentialGeneration, input.providerTranscriptItemId) ? { code: "transcript-replayed", error: "This spoken evidence already committed an approval." } : null,
      () => challenge?.status !== "pending" ? { code: "approval-replayed", error: "This approval challenge was already consumed." } : null,
      () => !challenge || this.now() > challenge.expiresAt ? { code: "approval-stale", error: "The spoken approval challenge expired." } : null,
    ];
    const reason = checks.map((check) => check()).find((candidate) => candidate !== null);
    return reason ? { ok: false, reason } : { ok: true, challenge: challenge!, transcript: transcript! };
  }

  private refuse(context: Omit<AuditInput, "outcome" | "code" | "result"> & { reason: RefusalReason }): ApprovalFailure {
    const result: ApprovalFailure = { ok: false, code: context.reason.code, error: context.reason.error };
    this.audit({ ...context, outcome: "refused", code: context.reason.code, result });
    return result;
  }

  private audit(context: AuditInput): void {
    const { input, challenge, requestFingerprint, transcript, outcome, code, result } = context;
    this.repository.recordAudit({
      challengeId: challenge?.id ?? input.challengeId, talkSessionId: input.talkSessionId,
      operatorPrincipal: principal(input.caller) ?? "unauthorized", browserInstanceId: input.browserInstanceId,
      credentialGeneration: input.credentialGeneration, providerCallId: input.providerCallId,
      providerToolItemId: nullable(input.providerToolItemId), providerToolEventId: nullable(input.providerToolEventId),
      providerTranscriptItemId: transcript?.providerItemId ?? input.providerTranscriptItemId,
      providerTranscriptEventId: nullable(transcript?.providerEventId), requestFingerprint,
      transcript: normalizedOrNull(transcript),
      outcome, code, result: JSON.stringify(result), createdAt: this.now(),
    });
  }
}

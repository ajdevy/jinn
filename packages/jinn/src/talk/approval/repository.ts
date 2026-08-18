import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";

export interface VoiceTranscriptInput {
  talkSessionId: string;
  browserInstanceId: string;
  credentialGeneration: number;
  providerItemId: string;
  providerEventId: string;
  transcript: string;
  recordedAt: number;
}

export interface VoiceTranscript extends VoiceTranscriptInput { inputOrdinal: number }

export interface ApprovalChallenge {
  id: string;
  talkSessionId: string;
  operatorPrincipal: string;
  browserInstanceId: string;
  credentialGeneration: number;
  prepareProviderCallId: string;
  requestFingerprint: string;
  preparedAfterOrdinal: number;
  todoId: string;
  approvalId: string;
  approvalFingerprint: string;
  scopeJson: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "committed" | "expired";
  committedAt: number | null;
}

export interface ApprovalAudit {
  id: string;
  challengeId: string;
  talkSessionId: string;
  operatorPrincipal: string;
  browserInstanceId: string;
  credentialGeneration: number;
  providerCallId: string;
  providerToolItemId: string | null;
  providerToolEventId: string | null;
  providerTranscriptItemId: string | null;
  providerTranscriptEventId: string | null;
  requestFingerprint: string;
  transcript: string | null;
  outcome: "committed" | "refused";
  code: string;
  result: string;
  createdAt: number;
}

const text = (row: Record<string, unknown>, key: string): string => String(row[key]);
const nullableText = (row: Record<string, unknown>, key: string): string | null => row[key] === null ? null : String(row[key]);

function transcriptRow(row: Record<string, unknown>): VoiceTranscript {
  return {
    talkSessionId: text(row, "talk_session_id"), browserInstanceId: text(row, "browser_instance_id"),
    credentialGeneration: Number(row.credential_generation), inputOrdinal: Number(row.input_ordinal),
    providerItemId: text(row, "provider_item_id"), providerEventId: text(row, "provider_event_id"),
    transcript: text(row, "transcript"), recordedAt: Number(row.recorded_at),
  };
}

function challengeRow(row: Record<string, unknown>): ApprovalChallenge {
  return {
    id: text(row, "id"), talkSessionId: text(row, "talk_session_id"), operatorPrincipal: text(row, "operator_principal"),
    browserInstanceId: text(row, "browser_instance_id"), credentialGeneration: Number(row.credential_generation),
    prepareProviderCallId: text(row, "prepare_provider_call_id"), requestFingerprint: text(row, "request_fingerprint"),
    preparedAfterOrdinal: Number(row.prepared_after_ordinal), todoId: text(row, "todo_id"),
    approvalId: text(row, "approval_id"), approvalFingerprint: text(row, "approval_fingerprint"),
    scopeJson: text(row, "scope_json"), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
    status: row.status as ApprovalChallenge["status"], committedAt: row.committed_at === null ? null : Number(row.committed_at),
  };
}

function auditRow(row: Record<string, unknown>): ApprovalAudit {
  return {
    id: text(row, "id"), challengeId: text(row, "challenge_id"), talkSessionId: text(row, "talk_session_id"),
    operatorPrincipal: text(row, "operator_principal"), browserInstanceId: text(row, "browser_instance_id"),
    credentialGeneration: Number(row.credential_generation), providerCallId: text(row, "provider_call_id"),
    providerToolItemId: nullableText(row, "provider_tool_item_id"), providerToolEventId: nullableText(row, "provider_tool_event_id"),
    providerTranscriptItemId: nullableText(row, "provider_transcript_item_id"),
    providerTranscriptEventId: nullableText(row, "provider_transcript_event_id"),
    requestFingerprint: text(row, "request_fingerprint"), transcript: nullableText(row, "transcript"),
    outcome: row.outcome as ApprovalAudit["outcome"], code: text(row, "code"), result: text(row, "result"),
    createdAt: Number(row.created_at),
  };
}

export class TalkApprovalRepository {
  constructor(private readonly database: Database) {}

  transaction<T>(work: () => T): T { return this.database.transaction(work)(); }

  recordTranscript(input: VoiceTranscriptInput): VoiceTranscript {
    return this.transaction(() => {
      const existing = this.getTranscript(input.talkSessionId, input.credentialGeneration, input.providerItemId);
      if (existing) {
        if (existing.transcript !== input.transcript || existing.providerEventId !== input.providerEventId || existing.browserInstanceId !== input.browserInstanceId) {
          throw new Error("provider transcript identity was reused with different evidence");
        }
        return existing;
      }
      const event = this.database.prepare(`SELECT * FROM talk_voice_transcripts
        WHERE talk_session_id = ? AND credential_generation = ? AND provider_event_id = ?`)
        .get(input.talkSessionId, input.credentialGeneration, input.providerEventId) as Record<string, unknown> | undefined;
      if (event) throw new Error("provider transcript event was reused with different evidence");
      const ordinal = Number((this.database.prepare(`SELECT COALESCE(MAX(input_ordinal), 0) + 1 AS next
        FROM talk_voice_transcripts WHERE talk_session_id = ? AND credential_generation = ?`)
        .get(input.talkSessionId, input.credentialGeneration) as { next: number }).next);
      this.database.prepare(`INSERT INTO talk_voice_transcripts
        (talk_session_id, browser_instance_id, credential_generation, input_ordinal, provider_item_id,
         provider_event_id, transcript, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.talkSessionId, input.browserInstanceId, input.credentialGeneration, ordinal, input.providerItemId,
          input.providerEventId, input.transcript, input.recordedAt);
      return { ...input, inputOrdinal: ordinal };
    });
  }

  getTranscript(talkSessionId: string, generation: number, providerItemId: string): VoiceTranscript | null {
    const row = this.database.prepare(`SELECT * FROM talk_voice_transcripts
      WHERE talk_session_id = ? AND credential_generation = ? AND provider_item_id = ?`)
      .get(talkSessionId, generation, providerItemId) as Record<string, unknown> | undefined;
    return row ? transcriptRow(row) : null;
  }

  createChallenge(input: Omit<ApprovalChallenge, "id" | "status" | "committedAt">): { challenge: ApprovalChallenge; replayed: boolean } {
    const existing = this.findChallengeByCall(input.talkSessionId, input.credentialGeneration, input.prepareProviderCallId);
    if (existing) return { challenge: existing, replayed: true };
    const id = randomUUID();
    this.database.prepare(`INSERT INTO talk_approval_challenges
      (id, talk_session_id, operator_principal, browser_instance_id, credential_generation, prepare_provider_call_id,
       request_fingerprint, prepared_after_ordinal, todo_id, approval_id, approval_fingerprint, scope_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.talkSessionId, input.operatorPrincipal, input.browserInstanceId, input.credentialGeneration,
        input.prepareProviderCallId, input.requestFingerprint, input.preparedAfterOrdinal, input.todoId,
        input.approvalId, input.approvalFingerprint, input.scopeJson, input.createdAt, input.expiresAt);
    return { challenge: this.getChallenge(id)!, replayed: false };
  }

  findChallengeByCall(talkSessionId: string, generation: number, providerCallId: string): ApprovalChallenge | null {
    const row = this.database.prepare(`SELECT * FROM talk_approval_challenges
      WHERE talk_session_id = ? AND credential_generation = ? AND prepare_provider_call_id = ?`)
      .get(talkSessionId, generation, providerCallId) as Record<string, unknown> | undefined;
    return row ? challengeRow(row) : null;
  }

  getChallenge(id: string): ApprovalChallenge | null {
    const row = this.database.prepare("SELECT * FROM talk_approval_challenges WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? challengeRow(row) : null;
  }

  markCommitted(id: string, committedAt: number): boolean {
    return this.database.prepare(`UPDATE talk_approval_challenges SET status = 'committed', committed_at = ?
      WHERE id = ? AND status = 'pending'`).run(committedAt, id).changes === 1;
  }

  findAuditByCall(talkSessionId: string, generation: number, providerCallId: string): ApprovalAudit | null {
    const row = this.database.prepare(`SELECT * FROM talk_approval_audit
      WHERE talk_session_id = ? AND credential_generation = ? AND provider_call_id = ?`)
      .get(talkSessionId, generation, providerCallId) as Record<string, unknown> | undefined;
    return row ? auditRow(row) : null;
  }

  committedTranscriptWasUsed(talkSessionId: string, generation: number, providerItemId: string): boolean {
    return this.database.prepare(`SELECT 1 FROM talk_approval_audit WHERE talk_session_id = ?
      AND credential_generation = ? AND provider_transcript_item_id = ? AND outcome = 'committed'`)
      .get(talkSessionId, generation, providerItemId) !== undefined;
  }

  recordAudit(input: Omit<ApprovalAudit, "id">): ApprovalAudit {
    const id = randomUUID();
    this.database.prepare(`INSERT INTO talk_approval_audit
      (id, challenge_id, talk_session_id, operator_principal, browser_instance_id, credential_generation,
       provider_call_id, provider_tool_item_id, provider_tool_event_id, provider_transcript_item_id,
       provider_transcript_event_id, request_fingerprint, transcript, outcome, code, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.challengeId, input.talkSessionId, input.operatorPrincipal, input.browserInstanceId,
        input.credentialGeneration, input.providerCallId, input.providerToolItemId, input.providerToolEventId,
        input.providerTranscriptItemId, input.providerTranscriptEventId, input.requestFingerprint, input.transcript,
        input.outcome, input.code, input.result, input.createdAt);
    return { id, ...input };
  }

  listAudit(challengeId: string): ApprovalAudit[] {
    return (this.database.prepare("SELECT * FROM talk_approval_audit WHERE challenge_id = ? ORDER BY created_at, rowid")
      .all(challengeId) as Array<Record<string, unknown>>).map(auditRow);
  }
}

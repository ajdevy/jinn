import { beforeEach, describe, expect, it } from "vitest";
import { baseConfig, call, stubMintingFetch } from "./helpers/talk-route-harness.js";
import type { JinnConfig } from "../../shared/types.js";

const workItems = await import("../../work-items/store.js");
const approvals = await import("../../work-items/approvals.js");
const approvalRows = await import("../../work-items/approval-rows.js");

let config: JinnConfig;

beforeEach(() => {
  config = baseConfig();
  stubMintingFetch();
});

describe("Talk approval control", () => {
  it("commits one exact operator voice approval from durable provider evidence", async () => {
    const todo = workItems.createWorkItem({ title: "Approve the bounded release" });
    approvals.requestApproval(todo.id, { request: "Ship the bounded release?", operatorOnly: true });
    const opened = await call(config, "POST", "/api/talk/sessions");
    expect(opened.status).toBe(201);

    const session = opened.body;
    const id = session.id as string;
    const identity = {
      browserInstanceId: session.browserInstanceId,
      credentialGeneration: session.credentialGeneration,
    };
    const transcriptPath = `/api/talk/sessions/${id}/transcript`;
    const controlPath = `/api/talk/sessions/${id}/control`;

    expect((await call(config, "POST", transcriptPath, {
      ...identity,
      providerItemId: "voice-source",
      providerEventId: "voice-source-event",
      transcript: "Prepare this approval",
    })).status).toBe(200);
    const prepared = await call(config, "POST", controlPath, {
      ...identity,
      providerCallId: "prepare-tool-call",
      providerTranscriptItemId: "voice-source",
      tool: "prepare_voice_approval",
      arguments: JSON.stringify({ id: todo.id }),
    });
    expect(prepared.body).toMatchObject({ ok: true, verified: true, data: { todoId: todo.id } });

    const challengeId = (prepared.body.data as { challengeId: string }).challengeId;
    expect((await call(config, "POST", transcriptPath, {
      ...identity,
      providerItemId: "voice-decision",
      providerEventId: "voice-decision-event",
      transcript: "approve",
    })).status).toBe(200);
    const request = {
      ...identity,
      providerCallId: "commit-tool-call",
      providerTranscriptItemId: "voice-decision",
      tool: "commit_voice_approval",
      arguments: JSON.stringify({ challengeId }),
    };
    const committed = await call(config, "POST", controlPath, request);
    const replay = await call(config, "POST", controlPath, request);

    expect(committed.body).toMatchObject({
      ok: true,
      verified: true,
      replayed: false,
      data: { decision: "approve", todoId: todo.id },
    });
    expect(replay.body).toMatchObject({
      ok: true,
      replayed: true,
      receiptId: committed.body.receiptId,
    });
    expect(approvalRows.currentApproval(todo.id)).toMatchObject({
      state: "approved",
      decidedBy: "operator",
    });
  });
});

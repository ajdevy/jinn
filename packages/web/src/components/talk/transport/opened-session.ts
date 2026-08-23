import { browserInstanceId } from "../context/browser-instance"
import { parseTalkControlManifest } from "./control-manifest"
import type { OpenTalkSession, TalkVadType } from "./session-client"

function stringOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function integerOr(value: unknown, fallback: number): number {
  return Number.isInteger(value) ? value as number : fallback
}

function openedVad(value: unknown): TalkVadType {
  return value === "server_vad" ? "server_vad" : "semantic_vad"
}

/** Input filtering matched to the microphone's distance, as the gateway reports
 *  it back. Configured in `realtime.noiseReduction`, never in the browser. */
export type RealtimeNoiseReduction = "near_field" | "far_field"

/** The gateway's own default, used only when it reports nothing at all. */
const DEFAULT_NOISE_REDUCTION: RealtimeNoiseReduction = "far_field"

function openedMicrophone(value: unknown): RealtimeNoiseReduction {
  return value === "near_field" || value === "far_field" ? value : DEFAULT_NOISE_REDUCTION
}

export function parseOpenedSession(opened: Partial<OpenTalkSession>): OpenTalkSession {
  const manifest = parseTalkControlManifest(opened.manifest)
  if (typeof opened.id !== "string" || typeof opened.token !== "string" || !manifest) {
    throw new Error("The gateway opened a talk session without an id, credential, and valid control manifest.")
  }
  return {
    id: opened.id,
    browserInstanceId: stringOr(opened.browserInstanceId, browserInstanceId()),
    credentialGeneration: integerOr(opened.credentialGeneration, 1),
    token: opened.token,
    expiresAt: integerOr(opened.expiresAt, 0),
    model: stringOr(opened.model),
    brief: stringOr(opened.brief),
    manifest,
    topicMemory: stringOr(opened.topicMemory),
    vadType: openedVad(opened.vadType),
    noiseReduction: openedMicrophone(opened.noiseReduction),
  }
}

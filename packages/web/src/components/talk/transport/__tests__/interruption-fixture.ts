/**
 * The provider frames a barge-in is made of, as JSON strings.
 *
 * Pure builders, shared by the interruption tests and anything else that has to
 * replay a VAD sequence — no driver and no mocks, so importing them cannot
 * disturb a test file's own module registry.
 */
export function event(type: string, fields: Record<string, unknown> = {}) {
  return JSON.stringify({ type, ...fields })
}

export function responseCreated(responseId: string) {
  return event("response.created", { response: { id: responseId } })
}

export function responseDone(responseId: string) {
  return event("response.done", {
    response: { id: responseId, status: "cancelled", status_details: { reason: "turn_detected" } },
  })
}

export function speechStarted(itemId?: string, audioStartMs?: number) {
  return event("input_audio_buffer.speech_started", { item_id: itemId, audio_start_ms: audioStartMs })
}

export function speechStopped(itemId?: string, audioEndMs?: number) {
  return event("input_audio_buffer.speech_stopped", { item_id: itemId, audio_end_ms: audioEndMs })
}

export function outputCleared(responseId?: string) {
  return event("output_audio_buffer.cleared", { response_id: responseId })
}

export function outputStarted(responseId: string) {
  return event("output_audio_buffer.started", { response_id: responseId })
}

export function transcript(itemId: string, text: string) {
  return event("conversation.item.input_audio_transcription.completed", {
    item_id: itemId,
    event_id: `event-${itemId}`,
    transcript: text,
  })
}

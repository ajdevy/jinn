import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react"
import type { MediaAttachment } from "@/lib/conversations"

export type ComposerCommand =
  | { type: "draft"; message: string }
  | { type: "replace"; message: string }
  | { type: "send" }
  | { type: "draft-and-send"; message: string }

export type ComposerCommandResult =
  | { ok: true; characters: number }
  | { ok: false; error: string }

export interface ChatComposerControl {
  sessionId: string
  isVisible(): boolean
  execute(command: ComposerCommand): ComposerCommandResult | Promise<ComposerCommandResult>
}

interface RegisteredControl { token: symbol; control: ChatComposerControl }
let current: RegisteredControl | null = null

/** Tokenized cleanup prevents an old pane from unregistering its replacement. */
export function registerChatComposerControl(control: ChatComposerControl): () => void {
  const token = Symbol("chat-composer")
  current = { token, control }
  return () => { if (current?.token === token) current = null }
}

export function activeChatComposerControl(): ChatComposerControl | null {
  return current?.control ?? null
}

interface ComposerControlOptions {
  sessionId: string | null
  textareaRef: RefObject<HTMLTextAreaElement | null>
  disabledRef: RefObject<boolean>
  submittingRef: RefObject<boolean>
  valueRef: RefObject<string>
  speechRef: RefObject<boolean>
  pendingAttachmentsRef: RefObject<MediaAttachment[]>
  sendTextRef: RefObject<(text: string, media: MediaAttachment[]) => Promise<boolean>>
  setValue: Dispatch<SetStateAction<string>>
  setSendArmed: Dispatch<SetStateAction<boolean>>
  setShowMentions: Dispatch<SetStateAction<boolean>>
  setShowCommands: Dispatch<SetStateAction<boolean>>
}

function visible(state: ComposerControlOptions): boolean {
  const textarea = state.textareaRef.current
  if (!textarea?.isConnected) return false
  if (typeof textarea.checkVisibility === "function") return textarea.checkVisibility()
  return textarea.getClientRects().length > 0
}

function replace(state: ComposerControlOptions, message: string): ComposerCommandResult {
  state.valueRef.current = message
  state.speechRef.current = false
  state.setValue(message)
  state.setSendArmed(false)
  state.setShowMentions(false)
  state.setShowCommands(false)
  state.textareaRef.current?.focus()
  return { ok: true, characters: message.length }
}

function edit(state: ComposerControlOptions, command: Extract<ComposerCommand, { type: "draft" | "replace" }>): ComposerCommandResult {
  const currentDraft = state.valueRef.current.trim()
  if (command.type === "draft") {
    return currentDraft
      ? { ok: false, error: "The visible composer already has a draft. Replace it explicitly instead." }
      : replace(state, command.message)
  }
  return currentDraft ? replace(state, command.message) : { ok: false, error: "There is no visible draft to replace." }
}

async function submit(state: ComposerControlOptions, command: Extract<ComposerCommand, { type: "send" | "draft-and-send" }>): Promise<ComposerCommandResult> {
  const currentDraft = state.valueRef.current.trim()
  if (state.pendingAttachmentsRef.current.length > 0) {
    return { ok: false, error: "Remove or send the pending attachments by hand before using Talk to send text." }
  }
  if (command.type === "draft-and-send" && currentDraft) {
    return { ok: false, error: "The visible composer already has a draft. Send or replace it before drafting another reply." }
  }
  const text = command.type === "send" ? currentDraft : command.message
  if (!text) return { ok: false, error: "The visible composer is empty, so nothing was sent." }
  const sent = await state.sendTextRef.current(text, [])
  return sent ? { ok: true, characters: text.length } : { ok: false, error: "The visible draft was not sent." }
}

async function execute(state: ComposerControlOptions, command: ComposerCommand): Promise<ComposerCommandResult> {
  if (state.disabledRef.current || state.submittingRef.current) {
    return { ok: false, error: "The selected chat composer is busy." }
  }
  return command.type === "draft" || command.type === "replace"
    ? edit(state, command)
    : submit(state, command)
}

export function useChatComposerControl(options: ComposerControlOptions): void {
  const latest = useRef(options)
  latest.current = options
  useEffect(() => {
    if (!options.sessionId) return
    const sessionId = options.sessionId
    return registerChatComposerControl({
      sessionId,
      isVisible: () => visible(latest.current),
      execute: (command) => execute(latest.current, command),
    })
  }, [options.sessionId])
}

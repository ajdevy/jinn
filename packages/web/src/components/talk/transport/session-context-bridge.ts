import { describeInstance } from "../context/instance-identity"
import { getPageContext, subscribePageContext } from "../context/page-context-store"
import { renderPageContext } from "../context/render-page-context"
import { visibleObjects } from "../context/visible-objects"
import { functionTools, type TalkControlManifest } from "./control-manifest"
import { postTalkScreenContext } from "./session-client"

/** Settle rapid URL/filter changes before replacing provider instructions. */
export const PAGE_CONTEXT_DEBOUNCE_MS = 400

interface SessionContextOptions {
  sessionId: string
  browserInstanceId?: string
  credentialGeneration?: number
  brief?: string
  topicMemory?: string
  manifest: TalkControlManifest
  send: (event: Record<string, unknown>) => void
}

function sendSessionConfig(options: SessionContextOptions): void {
  const page = getPageContext()
  const context = renderPageContext(page, visibleObjects(page), describeInstance())
  const memory = options.topicMemory ? `Talk topic memory: ${options.topicMemory}` : ""
  if (options.browserInstanceId && options.credentialGeneration) {
    void postTalkScreenContext(options.sessionId, page, options.browserInstanceId,
      options.credentialGeneration).catch(() => {})
  }
  options.send({
    type: "session.update",
    session: {
      type: "realtime",
      tools: functionTools(options.manifest),
      instructions: [options.brief, memory, context].filter(Boolean).join("\n\n"),
    },
  })
}

/** Own the page subscription and its debounce timer for one live attachment. */
export function createSessionContextBridge(options: SessionContextOptions) {
  let unfollow: (() => void) | null = null
  let settling: ReturnType<typeof setTimeout> | null = null
  return {
    start: () => {
      sendSessionConfig(options)
      unfollow = subscribePageContext(() => {
        if (settling) clearTimeout(settling)
        settling = setTimeout(() => {
          settling = null
          sendSessionConfig(options)
        }, PAGE_CONTEXT_DEBOUNCE_MS)
      })
    },
    stop: () => {
      unfollow?.()
      unfollow = null
      if (settling) clearTimeout(settling)
      settling = null
    },
  }
}

import type { SituationPayload } from "../situation-payload"
import {
  answerSituation,
  dismissSituation,
  restoreDeferredSituation,
} from "../talk-situation-store"

/** Leaves the store empty for the next test. A dismissal is what fills the
 *  deferred slot, so dismissing alone would hand the next test this one's
 *  situation: put down whatever is up, raise what that left behind, answer it. */
export function clearSituations(): void {
  dismissSituation()
  restoreDeferredSituation()
  answerSituation("cleanup")
}

/** One payload per kind, keyed by kind so a new member of the union cannot be
 *  added without the tests that walk this record gaining a case. */
export const PAYLOADS: Record<SituationPayload["kind"], SituationPayload> = {
  prose: { kind: "prose", text: "The second half repeats the first. Cut it?" },
  options: {
    kind: "options",
    options: [
      { id: "ship", label: "Ship it", detail: "Land it as it stands" },
      { id: "revise", label: "Revise", detail: "One more pass" },
    ],
  },
  images: {
    kind: "images",
    images: [
      { id: "variant-a", src: "a.png", alt: "Variant A", caption: "Variant A" },
      { id: "variant-b", src: "b.png", alt: "Variant B" },
    ],
  },
  video: {
    kind: "video",
    clips: [
      { id: "cut-slow", src: "slow.mp4", label: "Slow cut" },
      { id: "cut-fast", src: "fast.mp4", label: "Fast cut" },
    ],
  },
  object: { kind: "object", object: { type: "todo", id: "AAA-1" } },
  "voice-setup": { kind: "voice-setup", providers: ["openai"] },
}

export const KINDS = Object.keys(PAYLOADS) as SituationPayload["kind"][]

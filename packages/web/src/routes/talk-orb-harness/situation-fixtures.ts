import type { Situation, SituationPayload } from "@/components/talk/situation-payload"

/**
 * One fixture per payload kind, so the bench can raise every situation the sheet
 * can draw. Placeholder copy and inline artwork only: nothing here reaches the
 * network, and nothing here is anybody's real content.
 */

/** A flat swatch, so an image card has something to show without a fetch. */
function swatch(label: string, fill: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">` +
    `<rect width="320" height="320" fill="${fill}"/>` +
    `<text x="160" y="176" font-family="sans-serif" font-size="72" fill="#ffffff" ` +
    `text-anchor="middle" opacity="0.85">${label}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const PAYLOADS: Record<SituationPayload["kind"], SituationPayload> = {
  prose: {
    kind: "prose",
    text:
      "The draft is ready and reads clean, but one section still repeats a point " +
      "from earlier. Cut the repeat, or leave it for emphasis?",
  },
  options: {
    kind: "options",
    options: [
      { id: "ship", label: "Ship it", detail: "Land the change as it stands" },
      { id: "revise", label: "Revise first", detail: "One more pass before it lands" },
      { id: "hold", label: "Hold", detail: "Park it until the week turns over" },
    ],
  },
  images: {
    kind: "images",
    images: [
      { id: "variant-a", src: swatch("A", "#8a6a3d"), alt: "Variant A", caption: "Variant A" },
      { id: "variant-b", src: swatch("B", "#6a5a8a"), alt: "Variant B", caption: "Variant B" },
      { id: "variant-c", src: swatch("C", "#3d6a6a"), alt: "Variant C", caption: "Variant C" },
    ],
  },
  video: {
    kind: "video",
    clips: [
      { id: "cut-slow", src: "", poster: swatch("1", "#6a4a3d"), label: "Slow cut" },
      { id: "cut-fast", src: "", poster: swatch("2", "#3d4a6a"), label: "Fast cut" },
    ],
  },
  object: {
    kind: "object",
    object: { type: "todo", id: "JIN-1" },
  },
}

const TITLES: Record<SituationPayload["kind"], { title: string; hint: string }> = {
  prose: { title: "One repeat left", hint: "Say the answer, or read it and decide" },
  options: { title: "How should this land?", hint: "Pick one — there is no confirm step" },
  images: { title: "Which cover?", hint: "Three variants, same brief" },
  video: { title: "Which cut?", hint: "Two edits of the same take" },
  object: { title: "Is this the right Todo?", hint: "Pulled live from this instance" },
}

export const SITUATION_KINDS = Object.keys(PAYLOADS) as SituationPayload["kind"][]

export function situationFixture(kind: SituationPayload["kind"]): Situation {
  return {
    id: `bench-${kind}`,
    title: TITLES[kind].title,
    hint: TITLES[kind].hint,
    payload: PAYLOADS[kind],
    footer: "Escape or tap outside to dismiss",
  }
}

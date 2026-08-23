/**
 * The fold's one timeline.
 *
 * Height, opacity and the chevron all run for the same time on the same curve,
 * so an expand or a collapse reads as one movement rather than three that
 * happen to start together. The duration lives here as a number because the
 * landing timer needs it as one; it mirrors `--duration-slow`.
 */

export const FOLD_MS = 260

export const FOLD_TRANSITION = `height ${FOLD_MS}ms var(--ease-smooth), opacity ${FOLD_MS}ms var(--ease-smooth)`

/** The landing timer's margin over the transition it waits for. */
export const FOLD_LANDING_PAD_MS = 20

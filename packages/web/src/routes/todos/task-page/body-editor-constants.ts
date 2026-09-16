export const BODY_PLACEHOLDER = "Describe the work — type ## for a heading, - for a list"

/* A collapsed Todo body clamps to this rendered height. Body copy is 16px on a
 * 1.6 line-height, so 360px is roughly 14 lines — an opening paragraph plus a
 * short scope list, which is the shape of a typical Todo body. Lower and the
 * control fires on nearly every Todo and becomes noise; higher and the subtasks,
 * attachments and activity below it stay off screen on a 900px viewport, which
 * is the complaint this clamp exists to answer. */
export const BODY_CLAMP_PX = 360

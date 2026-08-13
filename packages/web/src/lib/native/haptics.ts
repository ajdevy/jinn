/**
 * Tactile confirmation for gestures the OS would acknowledge natively and the
 * web cannot. Off-shell every call is a no-op: a browser has no haptic engine,
 * and its absence is not something to surface to an operator mid-gesture.
 */
import { hapticsBridge, type HapticsBridge } from "./shell";

/**
 * A light confirmation tap.
 *
 * Fire it on the gesture, not on the response to it — a tap that lands after a
 * network round trip reads as a glitch rather than as feedback. The bridge is
 * an injectable parameter so callers stay synchronous and tests need no global.
 */
export function tap(bridge: HapticsBridge | null = hapticsBridge()): void {
  if (!bridge) return;
  // Not awaited, and rejections are dropped: the caller is inside a gesture
  // handler, the result carries nothing it could act on, and an older shell
  // without the plugin must not raise an unhandled rejection over a buzz.
  void bridge.impact({ style: "LIGHT" }).catch(() => {});
}

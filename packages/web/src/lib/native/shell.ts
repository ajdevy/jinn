/**
 * Detection of, and typed access to, the bridge the iOS shell injects.
 *
 * The shell loads the gateway's own origin rather than bundling the web build,
 * so one bundle runs in a browser tab, in the installed PWA and inside the
 * shell. Everything native is therefore optional. This is the only module that
 * touches `window.Capacitor`; every consumer degrades to a no-op without it.
 *
 * The bridge globals are read directly instead of importing `@capacitor/*`.
 * The web bundle has roughly 7 KB of gzip headroom on its initial-critical-path
 * budget (perf-budgets.json), and a native package the browser build can never
 * execute is not what that headroom is for.
 */

/** The one Haptics method we call, narrowed to the one argument we pass. */
export interface HapticsBridge {
  impact(options: { style: string }): Promise<void>;
}

interface CapacitorBridge {
  isNativePlatform?: () => boolean;
  Plugins?: { Haptics?: HapticsBridge };
}

declare global {
  interface Window {
    Capacitor?: CapacitorBridge;
  }
}

function capacitor(): CapacitorBridge | null {
  if (typeof window === "undefined") return null;
  return window.Capacitor ?? null;
}

/**
 * Whether this bundle is running inside the native shell.
 *
 * Capacitor injects its global on the web too when the app is served through
 * `cap serve`, so the platform is asked rather than the global's presence.
 */
export function isNativeShell(): boolean {
  return capacitor()?.isNativePlatform?.() === true;
}

/** The Haptics plugin, or null off-shell and when the plugin is not installed. */
export function hapticsBridge(): HapticsBridge | null {
  if (!isNativeShell()) return null;
  return capacitor()?.Plugins?.Haptics ?? null;
}

import { describe, it, expect, vi, afterEach } from "vitest";
import { tap } from "../haptics";

function setBridge(value: unknown): void {
  Object.defineProperty(window, "Capacitor", { value, configurable: true, writable: true });
}

describe("native/haptics", () => {
  afterEach(() => {
    setBridge(undefined);
  });

  it("is a no-op that throws nothing when there is no shell", () => {
    expect(() => tap()).not.toThrow();
  });

  it("calls through exactly once when the shell exposes Haptics", () => {
    const impact = vi.fn(() => Promise.resolve());
    setBridge({ isNativePlatform: () => true, Plugins: { Haptics: { impact } } });

    tap();

    expect(impact).toHaveBeenCalledTimes(1);
    expect(impact).toHaveBeenCalledWith({ style: "LIGHT" });
  });

  it("does not fire off-shell even though the plugin is reachable", () => {
    const impact = vi.fn(() => Promise.resolve());
    setBridge({ isNativePlatform: () => false, Plugins: { Haptics: { impact } } });

    tap();

    expect(impact).not.toHaveBeenCalled();
  });

  it("swallows a rejecting bridge rather than surfacing it mid-gesture", async () => {
    const impact = vi.fn(() => Promise.reject(new Error("no haptic engine")));

    expect(() => tap({ impact })).not.toThrow();
    // Let the rejection settle: an unhandled one would fail the run.
    await Promise.resolve();

    expect(impact).toHaveBeenCalledTimes(1);
  });
});

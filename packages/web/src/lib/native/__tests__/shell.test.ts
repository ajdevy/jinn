import { describe, it, expect, afterEach } from "vitest";
import { isNativeShell, hapticsBridge } from "../shell";

function setBridge(value: unknown): void {
  Object.defineProperty(window, "Capacitor", { value, configurable: true, writable: true });
}

describe("native/shell", () => {
  afterEach(() => {
    setBridge(undefined);
  });

  it("reports not-native when the browser has no Capacitor global", () => {
    expect(isNativeShell()).toBe(false);
  });

  it("reports not-native when Capacitor is present but says it is the web platform", () => {
    setBridge({ isNativePlatform: () => false, Plugins: { Haptics: {} } });
    expect(isNativeShell()).toBe(false);
  });

  it("reports native when the shell's bridge says so", () => {
    setBridge({ isNativePlatform: () => true });
    expect(isNativeShell()).toBe(true);
  });

  it("withholds the haptics bridge off-shell even when a Haptics plugin is exposed", () => {
    setBridge({ isNativePlatform: () => false, Plugins: { Haptics: { impact: () => Promise.resolve() } } });
    expect(hapticsBridge()).toBeNull();
  });

  it("returns the haptics bridge on-shell", () => {
    const haptics = { impact: () => Promise.resolve() };
    setBridge({ isNativePlatform: () => true, Plugins: { Haptics: haptics } });
    expect(hapticsBridge()).toBe(haptics);
  });

  it("returns null on-shell when the Haptics plugin is not installed", () => {
    setBridge({ isNativePlatform: () => true, Plugins: {} });
    expect(hapticsBridge()).toBeNull();
  });
});

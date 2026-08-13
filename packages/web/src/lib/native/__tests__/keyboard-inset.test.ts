import { describe, it, expect, afterEach } from "vitest";
import { startKeyboardInset } from "../keyboard-inset";

/** A stand-in for `window.visualViewport`, which jsdom does not implement. */
function fakeViewport(height: number) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    height,
    offsetTop: 0,
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
    /** Move the visual viewport as the keyboard would, then notify. */
    resizeTo(next: number) {
      this.height = next;
      for (const listener of listeners.get("resize") ?? []) listener();
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function install(viewport: unknown): void {
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true, writable: true });
}

function inset(): string {
  return document.documentElement.style.getPropertyValue("--keyboard-inset");
}

describe("native/keyboard-inset", () => {
  afterEach(() => {
    install(undefined);
    document.documentElement.style.removeProperty("--keyboard-inset");
  });

  it("publishes 0px when no keyboard is up", () => {
    window.innerHeight = 844;
    install(fakeViewport(844));

    const stop = startKeyboardInset();

    expect(inset()).toBe("0px");
    stop();
  });

  it("publishes the obscured height when the visual viewport shrinks", () => {
    window.innerHeight = 844;
    const viewport = fakeViewport(844);
    install(viewport);

    const stop = startKeyboardInset();
    viewport.resizeTo(508);

    expect(inset()).toBe("336px");
    stop();
  });

  it("resets to 0px when the keyboard is dismissed", () => {
    window.innerHeight = 844;
    const viewport = fakeViewport(844);
    install(viewport);

    const stop = startKeyboardInset();
    viewport.resizeTo(508);
    viewport.resizeTo(844);

    expect(inset()).toBe("0px");
    stop();
  });

  it("never publishes a negative inset when the viewport is taller than the layout", () => {
    window.innerHeight = 844;
    const viewport = fakeViewport(900);
    install(viewport);

    const stop = startKeyboardInset();

    expect(inset()).toBe("0px");
    stop();
  });

  it("publishes 0px and subscribes to nothing in a browser without visualViewport", () => {
    install(undefined);

    const stop = startKeyboardInset();

    expect(inset()).toBe("0px");
    expect(() => stop()).not.toThrow();
  });

  it("unsubscribes and clears the variable when stopped", () => {
    window.innerHeight = 844;
    const viewport = fakeViewport(844);
    install(viewport);

    const stop = startKeyboardInset();
    viewport.resizeTo(508);
    expect(inset()).toBe("336px");

    stop();

    expect(inset()).toBe("0px");
    expect(viewport.listenerCount("resize")).toBe(0);
    expect(viewport.listenerCount("scroll")).toBe(0);
  });
});

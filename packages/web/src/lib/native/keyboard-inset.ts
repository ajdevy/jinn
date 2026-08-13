/**
 * Publishes the height the on-screen keyboard obscures as `--keyboard-inset`,
 * so layout can lift out of its way.
 *
 * Driven by `visualViewport` rather than by the shell's Keyboard plugin: the
 * same code then works in a browser tab, in the installed PWA and in the shell,
 * which is also what makes it testable without a device. The shell configures
 * the Keyboard plugin with `resize: 'none'` so the native layer does not resize
 * the web view as well and have the inset counted twice.
 */

const VARIABLE = "--keyboard-inset";

/**
 * Start publishing the inset; returns an unsubscribe.
 *
 * A browser with no `visualViewport` still gets a `0px` variable, so consumers
 * may compose the variable unconditionally instead of guarding every call site.
 */
export function startKeyboardInset(): () => void {
  if (typeof window === "undefined") return () => {};

  const root = document.documentElement;
  root.style.setProperty(VARIABLE, "0px");

  const viewport = window.visualViewport;
  if (!viewport) return () => {};

  function update(): void {
    // innerHeight is the layout viewport and does not shrink for the keyboard;
    // visualViewport.height does. offsetTop accounts for the viewport being
    // scrolled up over the layout, which iOS does when a field is near the
    // bottom — without it a pinned composer double-counts the offset.
    const obscured = window.innerHeight - viewport!.height - viewport!.offsetTop;
    root.style.setProperty(VARIABLE, `${Math.max(0, Math.round(obscured))}px`);
  }

  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);

  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    root.style.setProperty(VARIABLE, "0px");
  };
}

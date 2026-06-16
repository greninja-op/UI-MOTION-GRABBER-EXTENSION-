// UI Motion Grabber — Highlighter (Content_Script subsystem)
// Pure Vanilla JavaScript, zero dependencies, unbundled.
//
// Responsibility (design.md "Highlighter", Requirements 1.1, 1.2, 1.3):
//   Apply and remove the Highlight_Class on a hovered host-page element using
//   `classList` ONLY. The Highlighter NEVER reads or writes the host element's
//   inline `style` attribute, so the host page's own styles — and our own
//   Structural_Signature capture (which hashes `style.cssText`) — stay intact.
//
// The highlight visual is delivered purely through a CSS class hook
// (`.ui-motion-grabber-target-hover`); the accompanying stylesheet lives in the
// isolated Overlay_UI scope (implemented in a later task) and never touches the
// host element's inline style attribute.

/**
 * The isolated Highlight_Class applied to a hovered element (Req 1.3 glossary).
 * Exported so the Overlay_UI stylesheet and tests can reference the single
 * source of truth.
 * @type {string}
 */
export const HIGHLIGHT_CLASS = "ui-motion-grabber-target-hover";

/**
 * Creates a Highlighter that tracks at most one currently-highlighted element
 * and moves the Highlight_Class between elements as the pointer moves.
 *
 * All mutations go exclusively through `Element.classList`. The element's
 * inline `style` attribute is never read or written (Req 1.3).
 *
 * @returns {{
 *   apply: (element: Element | null | undefined) => void,
 *   remove: (element: Element | null | undefined) => void,
 *   highlight: (element: Element | null | undefined) => void,
 *   clear: () => void,
 *   current: () => Element | null,
 *   HIGHLIGHT_CLASS: string,
 * }}
 */
export function createHighlighter() {
  /** @type {Element | null} The element that currently carries the class. */
  let currentElement = null;

  /**
   * Adds the Highlight_Class to `element` via `classList` (Req 1.1).
   * No-op for nullish elements or elements lacking a `classList`.
   * @param {Element | null | undefined} element
   */
  function apply(element) {
    if (!element || !element.classList) {
      return;
    }
    element.classList.add(HIGHLIGHT_CLASS);
  }

  /**
   * Removes the Highlight_Class from `element` via `classList` (Req 1.2).
   * No-op for nullish elements or elements lacking a `classList`.
   * @param {Element | null | undefined} element
   */
  function remove(element) {
    if (!element || !element.classList) {
      return;
    }
    element.classList.remove(HIGHLIGHT_CLASS);
  }

  /**
   * Moves the highlight to `element`: removes the class from the previously
   * highlighted element (hover-off, Req 1.2) and applies it to the new one
   * (hover, Req 1.1). Passing the same element is idempotent. Passing a
   * nullish element clears the current highlight.
   * @param {Element | null | undefined} element
   */
  function highlight(element) {
    const next = element || null;
    if (next === currentElement) {
      return;
    }
    remove(currentElement);
    if (next) {
      apply(next);
    }
    currentElement = next;
  }

  /**
   * Removes the Highlight_Class from the currently-highlighted element, if any,
   * and forgets it. Used on hover-off and during teardown.
   */
  function clear() {
    if (currentElement) {
      remove(currentElement);
      currentElement = null;
    }
  }

  /**
   * @returns {Element | null} The element currently carrying the Highlight_Class.
   */
  function current() {
    return currentElement;
  }

  return { apply, remove, highlight, clear, current, HIGHLIGHT_CLASS };
}

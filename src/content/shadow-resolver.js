// UI Motion Grabber — Shadow_Root element resolver (Content_Script subsystem)
// Pure Vanilla JavaScript, zero dependencies, unbundled.
//
// Responsibility (design.md "Picker.resolveElement", Requirement 1.7):
//   Resolve the element under a pointer coordinate, recursively descending
//   through open `shadowRoot` instances via `elementFromPoint` so that nested
//   web-component elements can be targeted. Standard `document.elementFromPoint`
//   stops at a shadow host and returns the host itself; to reach the element a
//   user actually sees, we must re-query inside each open shadow root at the
//   same point until no further shadow root contains the point.
//
// The function returns the innermost element at (x, y), or `null` when no
// element lies under the point (guarding against `null` results at every hop).

/**
 * Resolves the deepest (innermost) element under the point (x, y), descending
 * through nested open Shadow_Root instances (Req 1.7).
 *
 * Algorithm:
 *   1. Query the starting root (a Document or ShadowRoot) with
 *      `elementFromPoint(x, y)`.
 *   2. If the result is an open shadow host, re-query inside its `shadowRoot`
 *      at the same point to reach the slotted/shadow content.
 *   3. Repeat until the current root reports no deeper element, the deepest
 *      element has no open `shadowRoot`, or the descent stops making progress.
 *
 * Guards:
 *   - Returns `null` immediately if the starting root cannot resolve a point
 *     (e.g. the point is outside the viewport) — never throws on null.
 *   - Closed shadow roots expose no `shadowRoot` property, so descent naturally
 *     stops at them.
 *   - A visited-host set and a same-element check prevent infinite loops if a
 *     shadow root re-reports its own host at the point.
 *
 * @param {number} x - Client X coordinate of the point.
 * @param {number} y - Client Y coordinate of the point.
 * @param {Document | DocumentOrShadowRoot} [doc=document] - The root to start
 *   resolution from. Defaults to the global `document`. Injectable for testing.
 * @returns {Element | null} The innermost element at the point, or `null`.
 */
export function resolveElement(x, y, doc) {
  const root =
    doc || (typeof document !== "undefined" ? document : null);

  // Guard: no usable root to query.
  if (!root || typeof root.elementFromPoint !== "function") {
    return null;
  }

  // First hop: the top-level element under the point.
  let element = root.elementFromPoint(x, y);

  // Guard: the point resolves to nothing (e.g. outside the viewport).
  if (!element) {
    return null;
  }

  // Tracks shadow hosts we have already descended into, so a shadow root that
  // re-reports its own host at the point cannot trap us in an infinite loop.
  const visitedHosts = new Set();

  // Descend through nested open shadow roots.
  while (
    element &&
    element.shadowRoot &&
    typeof element.shadowRoot.elementFromPoint === "function" &&
    !visitedHosts.has(element)
  ) {
    visitedHosts.add(element);

    const inner = element.shadowRoot.elementFromPoint(x, y);

    // Guard: the shadow root has no element at this point — the host is the
    // innermost resolvable element, so stop here.
    if (!inner) {
      break;
    }

    // No progress: the shadow root reported the same node we came from.
    if (inner === element) {
      break;
    }

    element = inner;
  }

  return element;
}

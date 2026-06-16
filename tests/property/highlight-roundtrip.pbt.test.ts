// Feature: ui-motion-grabber, Property 1: Highlight round-trip leaves DOM unchanged
import { describe, it, expect } from "vitest";
import fc from "fast-check";
// @ts-expect-error — Content_Script is pure unbundled Vanilla JS (no .d.ts).
import { createHighlighter, HIGHLIGHT_CLASS } from "../../src/content/highlighter.js";

/**
 * Property 1: Highlight round-trip leaves DOM unchanged
 * Validates: Requirements 1.1, 1.2
 *
 * For any host DOM and any element in it, applying the Highlight_Class on hover
 * (apply) and then removing it on hover-off (remove) restores that element's
 * `classList` to its original value: the Highlight_Class is present after hover
 * and absent after hover-off.
 */
describe("Property 1: Highlight round-trip leaves DOM unchanged (Req 1.1, 1.2)", () => {
  // Smart generator: valid, whitespace-free CSS class tokens that are NOT the
  // Highlight_Class itself (so the "original" classList never already contains
  // the token we add/remove, keeping the round-trip meaningful).
  const classToken = fc
    .stringMatching(/^[a-zA-Z_][a-zA-Z0-9_-]*$/)
    .filter((t) => t.length > 0 && t !== HIGHLIGHT_CLASS);

  // An arbitrary set of distinct initial classes for the host element.
  const initialClasses = fc.uniqueArray(classToken, { minLength: 0, maxLength: 8 });

  it("apply-then-remove restores the original classList for any element", () => {
    fc.assert(
      fc.property(initialClasses, (classes) => {
        const el = document.createElement("div");
        for (const c of classes) {
          el.classList.add(c);
        }
        const originalClassName = el.className;
        const originalTokens = [...el.classList].sort();

        const h = createHighlighter();

        // Hover: Highlight_Class present (Req 1.1).
        h.apply(el);
        expect(el.classList.contains(HIGHLIGHT_CLASS)).toBe(true);

        // Hover-off: Highlight_Class absent (Req 1.2).
        h.remove(el);
        expect(el.classList.contains(HIGHLIGHT_CLASS)).toBe(false);

        // Round-trip leaves the classList identical to its original value.
        expect(el.className).toBe(originalClassName);
        expect([...el.classList].sort()).toEqual(originalTokens);
      }),
      { numRuns: 200 }
    );
  });

  it("repeated hover/hover-off cycles still restore the original classList", () => {
    fc.assert(
      fc.property(initialClasses, fc.integer({ min: 1, max: 6 }), (classes, cycles) => {
        const el = document.createElement("div");
        for (const c of classes) {
          el.classList.add(c);
        }
        const originalClassName = el.className;

        const h = createHighlighter();
        for (let i = 0; i < cycles; i++) {
          h.apply(el);
          expect(el.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
          h.remove(el);
          expect(el.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
        }

        expect(el.className).toBe(originalClassName);
      }),
      { numRuns: 200 }
    );
  });
});

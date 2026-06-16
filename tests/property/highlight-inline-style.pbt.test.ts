// Feature: ui-motion-grabber, Property 2: Highlighting never mutates inline style
//
// Property 2 (design.md "Correctness Properties"):
//   For any host DOM with arbitrary inline styles and any sequence of
//   hover / hover-off operations, the inline `style.cssText` of every host
//   element SHALL be identical to its value before the operations.
//
// **Validates: Requirements 1.3**
//
// Strategy: build a small host DOM whose elements each carry an arbitrary,
// jsdom-parseable inline style. Snapshot every element's `style.cssText`
// (post-jsdom-normalization) BEFORE any operations. Drive the Highlighter
// through an arbitrary sequence of hover / hover-off operations, then assert
// each element's `style.cssText` is byte-for-byte identical to its snapshot.

import { describe, it, expect, beforeEach } from "vitest";
import fc from "fast-check";
// @ts-expect-error — Content_Script is pure unbundled Vanilla JS (no .d.ts).
import { createHighlighter } from "../../src/content/highlighter.js";

// A pool of valid CSS declarations jsdom's CSSOM accepts and round-trips, so
// the "before" snapshot is a stable inline style for most elements.
const DECLARATIONS: ReadonlyArray<readonly [string, string]> = [
  ["color", "red"],
  ["color", "rgb(10, 20, 30)"],
  ["background-color", "blue"],
  ["transform", "scale(2)"],
  ["transform", "translateX(10px)"],
  ["transform", "rotate(45deg)"],
  ["opacity", "0.5"],
  ["display", "flex"],
  ["display", "grid"],
  ["margin", "10px"],
  ["width", "100px"],
  ["top", "5px"],
  ["transition", "all 0.3s ease-in-out"],
];

// Produces an inline-style string from a unique subset of the declaration pool.
const inlineStyleArb = fc
  .uniqueArray(fc.nat({ max: DECLARATIONS.length - 1 }), {
    minLength: 0,
    maxLength: DECLARATIONS.length,
  })
  .map((indices) =>
    indices.map((i) => `${DECLARATIONS[i][0]}: ${DECLARATIONS[i][1]}`).join("; ")
  );

// Operations the Highlighter exposes that a hover / hover-off sequence drives.
type Op =
  | { kind: "hover"; idx: number }
  | { kind: "hoverOff" }
  | { kind: "apply"; idx: number }
  | { kind: "remove"; idx: number }
  | { kind: "clear" };

function opsArb(elementCount: number) {
  const idxArb = fc.nat({ max: Math.max(0, elementCount - 1) });
  return fc.array(
    fc.oneof(
      idxArb.map((idx): Op => ({ kind: "hover", idx })),
      fc.constant<Op>({ kind: "hoverOff" }),
      idxArb.map((idx): Op => ({ kind: "apply", idx })),
      idxArb.map((idx): Op => ({ kind: "remove", idx })),
      fc.constant<Op>({ kind: "clear" })
    ),
    { minLength: 0, maxLength: 30 }
  );
}

// Generate the host DOM styles together with an operation sequence whose
// indices are valid for that DOM.
const scenarioArb = fc
  .array(inlineStyleArb, { minLength: 1, maxLength: 6 })
  .chain((styles) =>
    fc.record({
      styles: fc.constant(styles),
      ops: opsArb(styles.length),
    })
  );

describe("Property 2: Highlighting never mutates inline style (Req 1.3)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("preserves every host element's inline style.cssText across hover/hover-off sequences", () => {
    fc.assert(
      fc.property(scenarioArb, ({ styles, ops }) => {
        // Build the host DOM: one element per generated inline style.
        document.body.innerHTML = "";
        const elements = styles.map((styleText) => {
          const el = document.createElement("div");
          if (styleText) {
            el.setAttribute("style", styleText);
          }
          document.body.appendChild(el);
          return el;
        });

        // Snapshot the post-normalization inline style BEFORE any operations.
        const before = elements.map((el) => el.style.cssText);

        // Drive the Highlighter through the arbitrary hover/hover-off sequence.
        const highlighter = createHighlighter();
        for (const op of ops) {
          switch (op.kind) {
            case "hover":
              highlighter.highlight(elements[op.idx]);
              break;
            case "hoverOff":
              highlighter.highlight(null);
              break;
            case "apply":
              highlighter.apply(elements[op.idx]);
              break;
            case "remove":
              highlighter.remove(elements[op.idx]);
              break;
            case "clear":
              highlighter.clear();
              break;
          }
        }

        // Every element's inline style.cssText must be unchanged.
        elements.forEach((el, i) => {
          expect(el.style.cssText).toBe(before[i]);
        });
      }),
      { numRuns: 200 }
    );
  });
});

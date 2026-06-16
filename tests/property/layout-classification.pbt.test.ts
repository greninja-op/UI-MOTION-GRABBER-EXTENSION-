// Feature: ui-motion-grabber, Property 12: Layout classification from computed display
//
// Validates: Requirements 5.1
//
// Property 12 (design.md "Correctness Properties"):
//   For any computed `display` value, the Reverse_Engineering_Engine SHALL
//   classify the layout as Flexbox for `flex`/`inline-flex`, as Grid for
//   `grid`/`inline-grid`, and as Other otherwise.
//
// We exercise two complementary input spaces:
//   1. The known display values — including case/whitespace variants that must
//      still resolve to the canonical classification, since the implementation
//      trims and lowercases the `display` value.
//   2. Arbitrary other strings (that are not, after trim+lowercase, one of the
//      known values) — which must classify as `"Other"` and never throw.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  classifyLayout,
  type LayoutStrategy,
} from "../../src/worker/reverse-engineering-engine.ts";
import type { ComputedStyleSnapshot } from "../../src/shared/index.ts";

// The fixed classification table, restated independently from the
// implementation so the test pins the exact mapping required by design.md.
const KNOWN_VALUES: ReadonlyArray<{ display: string; expected: LayoutStrategy }> = [
  { display: "flex", expected: "Flexbox" },
  { display: "inline-flex", expected: "Flexbox" },
  { display: "grid", expected: "Grid" },
  { display: "inline-grid", expected: "Grid" },
];

const KNOWN_DISPLAY_STRINGS = KNOWN_VALUES.map((v) => v.display);

/** Build a ComputedStyleSnapshot carrying the given `display` value. */
function snapshot(display: string): ComputedStyleSnapshot {
  return { display };
}

const knownArb = fc.constantFrom(...KNOWN_VALUES);

/**
 * Wrap a known display value in arbitrary surrounding whitespace and
 * randomized casing. The implementation trims and lowercases the `display`
 * value, so these variants must still resolve to the same classification.
 */
const knownVariantArb = knownArb.chain(({ display, expected }) =>
  fc
    .record({
      lead: fc.stringOf(fc.constantFrom(" ", "\t", "\n"), { maxLength: 3 }),
      trail: fc.stringOf(fc.constantFrom(" ", "\t", "\n"), { maxLength: 3 }),
      upper: fc.boolean(),
    })
    .map(({ lead, trail, upper }) => ({
      input: `${lead}${upper ? display.toUpperCase() : display}${trail}`,
      expected,
    })),
);

/**
 * Arbitrary strings that are NOT one of the known display values (after trim +
 * lowercase). These must classify as `"Other"`.
 */
const otherStringArb = fc
  .string()
  .filter((s) => !KNOWN_DISPLAY_STRINGS.includes(s.trim().toLowerCase()));

describe("Reverse_Engineering_Engine — Property 12: Layout classification from computed display (Req 5.1)", () => {
  it("classifies every known display value (and case/whitespace variants) correctly", () => {
    fc.assert(
      fc.property(knownVariantArb, ({ input, expected }) => {
        expect(classifyLayout(snapshot(input))).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it("classifies arbitrary other display values as Other and never throws", () => {
    fc.assert(
      fc.property(otherStringArb, (display) => {
        let result: LayoutStrategy | undefined;
        expect(() => {
          result = classifyLayout(snapshot(display));
        }).not.toThrow();
        expect(result).toBe("Other");
      }),
      { numRuns: 200 },
    );
  });
});

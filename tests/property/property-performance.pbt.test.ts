// Feature: ui-motion-grabber, Property 14: Animated-property performance classification
//
// Validates: Requirements 5.3, 5.4
//
// Property 14 (design.md "Correctness Properties"):
//   For any animated property name, the Reverse_Engineering_Engine SHALL
//   classify it as composite-friendly when it is `transform` or `opacity`,
//   and as layout-triggering when it is `top`, `width`, or `margin`.
//
// We exercise three complementary input spaces:
//   1. The composite-friendly keyword set {transform, opacity} — including
//      case/whitespace variants — which must classify as "composite-friendly".
//   2. The layout-triggering keyword set {top, width, margin} — including
//      case/whitespace variants — which must classify as "layout-triggering".
//   3. Arbitrary other strings (none of the five known names after
//      trim+lowercase) — which must classify as "other" and never throw.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { classifyProperty } from "../../src/worker/reverse-engineering-engine.ts";

const COMPOSITE_FRIENDLY = ["transform", "opacity"] as const;
const LAYOUT_TRIGGERING = ["top", "width", "margin"] as const;

const KNOWN_NAMES = [...COMPOSITE_FRIENDLY, ...LAYOUT_TRIGGERING] as const;

/**
 * Wrap a known property name in arbitrary surrounding whitespace and
 * randomized casing. The implementation trims and lowercases input, so these
 * variants must still resolve to the same classification.
 */
function variantArb(names: readonly string[]) {
  return fc.constantFrom(...names).chain((name) =>
    fc
      .record({
        lead: fc.stringOf(fc.constantFrom(" ", "\t", "\n"), { maxLength: 3 }),
        trail: fc.stringOf(fc.constantFrom(" ", "\t", "\n"), { maxLength: 3 }),
        upper: fc.boolean(),
      })
      .map(({ lead, trail, upper }) => ({
        name,
        input: `${lead}${upper ? name.toUpperCase() : name}${trail}`,
      })),
  );
}

/**
 * Arbitrary strings that are NOT one of the five known property names (after
 * trim + lowercase). These must classify as "other".
 */
const otherStringArb = fc
  .string()
  .filter(
    (s) => !(KNOWN_NAMES as readonly string[]).includes(s.trim().toLowerCase()),
  );

describe("Reverse_Engineering_Engine — Property 14: Animated-property performance classification (Req 5.3, 5.4)", () => {
  it("classifies transform/opacity (and case/whitespace variants) as composite-friendly", () => {
    fc.assert(
      fc.property(variantArb(COMPOSITE_FRIENDLY), ({ input }) => {
        expect(classifyProperty(input)).toBe("composite-friendly");
      }),
      { numRuns: 200 },
    );
  });

  it("classifies top/width/margin (and case/whitespace variants) as layout-triggering", () => {
    fc.assert(
      fc.property(variantArb(LAYOUT_TRIGGERING), ({ input }) => {
        expect(classifyProperty(input)).toBe("layout-triggering");
      }),
      { numRuns: 200 },
    );
  });

  it("classifies any other property name as other and never throws", () => {
    fc.assert(
      fc.property(otherStringArb, (input) => {
        let result: string | undefined;
        expect(() => {
          result = classifyProperty(input);
        }).not.toThrow();
        expect(result).toBe("other");
      }),
      { numRuns: 200 },
    );
  });
});

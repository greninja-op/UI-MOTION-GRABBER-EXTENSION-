// Feature: ui-motion-grabber, Property 11: Keyword easing normalization correctness
//
// Validates: Requirements 4.3
//
// Property 11 (design.md "Correctness Properties"):
//   For any easing keyword drawn from {linear, ease, ease-in, ease-out,
//   ease-in-out}, `normalizeEasing` SHALL return exactly the CubicBezier
//   defined by the fixed conversion map.
//
// We exercise two complementary input spaces:
//   1. The fixed keyword set — including case/whitespace variants that must
//      still resolve to the canonical mapping — and assert exact coordinate
//      equality against the table in design.md.
//   2. Arbitrary unknown strings — which must fall back to `linear` with
//      `recognized: false` and must never throw.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  normalizeEasing,
  normalizeEasingResult,
  EASING_KEYWORD_MAP,
  LINEAR_BEZIER,
} from "../../src/worker/animation-parser.ts";

// The fixed conversion table, restated independently from the implementation
// so the test pins the exact coordinates required by design.md rather than
// trusting the implementation's own constant.
const FIXED_TABLE = {
  linear: { x1: 0, y1: 0, x2: 1, y2: 1 },
  ease: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
  "ease-in": { x1: 0.42, y1: 0, x2: 1, y2: 1 },
  "ease-out": { x1: 0, y1: 0, x2: 0.58, y2: 1 },
  "ease-in-out": { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
} as const;

type Keyword = keyof typeof FIXED_TABLE;

const KEYWORDS = Object.keys(FIXED_TABLE) as Keyword[];

const keywordArb = fc.constantFrom(...KEYWORDS);

/**
 * Wrap a keyword in arbitrary surrounding whitespace and randomized casing.
 * The implementation trims and lowercases input, so these variants must still
 * resolve to the same canonical mapping.
 */
const keywordVariantArb = keywordArb.chain((keyword) =>
  fc
    .record({
      lead: fc.stringOf(fc.constantFrom(" ", "\t", "\n"), { maxLength: 3 }),
      trail: fc.stringOf(fc.constantFrom(" ", "\t", "\n"), { maxLength: 3 }),
      upper: fc.boolean(),
    })
    .map(({ lead, trail, upper }) => ({
      keyword,
      input: `${lead}${upper ? keyword.toUpperCase() : keyword}${trail}`,
    })),
);

/**
 * Arbitrary strings that are NOT one of the known keywords (after trim +
 * lowercase). These must fall back to `linear` and be flagged unrecognized.
 */
const unknownStringArb = fc
  .string()
  .filter((s) => !KEYWORDS.includes(s.trim().toLowerCase() as Keyword));

describe("Animation_Parser — Property 11: Keyword easing normalization correctness (Req 4.3)", () => {
  it("maps every fixed keyword (and case/whitespace variants) to the exact cubic-bezier", () => {
    fc.assert(
      fc.property(keywordVariantArb, ({ keyword, input }) => {
        const expected = FIXED_TABLE[keyword];

        const curve = normalizeEasing(input);
        expect(curve).toEqual(expected);

        const result = normalizeEasingResult(input);
        expect(result.recognized).toBe(true);
        expect(result.easing).toEqual(expected);
        expect(result.input).toBe(input.trim().toLowerCase());
      }),
      { numRuns: 200 },
    );
  });

  it("falls back to linear with recognized=false for unknown strings and never throws", () => {
    fc.assert(
      fc.property(unknownStringArb, (input) => {
        let curve;
        let result;
        // Must never throw on arbitrary input.
        expect(() => {
          curve = normalizeEasing(input);
          result = normalizeEasingResult(input);
        }).not.toThrow();

        expect(curve).toEqual(LINEAR_BEZIER);
        expect(result!.recognized).toBe(false);
        expect(result!.easing).toEqual(LINEAR_BEZIER);
      }),
      { numRuns: 200 },
    );
  });

  it("never throws on arbitrary non-string inputs and falls back to linear", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(undefined),
          fc.constant(null),
          fc.integer(),
          fc.double(),
          fc.boolean(),
          fc.object(),
          fc.array(fc.anything()),
        ),
        (value) => {
          let result;
          expect(() => {
            result = normalizeEasingResult(value);
          }).not.toThrow();
          expect(result!.recognized).toBe(false);
          expect(result!.easing).toEqual(LINEAR_BEZIER);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("returns a fresh object so mutating the result cannot corrupt the shared table", () => {
    const curve = normalizeEasing("ease");
    curve.x1 = 999;
    expect(EASING_KEYWORD_MAP.ease.x1).toBe(0.25);
  });
});

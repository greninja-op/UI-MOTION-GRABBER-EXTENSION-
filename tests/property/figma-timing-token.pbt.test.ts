// Feature: ui-motion-grabber, Property 17: Figma timing token cubic-bezier format and round-trip
//
// Validates: Requirements 6.2
//
// Property 17 (design.md "Correctness Properties"):
//   For any CubicBezier easing, the emitted Figma timing token value SHALL be a
//   `cubic-bezier(x1,y1,x2,y2)` string, and parsing that string back SHALL
//   recover the original coordinates.
//
// We exercise two complementary surfaces of the Export_Payload Assembler:
//   1. The format/parse pair directly: `formatCubicBezier` produces a
//      `cubic-bezier(...)` token and `parseCubicBezierToken` is its exact
//      inverse for arbitrary finite coordinates.
//   2. The end-to-end emission path: timing tokens derived by
//      `assembleExportPayload` from a StateMap are in `cubic-bezier(...)` form
//      and round-trip back to the original transition easing.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  formatCubicBezier,
  parseCubicBezierToken,
  assembleExportPayload,
} from "../../src/worker/export-payload-assembler.ts";
import type { CubicBezier, StateMap, Transition } from "../../src/shared/index.ts";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * A single finite cubic-bezier coordinate. `-0` is normalized to `0` because
 * `(-0).toString()` is `"0"`, so the textual token form can never preserve the
 * sign of negative zero — and the property speaks of recovering the
 * coordinate's value, not its IEEE-754 sign bit.
 */
const coordArb = fc
  .double({ noNaN: true, noDefaultInfinity: true })
  .map((n) => (Object.is(n, -0) ? 0 : n));

/** An arbitrary CubicBezier with four independent finite coordinates. */
const bezierArb: fc.Arbitrary<CubicBezier> = fc.record({
  x1: coordArb,
  y1: coordArb,
  x2: coordArb,
  y2: coordArb,
});

/** A Transition carrying an arbitrary easing (other fields are plausible). */
const transitionArb: fc.Arbitrary<Transition> = fc.record({
  fromIndex: fc.nat({ max: 1000 }),
  toIndex: fc.nat({ max: 1000 }),
  delayOffsetMs: fc.nat({ max: 100000 }),
  durationOffsetMs: fc.nat({ max: 100000 }),
  easing: bezierArb,
  transformMatrix: fc.constant(null),
});

/** A StateMap with a (possibly empty) list of transitions. */
const stateMapArb: fc.Arbitrary<StateMap> = fc.record({
  sessionId: fc.string(),
  transitions: fc.array(transitionArb, { maxLength: 12 }),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Export_Payload Assembler — Property 17: Figma timing token cubic-bezier format and round-trip (Req 6.2)", () => {
  it("formats any CubicBezier as a cubic-bezier(...) string that parses back to the original coordinates", () => {
    fc.assert(
      fc.property(bezierArb, (bezier) => {
        const token = formatCubicBezier(bezier);

        // Format: a `cubic-bezier( ... )` string with four comma-separated parts.
        expect(token.startsWith("cubic-bezier(")).toBe(true);
        expect(token.endsWith(")")).toBe(true);
        const inner = token.slice("cubic-bezier(".length, -1);
        expect(inner.split(",")).toHaveLength(4);

        // Round-trip: parsing recovers the exact coordinates.
        const parsed = parseCubicBezierToken(token);
        expect(parsed).not.toBeNull();
        expect(parsed).toEqual(bezier);
      }),
      { numRuns: 200 },
    );
  });

  it("emits StateMap transition timing tokens in cubic-bezier(...) form that round-trip to the transition easing", () => {
    fc.assert(
      fc.property(stateMapArb, (stateMap) => {
        // A constant clock keeps the pass within budget so all timing tokens
        // are emitted (we are validating token format, not the budget path).
        const result = assembleExportPayload({ stateMap, now: () => 0 });
        expect(result.overrun).toBe(false);

        stateMap.transitions.forEach((transition, i) => {
          const token = result.payload.figmaTokens.find(
            (t) => t.name === `transition/${i}/timing`,
          );
          expect(token).toBeDefined();

          const value = token!.value;
          expect(value.startsWith("cubic-bezier(")).toBe(true);
          expect(value.endsWith(")")).toBe(true);

          const parsed = parseCubicBezierToken(value);
          expect(parsed).toEqual(transition.easing);
        });
      }),
      { numRuns: 200 },
    );
  });
});

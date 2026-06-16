// Feature: ui-motion-grabber, Property 13: Animation delivery classification
//
// Validates: Requirements 5.2
//
// Property 13 (design.md "Correctness Properties"):
//   For any set of animation descriptors, the Reverse_Engineering_Engine SHALL
//   classify the delivery method as Web Animations API ("WAAPI") when
//   programmatic animations are present and as CSS transitions otherwise.
//
// We generate arbitrary arrays of AnimationDescriptor with mixed `delivery`
// values and assert the classification rule against an independent oracle:
//   - "WAAPI"            when ANY descriptor has delivery === "WAAPI"
//   - "CSS transitions"  when NO descriptor is WAAPI (including the empty list)
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { classifyDelivery } from "../../src/worker/reverse-engineering-engine.ts";
import type { AnimationDescriptor, CubicBezier } from "../../src/shared/index.ts";

const NUM_RUNS = 200;

/** A small, valid CubicBezier; the actual coordinates are irrelevant here. */
const cubicBezierArb: fc.Arbitrary<CubicBezier> = fc.record({
  x1: fc.double({ min: 0, max: 1, noNaN: true }),
  y1: fc.double({ min: -2, max: 2, noNaN: true }),
  x2: fc.double({ min: 0, max: 1, noNaN: true }),
  y2: fc.double({ min: -2, max: 2, noNaN: true }),
});

/** An arbitrary, well-formed AnimationDescriptor with a chosen delivery. */
const descriptorArb = (
  delivery: AnimationDescriptor["delivery"],
): fc.Arbitrary<AnimationDescriptor> =>
  fc.record({
    delivery: fc.constant(delivery),
    properties: fc.array(
      fc.constantFrom("transform", "opacity", "top", "width", "margin", "color"),
      { maxLength: 4 },
    ),
    easing: cubicBezierArb,
    durationMs: fc.double({ min: 0, max: 5000, noNaN: true }),
  });

/** Any descriptor (WAAPI or CSS transitions). */
const anyDescriptorArb: fc.Arbitrary<AnimationDescriptor> = fc.oneof(
  descriptorArb("WAAPI"),
  descriptorArb("CSS transitions"),
);

describe("Reverse_Engineering_Engine — Property 13: Animation delivery classification (Req 5.2)", () => {
  it("classifies WAAPI iff any programmatic animation is present, CSS transitions otherwise", () => {
    fc.assert(
      fc.property(fc.array(anyDescriptorArb, { maxLength: 12 }), (animations) => {
        const expected = animations.some((a) => a.delivery === "WAAPI")
          ? "WAAPI"
          : "CSS transitions";
        expect(classifyDelivery(animations)).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("classifies any list containing at least one WAAPI descriptor as WAAPI", () => {
    // Guarantee at least one WAAPI descriptor by injecting one at a random index.
    const withWaapiArb = fc
      .record({
        before: fc.array(anyDescriptorArb, { maxLength: 6 }),
        waapi: descriptorArb("WAAPI"),
        after: fc.array(anyDescriptorArb, { maxLength: 6 }),
      })
      .map(({ before, waapi, after }) => [...before, waapi, ...after]);

    fc.assert(
      fc.property(withWaapiArb, (animations) => {
        expect(classifyDelivery(animations)).toBe("WAAPI");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("classifies lists of only CSS-transition descriptors as CSS transitions", () => {
    fc.assert(
      fc.property(
        fc.array(descriptorArb("CSS transitions"), { maxLength: 12 }),
        (animations) => {
          expect(classifyDelivery(animations)).toBe("CSS transitions");
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("classifies the empty list as CSS transitions", () => {
    expect(classifyDelivery([])).toBe("CSS transitions");
  });
});

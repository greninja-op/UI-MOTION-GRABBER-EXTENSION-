// Feature: ui-motion-grabber, Property 15: Architectural_Report contains the derived facts
//
// Validates: Requirements 5.5
//
// Property 15 (design.md "Correctness Properties"):
//   For any completed analysis, the generated Architectural_Report markdown
//   string SHALL contain the classified layout strategy, the classified
//   animation delivery method, and the performance classification of each
//   animated property.
//
// Strategy:
//   We generate arbitrary ReportInput values (a computed `display`, a list of
//   active animations, and an explicit list of animated property names) and
//   assert that `generateReport` embeds every derived fact:
//     1. the layout strategy label returned by `classifyLayout`,
//     2. the delivery-method label returned by `classifyDelivery`, and
//     3. for every audited property, a row carrying that property's name and
//        its `classifyProperty` performance classification.
//   Generators intentionally cover both the "known" buckets (flex/grid display,
//   WAAPI animations, composite-friendly / layout-triggering properties) and
//   arbitrary fall-through values so the property holds across the whole input
//   space, not just the happy path.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  generateReport,
  classifyLayout,
  classifyDelivery,
  classifyProperty,
  type ReportInput,
} from "../../src/worker/reverse-engineering-engine.ts";
import type {
  AnimationDescriptor,
  CubicBezier,
} from "../../src/shared/index.ts";

// A small cubic-bezier arbitrary; the exact coordinates are irrelevant to the
// report content but the shape must be valid.
const bezierArb: fc.Arbitrary<CubicBezier> = fc.record({
  x1: fc.double({ min: 0, max: 1, noNaN: true }),
  y1: fc.double({ min: 0, max: 1, noNaN: true }),
  x2: fc.double({ min: 0, max: 1, noNaN: true }),
  y2: fc.double({ min: 0, max: 1, noNaN: true }),
});

// Display values: mix the recognized layout keywords (and case/whitespace
// variants) with arbitrary strings that classify as "Other".
const displayArb = fc.oneof(
  fc.constantFrom(
    "flex",
    "inline-flex",
    "grid",
    "inline-grid",
    " FLEX ",
    "Grid",
    "block",
    "inline",
    "contents",
  ),
  fc.string(),
);

const computedArb = displayArb.map((display) => ({ display }));

// Property names: blend the known performance buckets with arbitrary tokens.
// We avoid backtick / pipe characters so the generated markdown table row we
// build for the assertion matches the implementation's row verbatim.
const propertyNameArb = fc.oneof(
  fc.constantFrom(
    "transform",
    "opacity",
    "top",
    "width",
    "margin",
    "color",
    "left",
    "height",
  ),
  fc
    .string({ minLength: 1, maxLength: 12 })
    .filter((s) => !/[`|\n]/.test(s) && s.trim() !== ""),
);

const animationArb: fc.Arbitrary<AnimationDescriptor> = fc.record({
  delivery: fc.constantFrom("WAAPI", "CSS transitions") as fc.Arbitrary<
    AnimationDescriptor["delivery"]
  >,
  properties: fc.array(propertyNameArb, { maxLength: 4 }),
  easing: bezierArb,
  durationMs: fc.double({ min: 0, max: 5000, noNaN: true }),
});

const reportInputArb: fc.Arbitrary<ReportInput> = fc.record({
  computed: computedArb,
  animations: fc.array(animationArb, { maxLength: 5 }),
  // Explicit animated-property list, non-empty so the performance section is
  // populated. The derived-from-animations path is covered separately below.
  animatedProperties: fc.array(propertyNameArb, { minLength: 1, maxLength: 6 }),
});

/** Build the exact markdown table row the implementation emits for a property. */
function expectedRow(property: string): string {
  return `| \`${property}\` | ${classifyProperty(property)} |`;
}

describe("Reverse_Engineering_Engine — Property 15: Architectural_Report contains the derived facts (Req 5.5)", () => {
  it("embeds the layout strategy, delivery method, and every property's classification", () => {
    fc.assert(
      fc.property(reportInputArb, (input) => {
        const report = generateReport(input);

        // 1. Classified layout strategy is present.
        const layout = classifyLayout(input.computed);
        expect(report).toContain(layout);

        // 2. Classified delivery method is present.
        const delivery = classifyDelivery(input.animations);
        expect(report).toContain(delivery);

        // 3. Each audited property's name and performance classification is
        //    present as its own table row.
        for (const property of input.animatedProperties ?? []) {
          expect(report).toContain(expectedRow(property));
        }
      }),
      { numRuns: 200 },
    );
  });

  it("derives the audited properties from the animations when no explicit list is given", () => {
    const withoutExplicitList = fc.record({
      computed: computedArb,
      animations: fc.array(animationArb, { minLength: 1, maxLength: 5 }),
    });

    fc.assert(
      fc.property(withoutExplicitList, (input) => {
        const report = generateReport(input);

        expect(report).toContain(classifyLayout(input.computed));
        expect(report).toContain(classifyDelivery(input.animations));

        // Distinct, non-empty property names collected from the descriptors
        // must each appear with their classification.
        const derived = new Set<string>();
        for (const animation of input.animations) {
          for (const property of animation.properties) {
            if (typeof property === "string" && property.trim() !== "") {
              derived.add(property);
            }
          }
        }
        for (const property of derived) {
          expect(report).toContain(expectedRow(property));
        }
      }),
      { numRuns: 200 },
    );
  });

  it("states that no animated properties were detected when none are derivable", () => {
    fc.assert(
      fc.property(computedArb, (computed) => {
        const report = generateReport({ computed, animations: [] });
        expect(report).toContain(classifyLayout(computed));
        expect(report).toContain("CSS transitions");
        expect(report).toContain("No animated properties were detected.");
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: ui-motion-grabber, Property 10: Transform matrix present iff a transform is present
//
// Validates: Requirements 3.3
//
// Property 10 (design.md "Correctness Properties"):
//   For any transition, its `transformMatrix` SHALL be non-null when the
//   transition's (destination) state includes a transform and SHALL be null
//   otherwise (transform: none / absent => null).
//
// Strategy: generate arbitrary Interaction_Timelines whose entries carry a
// `cssText` that *sometimes* declares a transform (e.g. matrix(...),
// translateX(...), scale(...), rotate(...), matrix3d(...)) and *sometimes* does
// not (transform: none, an empty transform value, or no transform declaration
// at all). Each entry also carries decoy declarations that must NOT be mistaken
// for a transform — notably `transform-origin: ...` (a different property) and
// `will-change: transform` (the word "transform" appearing as a value, not a
// property name). For every entry we know, independently of the implementation,
// whether a real transform is present; `diff` derives each transition from its
// destination entry, so we assert the iff relationship per transition.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { diff } from "../../src/worker/state-diffing-engine.ts";
import type { TimelineEntry } from "../../src/shared/index.ts";

/**
 * Transform *values* that constitute a real, present transform. None of these
 * normalize to the empty string or to `none`, so each implies a non-null
 * transform matrix.
 */
const PRESENT_TRANSFORMS = [
  "matrix(1, 0, 0, 1, 10, 20)",
  "matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, 5,10,0,1)",
  "translateX(10px)",
  "translate(5px, 8px)",
  "translateY(-3.5px)",
  "scale(2)",
  "scale(1.5, 0.5)",
  "rotate(45deg)",
  "translateX(10px) rotate(30deg)",
  "skewX(12deg) scale(0.75)",
] as const;

/**
 * Transform values that count as ABSENT (no transform present): the literal
 * `none` in assorted casings/whitespace, and the empty value.
 */
const ABSENT_TRANSFORM_VALUES = ["none", "NONE", "  none  ", "None", ""] as const;

/**
 * Decoy declarations that mention "transform" textually but are NOT a
 * `transform` declaration with a real value. These must never flip the result
 * to non-null on their own.
 */
const DECOYS = [
  "color: red",
  "opacity: 0.5",
  "top: 10px",
  "width: 50%",
  "transform-origin: center", // different property — must not match `transform`
  "will-change: transform", // "transform" as a value — must not match
  "transition: transform 200ms ease-out", // shorthand value — must not match
  "backface-visibility: hidden",
] as const;

/**
 * Describes one timeline entry's transform situation together with the
 * independently-known oracle flag `hasTransform`.
 */
type TransformSpec =
  | { hasTransform: true; decl: string }
  | { hasTransform: false; decl: string | null };

const transformSpecArb: fc.Arbitrary<TransformSpec> = fc.oneof(
  // Present transform.
  fc.constantFrom(...PRESENT_TRANSFORMS).map(
    (value): TransformSpec => ({ hasTransform: true, decl: `transform: ${value}` }),
  ),
  // Declared transform that is none/empty -> absent.
  fc.constantFrom(...ABSENT_TRANSFORM_VALUES).map(
    (value): TransformSpec => ({ hasTransform: false, decl: `transform: ${value}` }),
  ),
  // No transform declaration at all -> absent.
  fc.constant<TransformSpec>({ hasTransform: false, decl: null }),
);

/** A single entry spec: a timestamp, its transform situation, and decoys. */
const entrySpecArb = fc.record({
  ts: fc.integer({ min: 0, max: 100_000 }),
  transform: transformSpecArb,
  // A subset of decoys, plus a flag for whether the transform decl (if any)
  // is placed before or after the decoys, to exercise declaration ordering.
  decoys: fc.subarray([...DECOYS]),
  transformFirst: fc.boolean(),
});

type EntrySpec = {
  ts: number;
  transform: TransformSpec;
  decoys: string[];
  transformFirst: boolean;
};

/** Build a TimelineEntry (and its oracle flag) from an entry spec. */
function buildEntry(spec: EntrySpec): { entry: TimelineEntry; hasTransform: boolean } {
  const parts: string[] = [];
  if (spec.transform.decl !== null && spec.transformFirst) {
    parts.push(spec.transform.decl);
  }
  parts.push(...spec.decoys);
  if (spec.transform.decl !== null && !spec.transformFirst) {
    parts.push(spec.transform.decl);
  }

  const cssText = parts.join("; ");
  const className = "node";
  return {
    entry: {
      timestamp: spec.ts,
      className,
      cssText,
      structuralSignature: className + cssText,
    },
    hasTransform: spec.transform.hasTransform,
  };
}

describe("State_Diffing_Engine — Property 10: transform matrix present iff a transform is present (Req 3.3)", () => {
  it("sets transformMatrix non-null exactly when the destination state has a transform", () => {
    fc.assert(
      fc.property(
        fc.array(entrySpecArb, { minLength: 0, maxLength: 40 }),
        fc.string(),
        (specs, sessionId) => {
          const built = specs.map(buildEntry);
          const timeline = built.map((b) => b.entry);

          const stateMap = diff(timeline, sessionId);

          // Guard against a degenerate, vacuously-true result.
          expect(stateMap.transitions.length).toBe(Math.max(0, timeline.length - 1));

          // diff derives each transition from its DESTINATION entry (index i+1).
          stateMap.transitions.forEach((transition, i) => {
            const destinationHasTransform = built[i + 1].hasTransform;

            if (destinationHasTransform) {
              // A transform is present => matrix must be a non-null number[].
              expect(transition.transformMatrix).not.toBeNull();
              expect(Array.isArray(transition.transformMatrix)).toBe(true);
            } else {
              // No transform (none / empty / absent) => matrix must be null.
              expect(transition.transformMatrix).toBeNull();
            }
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it("treats transform-origin and `will-change: transform` decoys as no transform", () => {
    // Targeted examples: decoys that textually contain "transform" must not be
    // mistaken for a real transform declaration.
    const make = (cssText: string): TimelineEntry => ({
      timestamp: 0,
      className: "n",
      cssText,
      structuralSignature: "n" + cssText,
    });

    const decoyOnly = make("transform-origin: center; will-change: transform");
    const realTransform = make("transform: scale(2)");

    const stateMap = diff([decoyOnly, realTransform], "s");
    expect(stateMap.transitions).toHaveLength(1);
    // Destination (realTransform) has a transform -> non-null.
    expect(stateMap.transitions[0].transformMatrix).not.toBeNull();

    // Reverse order: destination is the decoy-only state -> null.
    const reversed = diff([realTransform, decoyOnly], "s");
    expect(reversed.transitions[0].transformMatrix).toBeNull();
  });
});

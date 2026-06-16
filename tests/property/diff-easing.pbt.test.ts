// Feature: ui-motion-grabber, Property 9: Every transition carries a valid normalized easing
//
// Validates: Requirements 3.2
//
// Property 9 (design.md "Correctness Properties"):
//   For any Interaction_Timeline, every transition in the resulting State_Map
//   SHALL carry an easing expressed as a CubicBezier with finite numeric
//   coordinates.
//
// Strategy: generate arbitrary Interaction_Timelines whose entries carry a wide
// range of `cssText` easing values — recognized keywords, explicit
// cubic-bezier() declarations (valid and malformed), garbage strings, and empty
// styles — then run them through the State_Diffing_Engine's `diff` and assert
// that EVERY produced transition has an `easing` that is a CubicBezier object
// with four finite numeric coordinates (x1, y1, x2, y2). The diff falls back to
// `linear` when no easing can be extracted, so the invariant must hold even for
// garbage input.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { diff } from "../../src/worker/state-diffing-engine.ts";
import type { CubicBezier, TimelineEntry } from "../../src/shared/index.ts";

/**
 * A deliberately diverse pool of `cssText` snippets covering the easing space:
 *  - empty / no easing
 *  - every recognized keyword (including ones embedded in shorthand)
 *  - explicit cubic-bezier() with finite, negative, and fractional args
 *  - malformed cubic-bezier() (too few args, non-numeric, NaN/Infinity tokens)
 *  - garbage / decoy tokens (e.g. "release" must not match "ease")
 */
const CSS_TEXT_POOL = [
  "",
  "color: red;",
  "transition: all 0.3s ease;",
  "transition-timing-function: ease-in;",
  "transition: transform 200ms ease-out;",
  "animation: spin 1s ease-in-out infinite;",
  "transition-timing-function: linear;",
  "transition: opacity 0.2s cubic-bezier(0.1, 0.2, 0.3, 0.4);",
  "transition-timing-function: cubic-bezier(-0.5, 1.5, 0.25, -0.75);",
  "transition-timing-function: cubic-bezier(0, 0, 1, 1);",
  // Malformed / hostile easing values — must fall back to a finite default.
  "transition-timing-function: cubic-bezier(1, 2);",
  "transition-timing-function: cubic-bezier(a, b, c, d);",
  "transition-timing-function: cubic-bezier(NaN, Infinity, 0, 1);",
  "transition: all 0.3s release;", // decoy: contains "ease" only inside a word
  "transform: scale(2); top: 10px; width: 50%;",
  "will-change: transform; backface-visibility: hidden;",
  "@@@ garbage ;;; not-a-property ::: cubic-bezier(",
] as const;

/** Build a well-formed TimelineEntry from a timestamp and a cssText snippet. */
function makeEntry(timestamp: number, cssText: string): TimelineEntry {
  const className = "node";
  return {
    timestamp,
    className,
    cssText,
    structuralSignature: className + cssText,
  };
}

/** Assert a value is a CubicBezier with four finite numeric coordinates. */
function expectFiniteCubicBezier(easing: CubicBezier): void {
  expect(easing).toBeTypeOf("object");
  expect(easing).not.toBeNull();
  for (const coord of [easing.x1, easing.y1, easing.x2, easing.y2]) {
    expect(typeof coord).toBe("number");
    expect(Number.isFinite(coord)).toBe(true);
  }
}

describe("State_Diffing_Engine — Property 9: every transition carries a valid normalized easing (Req 3.2)", () => {
  it("produces a finite-coordinate CubicBezier easing for every transition", () => {
    fc.assert(
      fc.property(
        // A timeline of entries; each entry pairs a monotonic-ish timestamp with
        // an easing-bearing cssText drawn from the diverse pool above.
        fc.array(
          fc.record({
            ts: fc.integer({ min: 0, max: 100_000 }),
            cssText: fc.constantFrom(...CSS_TEXT_POOL),
          }),
          { minLength: 0, maxLength: 40 },
        ),
        fc.string(),
        (rows, sessionId) => {
          const timeline = rows.map((r) => makeEntry(r.ts, r.cssText));

          const stateMap = diff(timeline, sessionId);

          // Core invariant: every transition has a finite-coordinate easing.
          for (const transition of stateMap.transitions) {
            expectFiniteCubicBezier(transition.easing);
          }

          // Sanity on transition count so a degenerate (always-empty) result
          // cannot vacuously satisfy the property.
          expect(stateMap.transitions.length).toBe(
            Math.max(0, timeline.length - 1),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

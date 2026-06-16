// Feature: ui-motion-grabber, Property 8: Diff offsets and transition count
//
// Validates: Requirements 3.1, 3.4
//
// Property 8 (design.md "Correctness Properties"):
//   For any Interaction_Timeline of N entries, the State_Diffing_Engine SHALL
//   produce exactly `max(0, N-1)` transitions, and each transition's
//   delay/duration offset SHALL equal the timestamp difference of its
//   consecutive entries (non-negative for a monotonically increasing timeline).
//
// We exercise three facets:
//   1. Transition count == max(0, N-1) across arbitrary timelines, including the
//      boundary cases of empty (N=0) and single-entry (N=1) timelines.
//   2. Every transition's delayOffsetMs and durationOffsetMs equal the timestamp
//      difference of the two consecutive entries it links, and fromIndex/toIndex
//      reference those consecutive entries.
//   3. For a monotonically increasing timeline, every offset is non-negative.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { diff } from "../../src/worker/state-diffing-engine.ts";
import type { TimelineEntry } from "../../src/shared/types";

/** Generator for a single TimelineEntry with an arbitrary (finite) timestamp. */
function entryArb(timestampArb: fc.Arbitrary<number>): fc.Arbitrary<TimelineEntry> {
  return fc.record({
    timestamp: timestampArb,
    className: fc.string(),
    cssText: fc.string(),
    structuralSignature: fc.string(),
  });
}

/** Arbitrary timelines (including empty and single-entry) with free timestamps. */
const arbitraryTimelineArb = fc.array(
  entryArb(fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true })),
  { minLength: 0, maxLength: 50 },
);

/**
 * A monotonically increasing timeline: accumulate non-negative deltas so each
 * timestamp is >= the previous one, mirroring a real `performance.now()` clock.
 */
const monotonicTimelineArb = fc
  .record({
    start: fc.double({ min: 0, max: 1e6, noNaN: true, noDefaultInfinity: true }),
    deltas: fc.array(
      fc.double({ min: 0, max: 1e4, noNaN: true, noDefaultInfinity: true }),
      { minLength: 0, maxLength: 50 },
    ),
    meta: fc.array(
      fc.record({ className: fc.string(), cssText: fc.string(), structuralSignature: fc.string() }),
      { minLength: 51, maxLength: 51 },
    ),
  })
  .map(({ start, deltas, meta }) => {
    const entries: TimelineEntry[] = [];
    let t = start;
    // One more entry than deltas so deltas describe the gaps between entries.
    for (let i = 0; i <= deltas.length; i++) {
      if (i > 0) t += deltas[i - 1];
      entries.push({
        timestamp: t,
        className: meta[i].className,
        cssText: meta[i].cssText,
        structuralSignature: meta[i].structuralSignature,
      });
    }
    return entries;
  });

describe("State_Diffing_Engine — Property 8: Diff offsets and transition count (Req 3.1, 3.4)", () => {
  it("produces exactly max(0, N-1) transitions whose offsets equal consecutive timestamp differences", () => {
    fc.assert(
      fc.property(arbitraryTimelineArb, (timeline) => {
        const { transitions } = diff(timeline);

        // Req 3.4 / Property 8: exactly max(0, N-1) transitions.
        const expectedCount = Math.max(0, timeline.length - 1);
        expect(transitions.length).toBe(expectedCount);

        // Req 3.1 / Property 8: each transition links consecutive entries and its
        // delay/duration offsets equal their timestamp difference.
        transitions.forEach((tr, i) => {
          expect(tr.fromIndex).toBe(i);
          expect(tr.toIndex).toBe(i + 1);
          const expectedOffset = timeline[i + 1].timestamp - timeline[i].timestamp;
          expect(tr.delayOffsetMs).toBe(expectedOffset);
          expect(tr.durationOffsetMs).toBe(expectedOffset);
        });
      }),
      { numRuns: 200 },
    );
  });

  it("yields zero transitions for empty and single-entry timelines", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant<TimelineEntry[]>([]),
          entryArb(fc.double({ noNaN: true, noDefaultInfinity: true })).map((e) => [e]),
        ),
        (timeline) => {
          expect(diff(timeline).transitions).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("produces non-negative offsets for a monotonically increasing timeline", () => {
    fc.assert(
      fc.property(monotonicTimelineArb, (timeline) => {
        const { transitions } = diff(timeline);

        expect(transitions.length).toBe(Math.max(0, timeline.length - 1));
        for (const tr of transitions) {
          expect(tr.delayOffsetMs).toBeGreaterThanOrEqual(0);
          expect(tr.durationOffsetMs).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// Feature: ui-motion-grabber, Property 5: Frame_Guard debounce
//
// Validates: Requirements 2.4
//
// Property 5 (design.md "Correctness Properties"):
//   For any sequence of mutation timestamps, the Mutation_Engine SHALL drop
//   every mutation occurring less than 16ms after the previously *processed*
//   mutation, and SHALL process every mutation occurring 16ms or more after the
//   previously processed mutation.
//
// We drive the engine through an injected, controllable `now` clock so we can
// feed arbitrary timestamp sequences, and force a *changing* Structural_Signature
// before every `handle()` (by mutating the observed target's className). That
// makes the Frame_Guard the sole deciding gate: any drop/append outcome is
// attributable to the 16ms debounce, never to the signature dedup gate.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
// @ts-expect-error — Content_Script is pure unbundled Vanilla JS (no .d.ts).
import { createMutationEngine, FRAME_GUARD_MS } from "../../src/content/mutation-engine.js";

/**
 * Minimal fake MutationObserver: the engine only needs `observe`/`disconnect`
 * on the instance it constructs. The callback is retained but never invoked —
 * the test drives `handle()` directly so timestamps are fully deterministic.
 */
class FakeObserver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(_callback: any) {}
  observe() {}
  disconnect() {}
}

/**
 * A single delta generator biased toward the 16ms boundary so the property is
 * exercised right at the inclusive `>= 16` cutoff, while still covering a broad
 * numeric range. Deltas are non-negative so cumulative timestamps stay
 * monotonically non-decreasing, mirroring `performance.now()`.
 */
const deltaArb = fc.oneof(
  fc.constantFrom(0, 1, 15, 16, 17, 31, 32),
  fc.integer({ min: 0, max: 250 }),
);

const timestampsArb = fc
  .array(deltaArb, { minLength: 1, maxLength: 40 })
  .map((deltas) => {
    // Build a monotonically non-decreasing timestamp sequence from deltas,
    // starting at an arbitrary-but-fixed base.
    let t = 1000;
    return deltas.map((d) => (t += d));
  });

describe("Mutation_Engine — Property 5: Frame_Guard debounce (Req 2.4)", () => {
  it("drops mutations < 16ms after the last processed one and processes those >= 16ms", () => {
    fc.assert(
      fc.property(timestampsArb, (timestamps) => {
        const timeline: Array<{ timestamp: number }> = [];
        let clock = Number.NEGATIVE_INFINITY;

        const engine = createMutationEngine({
          timeline,
          now: () => clock,
          ObserverCtor: FakeObserver,
        });

        const target = document.createElement("div");
        engine.attach(target);

        // Reference model: the debounce is measured against the previously
        // *processed* (appended) timestamp, not the previous attempt. A dropped
        // mutation does NOT advance the reference point.
        let lastProcessed = Number.NEGATIVE_INFINITY;
        const expectedProcessed: boolean[] = [];
        const expectedTimeline: number[] = [];

        timestamps.forEach((ts, i) => {
          // Force a brand-new Structural_Signature so the signature gate always
          // passes and the Frame_Guard alone decides the outcome.
          target.className = `state-${i}`;
          clock = ts;

          const appended = engine.handle([]);

          const shouldProcess = ts - lastProcessed >= FRAME_GUARD_MS;
          expectedProcessed.push(shouldProcess);
          if (shouldProcess) {
            lastProcessed = ts;
            expectedTimeline.push(ts);
          }

          // The engine's per-mutation decision matches the debounce rule.
          expect(appended).toBe(shouldProcess);
        });

        // Exactly the processed mutations were appended, in order, with their
        // own timestamps.
        expect(timeline.map((e) => e.timestamp)).toEqual(expectedTimeline);

        // Every appended pair of consecutive entries is >= 16ms apart, and no
        // dropped mutation was within the window of a processed one.
        for (let i = 1; i < timeline.length; i++) {
          expect(timeline[i].timestamp - timeline[i - 1].timestamp).toBeGreaterThanOrEqual(
            FRAME_GUARD_MS,
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  it("processes a mutation exactly at the 16ms boundary (inclusive cutoff)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (base) => {
        const timeline: Array<{ timestamp: number }> = [];
        let clock = Number.NEGATIVE_INFINITY;
        const engine = createMutationEngine({
          timeline,
          now: () => clock,
          ObserverCtor: FakeObserver,
        });
        const target = document.createElement("div");
        engine.attach(target);

        // First mutation always processes.
        target.className = "a";
        clock = base;
        expect(engine.handle([])).toBe(true);

        // Exactly FRAME_GUARD_MS later -> processed (>= is inclusive).
        target.className = "b";
        clock = base + FRAME_GUARD_MS;
        expect(engine.handle([])).toBe(true);

        // One millisecond short of the window -> dropped.
        target.className = "c";
        clock = base + FRAME_GUARD_MS + (FRAME_GUARD_MS - 1);
        expect(engine.handle([])).toBe(false);

        expect(timeline.length).toBe(2);
      }),
      { numRuns: 200 },
    );
  });
});

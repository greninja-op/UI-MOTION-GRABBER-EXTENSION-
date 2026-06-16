// Feature: ui-motion-grabber, Property 6: Structural_Signature dedup, update, and append
//
// Validates: Requirements 2.5, 2.6, 2.7
//
// Property 6 (design.md "Correctness Properties"):
//   For any sequence of (className, cssText) mutations that pass the Frame_Guard,
//   the Mutation_Engine SHALL drop any mutation whose signature equals the cached
//   signature, and for every mutation it does not drop it SHALL update the cached
//   signature to the new className + cssText and append exactly one timestamped
//   entry to the Interaction_Timeline. Consequently no two consecutive timeline
//   entries share a Structural_Signature.
//
// We isolate the Structural_Signature gate by injecting a `now` clock that always
// advances >= FRAME_GUARD_MS between calls, so the Frame_Guard never drops a
// mutation and the signature gate is the sole deciding factor. Each mutation sets
// the fake Target_Element's className/cssText then calls `handle`, and we compare
// the engine's drop/append/update behavior against an independent reference model.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  createMutationEngine,
  structuralSignature,
  FRAME_GUARD_MS,
  // @ts-expect-error — Content_Script is pure unbundled Vanilla JS (no .d.ts).
} from "../../src/content/mutation-engine.js";

/** A minimal fake Target_Element node exposing only what the engine reads. */
interface FakeTarget {
  className: string;
  style: { cssText: string };
}

function makeFakeTarget(): FakeTarget {
  return { className: "", style: { cssText: "" } };
}

/** A no-op MutationObserver stand-in so `attach` can bind without a real DOM. */
class FakeObserver {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor, @typescript-eslint/no-unused-vars
  constructor(_callback: unknown) {}
  observe(): void {}
  disconnect(): void {}
}

/**
 * Small, deliberately collision-prone value pools: reusing a handful of
 * className / cssText values guarantees the generated sequences contain both
 * duplicate (drop) and changed (append) transitions.
 */
const CLASS_NAMES = ["", "a", "b", "kinetic-hover-node", "open active"] as const;
const CSS_TEXTS = ["", "color: red;", "transform: scale(2);", "top: 10px;"] as const;

const mutationArb = fc.record({
  className: fc.constantFrom(...CLASS_NAMES),
  cssText: fc.constantFrom(...CSS_TEXTS),
});

describe("Mutation_Engine — Property 6: Structural_Signature dedup/update/append (Req 2.5, 2.6, 2.7)", () => {
  it("drops signature duplicates, updates the cache, and appends one entry per processed mutation", () => {
    fc.assert(
      fc.property(
        fc.array(mutationArb, { minLength: 1, maxLength: 40 }),
        // A start time plus a per-step advance >= FRAME_GUARD_MS so the
        // Frame_Guard never interferes (the signature gate decides everything).
        // Integer timestamps keep the clock arithmetic exact, so each step is
        // guaranteed to be >= FRAME_GUARD_MS with no floating-point rounding
        // pushing a gap just under the threshold.
        fc.integer({ min: 0, max: 1_000 }),
        fc.integer({ min: FRAME_GUARD_MS, max: 1_000 }),
        (mutations, start, step) => {
          const target = makeFakeTarget();

          // `now()` is read exactly once per `handle` call; advance it by `step`
          // (>= FRAME_GUARD_MS) every read so each mutation clears the guard.
          let calls = 0;
          const now = () => start + step * calls++;

          const engine = createMutationEngine({
            now,
            ObserverCtor: FakeObserver as unknown as new (cb: unknown) => unknown,
          });
          engine.attach(target);

          // Independent reference model of the expected behavior.
          let modelCached: string | null = null;
          const expectedTimeline: Array<{
            timestamp: number;
            className: string;
            cssText: string;
            structuralSignature: string;
          }> = [];

          mutations.forEach((m, i) => {
            target.className = m.className;
            target.style.cssText = m.cssText;

            const signature = structuralSignature(target);
            const expectedTimestamp = start + step * i;
            const expectDrop = signature === modelCached;

            // Snapshot the cached signature before processing to assert the
            // "update only when not dropped" rule (Req 2.6).
            const cachedBefore = engine.cachedSignature;

            const appended = engine.handle([]);

            if (expectDrop) {
              // Req 2.5: duplicate signature is dropped, nothing changes.
              expect(appended).toBe(false);
              expect(engine.cachedSignature).toBe(cachedBefore);
            } else {
              // Req 2.6 + 2.7: cache updated to the new signature and exactly
              // one timestamped entry appended.
              expect(appended).toBe(true);
              expect(engine.cachedSignature).toBe(signature);
              modelCached = signature;
              expectedTimeline.push({
                timestamp: expectedTimestamp,
                className: m.className,
                cssText: m.cssText,
                structuralSignature: signature,
              });
            }
          });

          // The engine's timeline matches the reference model exactly:
          // one entry per processed (non-dropped) mutation, in order (Req 2.7).
          expect(engine.timeline).toEqual(expectedTimeline);

          // Consequence: no two consecutive timeline entries share a signature.
          for (let i = 1; i < engine.timeline.length; i++) {
            expect(engine.timeline[i].structuralSignature).not.toBe(
              engine.timeline[i - 1].structuralSignature,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

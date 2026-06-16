// Feature: ui-motion-grabber, Property 22: Pause disconnects the observer; resume rebinds a fresh observer
//
// Validates: Requirements 11.3, 11.4, 11.5
//
// Property 22 (design.md "Correctness Properties"):
//   For any Recording_Session and any sequence of pause/resume operations with
//   mutations interleaved, while the Recording_Status is Paused the
//   MutationObserver SHALL be disconnected and no entries SHALL be appended to
//   the Interaction_Timeline; and on every Paused -> Recording transition the
//   Session_Controller SHALL bind a NEW MutationObserver instance (distinct from
//   any prior instance) to the cached Target_Element node.
//
// Strategy:
//   We inject a fake ObserverCtor that assigns each constructed instance a
//   unique identity and records its observe()/disconnect() calls, plus a
//   controllable `now` clock. We lock a Target_Element (Idle -> Recording) and
//   then drive an arbitrary interleaving of pause/resume/mutate operations.
//   After every operation we assert the lifecycle invariants:
//     - While Paused: the engine has no live observer (it was disconnected) and
//       a delivered mutation appends nothing (Req 11.3, 11.5).
//     - While Recording: a delivered mutation (fresh signature, >= 16ms apart)
//       appends exactly one entry.
//     - Each Paused -> Recording transition produces a brand-new observer
//       instance, distinct from every prior instance, bound to the cached
//       Target_Element node (Req 11.4).
import { describe, it, expect } from "vitest";
import fc from "fast-check";
// @ts-expect-error — Content_Script is pure unbundled Vanilla JS (no .d.ts).
import { createMutationEngine } from "../../src/content/mutation-engine.js";
// @ts-expect-error — Content_Script is pure unbundled Vanilla JS (no .d.ts).
import {
  createSessionController,
  RECORDING_STATUS,
  // @ts-expect-error — see above.
} from "../../src/content/session-controller.js";

/** Tag names used to fabricate an arbitrary Target_Element node. */
const TAG_NAMES = ["div", "section", "span", "button", "a", "p", "ul", "li", "article"] as const;

/** The interleaved lifecycle operations we drive after the initial lock. */
type Op = "pause" | "resume" | "mutate";

/**
 * Build a fake MutationObserver constructor whose instances each carry a unique
 * identity and record what they observed and how many times they were
 * disconnected. All instances are pushed into the shared `instances` sink so
 * the test can reason about observer identity across the lifecycle.
 */
function makeTrackingObserverCtor(instances: FakeObserver[]) {
  let counter = 0;
  class FakeObserver {
    readonly id: number;
    readonly observed: Array<{ node: Node; config: unknown }> = [];
    disconnectCount = 0;
    connected = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_callback: any) {
      this.id = ++counter;
      instances.push(this);
    }
    observe(node: Node, config: unknown): void {
      this.observed.push({ node, config });
      this.connected = true;
    }
    disconnect(): void {
      this.disconnectCount += 1;
      this.connected = false;
    }
    takeRecords(): MutationRecord[] {
      return [];
    }
  }
  // The sink stores instances typed as FakeObserver via structural typing.
  return FakeObserver as unknown as new (cb: MutationCallback) => FakeObserver;
}

/** Local structural type mirroring the tracking observer instances. */
interface FakeObserver {
  id: number;
  observed: Array<{ node: Node; config: unknown }>;
  disconnectCount: number;
  connected: boolean;
}

const targetSpecArb = fc.record({
  tag: fc.constantFrom(...TAG_NAMES),
  className: fc.string({ maxLength: 12 }),
  style: fc.constantFrom("", "color: red;", "transform: scale(2);", "top: 10px;"),
});

const opsArb = fc.array(fc.constantFrom<Op>("pause", "resume", "mutate"), {
  minLength: 1,
  maxLength: 40,
});

describe("Session_Controller — Property 22: pause disconnects, resume rebinds a fresh observer (Req 11.3, 11.4, 11.5)", () => {
  it("keeps the observer disconnected with zero appends while Paused, and binds a NEW observer to the cached target on each resume", () => {
    fc.assert(
      fc.property(targetSpecArb, opsArb, (spec, ops) => {
        document.body.innerHTML = "";
        const target = document.createElement(spec.tag);
        if (spec.className) target.className = spec.className;
        if (spec.style) target.setAttribute("style", spec.style);
        document.body.appendChild(target);

        // Controllable clock + tracking observer factory.
        let clock = 0;
        const instances: FakeObserver[] = [];
        const timeline: Array<{ timestamp: number }> = [];
        const engine = createMutationEngine({
          timeline,
          now: () => clock,
          ObserverCtor: makeTrackingObserverCtor(instances),
        });
        const controller = createSessionController({ mutationEngine: engine });

        // Idle -> Recording: caches the Target_Element and binds observer #1.
        controller.lock(target);
        expect(controller.getStatus()).toBe(RECORDING_STATUS.RECORDING);
        expect(instances).toHaveLength(1);
        expect(engine.observer).toBe(instances[0]);
        expect(instances[0].observed).toHaveLength(1);
        expect(instances[0].observed[0].node).toBe(target);

        // Reference model: which observer instances have ever been bound, and
        // the expected number of appended entries.
        let seenObserverIds = new Set<number>([instances[0].id]);
        let expectedAppends = 0;
        let mutationSeq = 0;

        for (const op of ops) {
          const statusBefore = controller.getStatus();

          if (op === "pause") {
            const liveBefore = engine.observer as FakeObserver | null;
            controller.pause();

            if (statusBefore === RECORDING_STATUS.RECORDING) {
              // Recording -> Paused: the observer is disconnected immediately.
              expect(controller.getStatus()).toBe(RECORDING_STATUS.PAUSED);
              expect(engine.observer).toBeNull();
              expect(engine.target).toBeNull();
              if (liveBefore) {
                expect(liveBefore.disconnectCount).toBeGreaterThanOrEqual(1);
                expect(liveBefore.connected).toBe(false);
              }
            } else {
              // No-op when not Recording.
              expect(controller.getStatus()).toBe(statusBefore);
            }
          } else if (op === "resume") {
            const instancesBefore = instances.length;
            controller.resume();

            if (statusBefore === RECORDING_STATUS.PAUSED) {
              // Paused -> Recording: a BRAND-NEW observer instance is bound to
              // the cached Target_Element (Req 11.4).
              expect(controller.getStatus()).toBe(RECORDING_STATUS.RECORDING);
              expect(instances.length).toBe(instancesBefore + 1);
              const fresh = engine.observer as FakeObserver;
              expect(fresh).toBe(instances[instances.length - 1]);
              // Distinct identity from every observer ever bound before.
              expect(seenObserverIds.has(fresh.id)).toBe(false);
              seenObserverIds.add(fresh.id);
              // Bound to the cached Target_Element node.
              expect(controller.getTarget()).toBe(target);
              expect(fresh.observed).toHaveLength(1);
              expect(fresh.observed[0].node).toBe(target);
            } else {
              // No-op when not Paused — no new observer constructed.
              expect(controller.getStatus()).toBe(statusBefore);
              expect(instances.length).toBe(instancesBefore);
            }
          } else {
            // op === "mutate": deliver a fresh, > 16ms-apart mutation.
            clock += 20;
            target.className = `kinetic-state-${mutationSeq++}`;
            const appended = engine.handle([]);

            if (controller.getStatus() === RECORDING_STATUS.PAUSED) {
              // While Paused no entries are appended (Req 11.5): the observer is
              // disconnected and the engine has no target to read.
              expect(appended).toBe(false);
            } else {
              // While Recording the mutation is captured.
              expect(appended).toBe(true);
              expectedAppends += 1;
            }
            expect(timeline.length).toBe(expectedAppends);
          }
        }

        // No mutation was ever appended while Paused — the running tally only
        // grew on Recording-state mutations.
        expect(timeline.length).toBe(expectedAppends);
      }),
      { numRuns: 200 },
    );
  });
});

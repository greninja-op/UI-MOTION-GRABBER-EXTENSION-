// Feature: ui-motion-grabber, Property 21: Teardown leaves zero retained resources
//
// Validates: Requirements 1.8, 10.3, 10.4
//
// Property 21 (design.md "Correctness Properties"):
//   For any sequence of Recording_Session start/stop cycles, after a session
//   reaches Stopped the System SHALL have disconnected the MutationObserver,
//   removed every listener attached to the host page, and retained zero
//   observer/listener references for that session.
//
// Strategy: drive arbitrary lock/pause/resume/stop cycles through a real
// Session_Controller wired to a real Mutation_Engine (with a fake ObserverCtor
// that tracks connect/disconnect per instance) and a real Picker (with a fake
// `root` that tracks add/removeEventListener so net listeners can be asserted).
// After forcing the session to Stopped we assert:
//   - every MutationObserver ever created is disconnected,
//   - the engine retains no observer/target reference (observer/target null),
//   - every listener the Picker attached to the host page has been removed
//     (net listener count on the fake root is zero),
//   - the controller released its cached Target_Element (getTarget() null),
//   - and the invariants still hold after an idempotent second stop().
import { describe, it, expect } from "vitest";
import fc from "fast-check";
// @ts-expect-error — Content_Script is pure unbundled Vanilla JS (no .d.ts).
import { createSessionController } from "../../src/content/session-controller.js";
// @ts-expect-error — Content_Script is pure unbundled Vanilla JS (no .d.ts).
import { createMutationEngine } from "../../src/content/mutation-engine.js";
// @ts-expect-error — Content_Script is pure unbundled Vanilla JS (no .d.ts).
import { createPicker } from "../../src/content/picker.js";

/** The lifecycle operations we drive against the Session_Controller. */
type Op = "lock" | "pause" | "resume" | "stop";

/**
 * Fake MutationObserver constructor that records, per instance, whether it is
 * currently connected. `observe()` marks it connected; `disconnect()` marks it
 * disconnected and bumps a disconnect counter. All created instances are pushed
 * to `instances` so the test can assert that none remain connected.
 */
function makeObserverTracking() {
  const instances: Array<{ connected: boolean; disconnects: number }> = [];
  class FakeObserver {
    private readonly state: { connected: boolean; disconnects: number };
    constructor(_callback: MutationCallback) {
      this.state = { connected: false, disconnects: 0 };
      instances.push(this.state);
    }
    observe(_node: Node, _config: unknown): void {
      this.state.connected = true;
    }
    disconnect(): void {
      this.state.connected = false;
      this.state.disconnects += 1;
    }
    takeRecords(): MutationRecord[] {
      return [];
    }
  }
  return { Ctor: FakeObserver, instances };
}

/** A single tracked registration on the fake host-page root. */
interface Registration {
  type: string;
  handler: EventListener;
  options: unknown;
}

/**
 * Fake host-page event target that tracks the live set of attached listeners.
 * `addEventListener` appends a registration; `removeEventListener` removes the
 * matching one (by type+handler+options reference, mirroring how the Picker
 * removes with the exact same frozen options object). `active` is the net set
 * of listeners still attached — it MUST be empty after teardown (Req 1.8/10.4).
 */
function makeFakeRoot() {
  const active: Registration[] = [];
  const root = {
    active,
    addEventListener(type: string, handler: EventListener, options: unknown): void {
      active.push({ type, handler, options });
    },
    removeEventListener(type: string, handler: EventListener, options: unknown): void {
      const idx = active.findIndex(
        (r) => r.type === type && r.handler === handler && r.options === options,
      );
      if (idx !== -1) {
        active.splice(idx, 1);
      }
    },
  };
  return root;
}

/** No-op Highlighter so the Picker stays decoupled from real DOM in this test. */
function makeFakeHighlighter() {
  return { highlight: (_el: Element | null) => {}, clear: () => {} };
}

const opsArb = fc.array(fc.constantFrom<Op>("lock", "pause", "resume", "stop"), {
  maxLength: 12,
});

describe("Session_Controller — Property 21: teardown leaves zero retained resources (Req 1.8, 10.3, 10.4)", () => {
  it("after reaching Stopped: observer disconnected, listeners removed, refs released", () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        const { Ctor, instances } = makeObserverTracking();
        const root = makeFakeRoot();

        const mutationEngine = createMutationEngine({ ObserverCtor: Ctor });
        const picker = createPicker({
          root,
          highlighter: makeFakeHighlighter(),
        });
        const controller = createSessionController({ mutationEngine, picker });

        // Simulate Picker_Mode being active during the session so there are
        // real host-page listeners that teardown must remove.
        picker.activate();
        expect(root.active.length).toBeGreaterThan(0);

        const target = document.createElement("div");

        // Drive the arbitrary lifecycle sequence.
        for (const op of ops) {
          switch (op) {
            case "lock":
              controller.lock(target);
              break;
            case "pause":
              controller.pause();
              break;
            case "resume":
              controller.resume();
              break;
            case "stop":
              controller.stop();
              break;
          }
        }

        // Force the session to Stopped regardless of the generated sequence.
        controller.stop();

        // --- Post-Stopped invariants ------------------------------------
        expect(controller.getStatus()).toBe("Stopped");

        // Observer: every observer ever created is disconnected (none retained
        // in a connected state), and the engine drops its observer reference.
        for (const inst of instances) {
          expect(inst.connected).toBe(false);
        }
        expect(mutationEngine.observer).toBeNull();
        expect(mutationEngine.target).toBeNull();

        // Listeners: every host-page listener the Picker attached is removed.
        expect(root.active.length).toBe(0);
        expect(picker.isActive()).toBe(false);

        // References: the cached Target_Element is released.
        expect(controller.getTarget()).toBeNull();

        // Idempotency: a second stop() leaves the same zero-retained state.
        controller.stop();
        expect(mutationEngine.observer).toBeNull();
        expect(mutationEngine.target).toBeNull();
        expect(root.active.length).toBe(0);
        expect(controller.getTarget()).toBeNull();
        for (const inst of instances) {
          expect(inst.connected).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });
});

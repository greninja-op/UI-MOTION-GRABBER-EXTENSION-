import { describe, it, expect, vi } from "vitest";
// @ts-expect-error — Content_Script is pure unbundled Vanilla JS (no .d.ts).
import { createMutationEngine, OBSERVER_CONFIG } from "../../src/content/mutation-engine.js";

/**
 * Unit test for Task 4.5 — observer wiring.
 *
 * Requirements:
 *   2.1 — When a Target_Element is locked, the Mutation_Engine SHALL bind a
 *         MutationObserver to the Target_Element node.
 *   2.3 — When configuring the MutationObserver, the Mutation_Engine SHALL
 *         restrict the `attributeFilter` to `["class", "style"]`.
 *
 * Strategy: inject a fake `ObserverCtor` whose instances record their
 * `observe(node, config)` calls, then call `attach(target)` with a fake target
 * and assert `observe` was called once with that exact node and the strict
 * `{ attributes: true, attributeFilter: ["class", "style"] }` config.
 */
describe("Mutation_Engine — observer wiring (Req 2.1, 2.3)", () => {
  it("calls observe() with the target node and the strict class/style config", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();

    // Fake MutationObserver constructor; instances record observe() calls.
    class FakeObserver {
      callback: unknown;
      constructor(callback: unknown) {
        this.callback = callback;
      }
      observe(node: unknown, config: unknown) {
        observe(node, config);
      }
      disconnect() {
        disconnect();
      }
    }

    // A fake target node — attach() only needs a truthy node to bind to.
    const target = { id: "fake-target" };

    const engine = createMutationEngine({ ObserverCtor: FakeObserver as never });
    engine.attach(target as never);

    // observe() called exactly once, with the exact target node.
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0][0]).toBe(target);

    // ...and with the strict class/style attribute filter config.
    expect(observe.mock.calls[0][1]).toEqual({
      attributes: true,
      attributeFilter: ["class", "style"],
    });
  });

  it("passes the exported OBSERVER_CONFIG, frozen with the strict filter", () => {
    const observe = vi.fn();

    class FakeObserver {
      constructor(_callback: unknown) {}
      observe(node: unknown, config: unknown) {
        observe(node, config);
      }
      disconnect() {}
    }

    const target = { id: "fake-target" };
    const engine = createMutationEngine({ ObserverCtor: FakeObserver as never });
    engine.attach(target as never);

    // The config handed to observe() is the canonical OBSERVER_CONFIG.
    expect(observe.mock.calls[0][1]).toBe(OBSERVER_CONFIG);
    expect(OBSERVER_CONFIG).toEqual({
      attributes: true,
      attributeFilter: ["class", "style"],
    });
  });
});

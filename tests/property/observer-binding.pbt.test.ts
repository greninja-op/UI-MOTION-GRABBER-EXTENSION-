// Feature: ui-motion-grabber, Property 7: Observer bound only to the Target_Element
//
// Validates: Requirements 2.2
//
// Property 7 (design.md "Correctness Properties"):
//   For any locked Target_Element, the MutationObserver SHALL be bound to that
//   element node and SHALL never be bound to the global `document` or the
//   `body` element.
//
// We verify the property by injecting a fake ObserverCtor that records every
// node passed to `observe()`. For each generated arbitrary target node we call
// `attach(target)` and assert the observer was bound to EXACTLY that node, with
// the strict `{ attributes: true, attributeFilter: ["class","style"] }` config,
// and never to `document` or `document.body` (which we register as decoys).
import { describe, it, expect } from "vitest";
import fc from "fast-check";
// @ts-expect-error — Content_Script is pure unbundled Vanilla JS (no .d.ts).
import { createMutationEngine, OBSERVER_CONFIG } from "../../src/content/mutation-engine.js";

/** Tag names used to fabricate arbitrary target element nodes. */
const TAG_NAMES = ["div", "section", "span", "button", "a", "p", "ul", "li", "article"] as const;

/** A single record of what was passed to `observe(node, config)`. */
interface ObserveCall {
  node: Node;
  config: unknown;
}

/**
 * Build a fresh fake ObserverCtor that records every `observe` call into the
 * supplied sink. The constructor signature matches the global MutationObserver
 * (it receives the engine's callback, which we ignore for this property).
 */
function makeRecordingObserverCtor(calls: ObserveCall[]) {
  return class FakeObserver {
    constructor(_callback: MutationCallback) {}
    observe(node: Node, config: unknown): void {
      calls.push({ node, config });
    }
    disconnect(): void {}
    takeRecords(): MutationRecord[] {
      return [];
    }
  };
}

const targetSpecArb = fc.record({
  tag: fc.constantFrom(...TAG_NAMES),
  className: fc.string({ maxLength: 12 }),
  style: fc.constantFrom("", "color: red;", "transform: scale(2);", "top: 10px;"),
});

describe("Mutation_Engine — Property 7: observer bound only to the Target_Element (Req 2.2)", () => {
  it("binds the observer to exactly the supplied target node, never document/body", () => {
    fc.assert(
      fc.property(targetSpecArb, (spec) => {
        // Register document and body as decoys that must NEVER be observed.
        document.body.innerHTML = "";

        const target = document.createElement(spec.tag);
        if (spec.className) target.className = spec.className;
        if (spec.style) target.setAttribute("style", spec.style);
        document.body.appendChild(target);

        const calls: ObserveCall[] = [];
        const engine = createMutationEngine({
          ObserverCtor: makeRecordingObserverCtor(calls),
        });

        engine.attach(target);

        // Exactly one observe call, bound to exactly the target node.
        expect(calls).toHaveLength(1);
        expect(calls[0].node).toBe(target);

        // Never the global document or the body element (decoys).
        expect(calls[0].node).not.toBe(document);
        expect(calls[0].node).not.toBe(document.body);

        // Strict class/style attribute filter config.
        expect(calls[0].config).toEqual(OBSERVER_CONFIG);
        expect(calls[0].config).toEqual({
          attributes: true,
          attributeFilter: ["class", "style"],
        });
      }),
      { numRuns: 200 },
    );
  });
});

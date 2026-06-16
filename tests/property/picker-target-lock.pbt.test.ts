// Feature: ui-motion-grabber, Property 3: Clicked element becomes the Target_Element
//
// Validates: Requirements 1.6
//
// Property 3 (design.md "Correctness Properties"):
//   For any element clicked while Picker_Mode is active, that exact element
//   SHALL become the Recording_Session's Target_Element.
//
// We verify the property by driving the Picker's click handler against an
// arbitrary host DOM. For each generated tree we pick an arbitrary element as
// the one "under the pointer" at click time and assert that the picker locks
// that exact element node — observable both through `getTarget()` and through
// the injected `onTargetLocked` callback.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
// @ts-expect-error — Content_Script is pure unbundled Vanilla JS (no .d.ts).
import { createPicker } from "../../src/content/picker.js";

/** Tag names we build the arbitrary host DOM from. */
const TAG_NAMES = ["div", "section", "span", "button", "a", "p", "ul", "li", "article"] as const;

/**
 * Builds a flat host DOM of `count` elements (with arbitrary tags/classes/inline
 * styles) attached to `document.body`, returning the created element nodes.
 */
function buildHostDom(
  specs: ReadonlyArray<{ tag: string; className: string; style: string }>,
): Element[] {
  document.body.innerHTML = "";
  return specs.map((spec) => {
    const el = document.createElement(spec.tag);
    if (spec.className) el.className = spec.className;
    if (spec.style) el.setAttribute("style", spec.style);
    document.body.appendChild(el);
    return el;
  });
}

/** A minimal synthetic click Event whose target/coords are controllable. */
function makeClickEvent(
  target: Element,
  coords: { clientX: number; clientY: number } | null,
): Event {
  const event = {
    type: "click",
    target,
    stopPropagation() {},
    preventDefault() {},
    ...(coords ?? {}),
  } as unknown as Event;
  return event;
}

const elementSpecArb = fc.record({
  tag: fc.constantFrom(...TAG_NAMES),
  className: fc.string({ maxLength: 12 }),
  style: fc.constantFrom("", "color: red;", "transform: scale(2);", "top: 10px;"),
});

describe("Picker — Property 3: clicked element becomes the Target_Element (Req 1.6)", () => {
  it("locks the exact clicked element as the Target_Element across arbitrary DOMs", () => {
    fc.assert(
      fc.property(
        // A non-empty set of element specs...
        fc.array(elementSpecArb, { minLength: 1, maxLength: 8 }),
        // ...an index selecting which element is "clicked"...
        fc.nat(),
        // ...and whether the click carries pointer coordinates (resolve path)
        // or only an event target (fallback path). Both must lock the element.
        fc.boolean(),
        (specs, rawIndex, useCoords) => {
          const elements = buildHostDom(specs);
          const clicked = elements[rawIndex % elements.length];

          let lockedViaCallback: Element | null = null;
          const picker = createPicker({
            root: document,
            // Simulate elementFromPoint resolving to the clicked node.
            resolve: () => clicked,
            onTargetLocked: (el: Element) => {
              lockedViaCallback = el;
            },
          });

          picker.activate();

          const coords = useCoords ? { clientX: 5, clientY: 7 } : null;
          picker.onClick(makeClickEvent(clicked, coords));

          // The exact clicked node is locked as the Target_Element (Req 1.6)...
          expect(picker.getTarget()).toBe(clicked);
          // ...and surfaced to the Session_Controller via the callback.
          expect(lockedViaCallback).toBe(clicked);
        },
      ),
      { numRuns: 200 },
    );
  });
});

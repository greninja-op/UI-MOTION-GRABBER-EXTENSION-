// Feature: ui-motion-grabber, Property 19: Overlay isolation against host styles
//
// Validates: Requirements 8.3
//
// Property 19: Overlay isolation against host styles.
//   For any host stylesheet, including rules marked `!important`, the Overlay_UI
//   rendered inside its isolated Shadow_Root with `all: initial` SHALL compute to
//   its own declared styles rather than the host's.
//
// Strategy & jsdom caveat:
//   jsdom does not perform layout and `getComputedStyle` does not resolve
//   cascaded `!important` rules across a Shadow_Root boundary, so we cannot
//   meaningfully assert *computed* pixel values here. Instead we validate the
//   concrete isolation guarantees the implementation actually provides — the
//   same guarantees a real browser relies on to deliver the computed-style
//   outcome:
//     (a) The root stylesheet's leading declaration is always `all: initial`,
//         independent of whatever arbitrary host rules (including `!important`)
//         are generated. `all: initial` resets every inheritable/non-inheritable
//         property so nothing leaks in via inheritance.
//     (b) Mounting attaches an OPEN Shadow_Root whose FIRST <style> element's
//         text begins with the `all: initial` reset (the reset wins the cascade
//         within the shadow tree because it is declared first and host rules
//         cannot cross the shadow boundary).
//     (c) Arbitrary host `!important` rules injected into the host document do
//         NOT appear inside the overlay's shadow root content — the shadow tree
//         is encapsulated from the host stylesheet entirely.

import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
// @ts-expect-error — Content_Script is pure unbundled Vanilla JS (no .d.ts).
import {
  OverlayUIHost,
  OVERLAY_CONTAINER_ID,
  ROOT_STYLE_RESET,
  buildRootStyleText,
} from "../../src/content/overlay-ui.js";

/** CSS properties a host page might try to force onto descendants. */
const HOST_PROPERTIES = [
  "color",
  "background",
  "background-color",
  "font-size",
  "font-family",
  "position",
  "display",
  "width",
  "height",
  "margin",
  "padding",
  "border",
  "z-index",
  "opacity",
  "transform",
  "visibility",
  "pointer-events",
];

const HOST_VALUES = [
  "red",
  "blue",
  "#123456",
  "rgb(10, 20, 30)",
  "999px",
  "0",
  "none",
  "block",
  "inline",
  "absolute",
  "hidden",
  "2147483647",
  "0.1",
  "translateX(50px)",
  "Comic Sans MS",
];

/** A single host CSS rule, optionally marked `!important`. */
interface HostRule {
  selector: string;
  property: string;
  value: string;
  important: boolean;
}

/** fast-check arbitrary for an aggressive host stylesheet rule. */
function hostRuleArb(): fc.Arbitrary<HostRule> {
  return fc.record({
    selector: fc.constantFrom("*", "div", "body", "html *", "#app", ".overlay", ":host"),
    property: fc.constantFrom(...HOST_PROPERTIES),
    value: fc.constantFrom(...HOST_VALUES),
    important: fc.boolean(),
  });
}

/** Serialize host rules into a CSS stylesheet string. */
function renderHostStylesheet(rules: HostRule[]): string {
  return rules
    .map(
      (r) =>
        `${r.selector} { ${r.property}: ${r.value}${r.important ? " !important" : ""}; }`,
    )
    .join("\n");
}

/** Inject a host <style> stylesheet into the document head. */
function injectHostStylesheet(css: string): HTMLStyleElement {
  const style = document.createElement("style");
  style.setAttribute("data-host-style", "true");
  style.textContent = css;
  document.head.appendChild(style);
  return style;
}

function cleanupDocument(): void {
  document
    .querySelectorAll('style[data-host-style="true"]')
    .forEach((el) => el.remove());
  document
    .querySelectorAll(`#${OVERLAY_CONTAINER_ID}`)
    .forEach((el) => el.remove());
}

afterEach(() => {
  cleanupDocument();
});

describe("Property 19: Overlay isolation against host styles (Req 8.3)", () => {
  it("isolates the overlay shadow tree from arbitrary host !important rules", () => {
    fc.assert(
      fc.property(
        fc.array(hostRuleArb(), { minLength: 1, maxLength: 12 }),
        (hostRules) => {
          // 1. Apply an arbitrary, aggressive host stylesheet to the document.
          const hostCss = renderHostStylesheet(hostRules);
          injectHostStylesheet(hostCss);

          // 2. Mount the overlay against the host document via the injectable seam.
          const host = new OverlayUIHost({
            document,
            // Provide a deterministic scheduler so construction never touches
            // live timers; this property is about style isolation, not rAF.
            requestAnimationFrame: () => 0,
            cancelAnimationFrame: () => {},
            now: () => 0,
          });

          try {
            const shadowRoot = host.mount();

            // (b) An OPEN shadow root must be attached.
            expect(shadowRoot).toBeTruthy();
            expect(host.container).toBeTruthy();
            // The container exposes the same open shadow root.
            expect(host.container.shadowRoot).toBe(shadowRoot);

            // The first child of the shadow root is the reset stylesheet, and
            // its text begins with `all: initial` (after the `:host {` opener),
            // i.e. the reset is the leading declaration that wins the cascade.
            const firstStyle = shadowRoot.querySelector("style");
            expect(firstStyle).toBeTruthy();
            expect(shadowRoot.firstChild).toBe(firstStyle);

            const styleText = firstStyle.textContent ?? "";
            // The reset declaration is the first declaration inside `:host`.
            const firstDeclaration = styleText
              .slice(styleText.indexOf("{") + 1)
              .trimStart();
            expect(firstDeclaration.startsWith(ROOT_STYLE_RESET)).toBe(true);

            // (c) None of the arbitrary host rules leak into the shadow content.
            // The overlay's own stylesheet is the only style inside the shadow
            // tree, and it never carries the host's selectors/values/!important.
            const shadowHtml = shadowRoot.innerHTML;
            expect(shadowHtml).not.toContain("!important");
            expect(shadowHtml).not.toContain("data-host-style");

            // The overlay shadow content equals exactly the reset stylesheet —
            // host rules cannot cross the shadow boundary.
            expect(styleText).toBe(buildRootStyleText());
          } finally {
            host.unmount();
            cleanupDocument();
          }

          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("keeps `all: initial` as the leading declaration regardless of host rules", () => {
    // The reset text is host-independent: buildRootStyleText() always leads with
    // `all: initial`, so no host stylesheet (however aggressive) can change it.
    fc.assert(
      fc.property(fc.array(hostRuleArb(), { maxLength: 12 }), (hostRules) => {
        injectHostStylesheet(renderHostStylesheet(hostRules));
        const text = buildRootStyleText();
        const firstDeclaration = text.slice(text.indexOf("{") + 1).trimStart();
        expect(firstDeclaration.startsWith(ROOT_STYLE_RESET)).toBe(true);
        cleanupDocument();
        return true;
      }),
      { numRuns: 100 },
    );
  });
});

// UI Motion Grabber — Target_Element capture (Content_Script subsystem)
// Pure Vanilla JavaScript, zero dependencies, unbundled.
//
// The capture layer is what actually reads the Target_Element from the live
// page: its computed styles, its declared transitions/animations, and its
// markup. Without this, the Service_Worker pipeline runs on an empty payload
// and produces an empty report — so this module is what turns the tool from
// "diffs class/style mutations" into "reverse-engineers how the element is
// built".
//
// On capture we produce, for one element:
//   - html       the element's outerHTML (clean, length-capped)
//   - css        a readable CSS rule built from a curated computed-style set
//   - computed   a ComputedStyleSnapshot (drives layout classification, Req 5.1)
//   - animations AnimationDescriptors derived from the computed
//                transition/animation properties AND any live Web Animations
//                (drives delivery + performance classification, Req 5.2-5.4)
//
// These ride along in the TIMELINE_CHUNK payload to the Service_Worker, which
// already consumes `computed` / `animations` / `codeTabs`.

/**
 * The curated set of computed properties surfaced in the CSS code tab and the
 * ComputedStyleSnapshot. Chosen to describe layout, box model, typography, and
 * motion without dumping all ~350 computed properties.
 * @type {readonly string[]}
 */
export const CAPTURED_PROPERTIES = Object.freeze([
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "box-sizing",
  "width",
  "height",
  "margin",
  "padding",
  "border",
  "border-radius",
  "box-shadow",
  "color",
  "background-color",
  "background",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "text-align",
  "flex-direction",
  "justify-content",
  "align-items",
  "gap",
  "grid-template-columns",
  "grid-template-rows",
  "opacity",
  "transform",
  "transform-origin",
  "transition-property",
  "transition-duration",
  "transition-timing-function",
  "transition-delay",
  "animation-name",
  "animation-duration",
  "animation-timing-function",
  "animation-delay",
  "animation-iteration-count",
  "will-change",
  "filter",
  "cursor",
]);

/** Values treated as "no meaningful declaration" and dropped from the CSS tab. */
const NOISE_VALUES = new Set([
  "",
  "none",
  "auto",
  "normal",
  "0s",
  "0px",
  "rgba(0, 0, 0, 0)",
  "transparent",
]);

/** Split a comma-separated computed list value (e.g. "opacity, transform"). */
function splitList(value) {
  if (!value) return [];
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

/** Parse a CSS time value ("0.3s" / "250ms") into milliseconds. */
function parseTimeMs(value) {
  if (!value) return 0;
  const v = value.trim();
  if (v.endsWith("ms")) return parseFloat(v) || 0;
  if (v.endsWith("s")) return (parseFloat(v) || 0) * 1000;
  return parseFloat(v) || 0;
}

/** Parse a `cubic-bezier(x1,y1,x2,y2)` string into a CubicBezier, else null. */
function parseCubicBezier(value) {
  const match = /cubic-bezier\(\s*([^)]+)\)/i.exec(value || "");
  if (!match) return null;
  const nums = match[1].split(",").map((n) => Number(n.trim()));
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) return null;
  return { x1: nums[0], y1: nums[1], x2: nums[2], y2: nums[3] };
}

/**
 * Normalize an easing token for transport: explicit `cubic-bezier(...)` values
 * become a CubicBezier object (preserved by the worker), keywords pass through
 * as strings (the worker maps them via its fixed table).
 */
function normalizeEasingToken(value) {
  const bezier = parseCubicBezier(value);
  return bezier || (typeof value === "string" ? value.trim() : "ease");
}

/** Build a short CSS selector for the element (tag + id + up to two classes). */
function buildSelector(el) {
  const tag = el.tagName ? el.tagName.toLowerCase() : "element";
  const id = el.id ? `#${el.id}` : "";
  let cls = "";
  if (typeof el.className === "string" && el.className.trim()) {
    cls = "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
  }
  return `${tag}${id}${cls}` || tag;
}

/**
 * Derive AnimationDescriptors from an element's declared CSS transitions and
 * @keyframes animations plus any live Web Animations. This is what lets the
 * report classify delivery method and audit animated-property performance even
 * when the element isn't mid-animation at capture time.
 *
 * @param {Element} el
 * @param {CSSStyleDeclaration} cs
 * @returns {Array<{delivery: string, properties: string[], easing: any, durationMs: number}>}
 */
function extractAnimations(el, cs) {
  const animations = [];

  // 1. Declared CSS transitions (the common case for micro-interactions).
  const props = splitList(cs.getPropertyValue("transition-property"));
  const durs = splitList(cs.getPropertyValue("transition-duration"));
  const eases = splitList(cs.getPropertyValue("transition-timing-function"));
  props.forEach((prop, i) => {
    if (!prop || prop === "none") return;
    const durationMs = parseTimeMs(durs[i] || durs[0] || "0s");
    // A `transition-property` with zero duration isn't an actual transition.
    if (durationMs <= 0) return;
    animations.push({
      delivery: "CSS transitions",
      properties: prop === "all" ? ["all"] : [prop],
      easing: normalizeEasingToken(eases[i] || eases[0] || "ease"),
      durationMs,
    });
  });

  // 2. Declared CSS @keyframes animations.
  const animName = cs.getPropertyValue("animation-name");
  if (animName && animName !== "none") {
    const names = splitList(animName);
    const aDurs = splitList(cs.getPropertyValue("animation-duration"));
    const aEases = splitList(cs.getPropertyValue("animation-timing-function"));
    names.forEach((_name, i) => {
      animations.push({
        delivery: "CSS transitions",
        properties: [],
        easing: normalizeEasingToken(aEases[i] || aEases[0] || "ease"),
        durationMs: parseTimeMs(aDurs[i] || aDurs[0] || "0s"),
      });
    });
  }

  // 3. Live Web Animations (programmatic = WAAPI; CSS-driven = transitions).
  if (typeof el.getAnimations === "function") {
    let live = [];
    try {
      live = el.getAnimations();
    } catch (_err) {
      live = [];
    }
    for (const anim of live) {
      const CssTransition = globalThis.CSSTransition;
      const CssAnimation = globalThis.CSSAnimation;
      const isCss =
        (typeof CssTransition === "function" && anim instanceof CssTransition) ||
        (typeof CssAnimation === "function" && anim instanceof CssAnimation);
      const effect = anim.effect;
      const timing =
        effect && typeof effect.getTiming === "function" ? effect.getTiming() : null;
      const properties = new Set();
      if (effect && typeof effect.getKeyframes === "function") {
        for (const kf of effect.getKeyframes()) {
          for (const key of Object.keys(kf)) {
            if (!["offset", "computedOffset", "easing", "composite"].includes(key)) {
              properties.add(key);
            }
          }
        }
      }
      animations.push({
        delivery: isCss ? "CSS transitions" : "WAAPI",
        properties: [...properties],
        easing: normalizeEasingToken(
          timing && typeof timing.easing === "string" ? timing.easing : "linear",
        ),
        durationMs:
          timing && typeof timing.duration === "number" ? timing.duration : 0,
      });
    }
  }

  return animations;
}

/** Build Figma design tokens from captured animation descriptors. */
function buildFigmaTokens(animations) {
  const tokens = [];
  animations.forEach((anim, i) => {
    const label =
      anim.properties && anim.properties.length ? anim.properties.join("+") : `motion-${i}`;
    const easingValue =
      anim.easing && typeof anim.easing === "object"
        ? `cubic-bezier(${anim.easing.x1},${anim.easing.y1},${anim.easing.x2},${anim.easing.y2})`
        : String(anim.easing);
    tokens.push({ name: `motion/${label}/duration`, value: `${anim.durationMs}ms` });
    tokens.push({ name: `motion/${label}/easing`, value: easingValue });
  });
  return tokens;
}

/**
 * Capture the Target_Element's markup, computed styles, declared animations,
 * and derived Figma tokens.
 *
 * @param {Element} el - the locked Target_Element.
 * @param {Window} [win] - window to read computed styles from (defaults to the
 *   element's owner document view, then the global `window`). Injectable for tests.
 * @returns {{ html: string, css: string, computed: object, animations: object[], figmaTokens: object[] }}
 */
export function captureElement(el, win) {
  const view =
    win ||
    (el && el.ownerDocument && el.ownerDocument.defaultView) ||
    (typeof window !== "undefined" ? window : null);

  if (!el || !view || typeof view.getComputedStyle !== "function") {
    return { html: "", css: "", computed: { display: "" }, animations: [], figmaTokens: [] };
  }

  const cs = view.getComputedStyle(el);

  // Computed snapshot — always carries `display` (drives layout classification).
  const computed = { display: cs.display };
  for (const prop of CAPTURED_PROPERTIES) {
    const value = cs.getPropertyValue(prop);
    if (value) {
      computed[prop] = value;
    }
  }

  // Readable CSS rule from the curated, non-noise declarations.
  const declarations = [];
  for (const prop of CAPTURED_PROPERTIES) {
    const value = cs.getPropertyValue(prop);
    if (value && !NOISE_VALUES.has(value.trim())) {
      declarations.push(`  ${prop}: ${value};`);
    }
  }
  const css = `${buildSelector(el)} {\n${declarations.join("\n")}\n}`;

  const animations = extractAnimations(el, cs);
  const figmaTokens = buildFigmaTokens(animations);

  // Markup — capped so a huge subtree can't bloat the message payload.
  const html = (el.outerHTML || "").slice(0, 20000);

  return { html, css, computed, animations, figmaTokens };
}

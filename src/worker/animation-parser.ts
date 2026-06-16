/**
 * Animation_Parser (Service_Worker component).
 *
 * Extracts computed styles and active programmatic animations from a
 * Target_Element and normalizes shorthand easing keywords to explicit
 * cubic-bezier coordinates.
 *
 * Design reference: design.md "Service_Worker Components -> Animation_Parser".
 * Requirements:
 *   - 4.1: extract computed styles via `window.getComputedStyle(target)`.
 *   - 4.2: query active animations via `target.getAnimations()`.
 *   - 4.3: convert easing keywords to explicit `cubic-bezier(x1,y1,x2,y2)`
 *          coordinates using a fixed conversion map.
 *
 * The CDP Coordinator (pseudo-state freezing, Req 4.4/4.5) is implemented
 * separately in task 8.2.
 */

import type {
  AnimationDescriptor,
  ComputedStyleSnapshot,
  CubicBezier,
} from "../shared/index.ts";

// ---------------------------------------------------------------------------
// Fixed easing conversion map (Req 4.3)
// ---------------------------------------------------------------------------

/**
 * The fixed keyword -> cubic-bezier conversion table from design.md.
 *
 * | Keyword       | cubic-bezier                    |
 * |---------------|---------------------------------|
 * | `linear`      | `cubic-bezier(0, 0, 1, 1)`      |
 * | `ease`        | `cubic-bezier(0.25, 0.1, 0.25, 1)` |
 * | `ease-in`     | `cubic-bezier(0.42, 0, 1, 1)`   |
 * | `ease-out`    | `cubic-bezier(0, 0, 0.58, 1)`   |
 * | `ease-in-out` | `cubic-bezier(0.42, 0, 0.58, 1)` |
 */
export const EASING_KEYWORD_MAP: Readonly<Record<string, CubicBezier>> = {
  linear: { x1: 0, y1: 0, x2: 1, y2: 1 },
  ease: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
  "ease-in": { x1: 0.42, y1: 0, x2: 1, y2: 1 },
  "ease-out": { x1: 0, y1: 0, x2: 0.58, y2: 1 },
  "ease-in-out": { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
} as const;

/** The fallback curve used when an easing value is not a known keyword. */
export const LINEAR_BEZIER: CubicBezier = EASING_KEYWORD_MAP.linear;

/**
 * The detailed result of normalizing an easing value. Exposes whether the
 * input was a recognized keyword so callers can flag unknown values that fell
 * back to `linear` (e.g., to surface a User_Feedback_Message).
 */
export interface NormalizedEasing {
  /** The resolved cubic-bezier curve. */
  easing: CubicBezier;
  /** `true` when `input` matched a known keyword; `false` on fallback. */
  recognized: boolean;
  /** The original input value, normalized for comparison (trimmed, lowercased). */
  input: string;
}

/**
 * Normalize an easing value, returning the resolved curve along with a flag
 * indicating whether the input was a recognized keyword.
 *
 * Unknown or malformed values fall back to `linear` with `recognized: false`.
 * This function NEVER throws — non-string inputs are coerced safely (Req 4.3).
 */
export function normalizeEasingResult(value: unknown): NormalizedEasing {
  const input = typeof value === "string" ? value.trim().toLowerCase() : "";
  const match = Object.prototype.hasOwnProperty.call(EASING_KEYWORD_MAP, input)
    ? EASING_KEYWORD_MAP[input]
    : undefined;

  if (match) {
    // Return a fresh object so callers cannot mutate the shared table entry.
    return { easing: { ...match }, recognized: true, input };
  }

  return { easing: { ...LINEAR_BEZIER }, recognized: false, input };
}

/**
 * Convert an easing keyword to its explicit cubic-bezier coordinates (Req 4.3).
 *
 * For any keyword in `{linear, ease, ease-in, ease-out, ease-in-out}` this
 * returns exactly the CubicBezier defined by the fixed conversion map. Unknown
 * values fall back to `linear`. This function NEVER throws.
 */
export function normalizeEasing(value: unknown): CubicBezier {
  return normalizeEasingResult(value).easing;
}

// ---------------------------------------------------------------------------
// Computed-style extraction (Req 4.1)
// ---------------------------------------------------------------------------

/**
 * Extract a ComputedStyleSnapshot for `target` via `window.getComputedStyle`
 * (Req 4.1).
 *
 * Every enumerable computed property is copied into a plain, JSON-serializable
 * object keyed by property name; `display` is always present.
 */
export function parseComputed(target: Element): ComputedStyleSnapshot {
  const declaration = window.getComputedStyle(target);

  const snapshot: ComputedStyleSnapshot = {
    display: declaration.display,
  };

  for (let index = 0; index < declaration.length; index += 1) {
    const property = declaration.item(index);
    if (property) {
      snapshot[property] = declaration.getPropertyValue(property);
    }
  }

  return snapshot;
}

// ---------------------------------------------------------------------------
// Active-animation extraction (Req 4.2)
// ---------------------------------------------------------------------------

/**
 * A minimal structural view of `Element.getAnimations()` so this module can be
 * exercised in environments where the full Web Animations API typing is absent.
 */
interface AnimationsTarget {
  getAnimations?: () => Animation[];
}

/** Determine whether an animation is CSS-driven (transition/keyframe) or WAAPI. */
function detectDelivery(animation: Animation): AnimationDescriptor["delivery"] {
  const cssTransition = (globalThis as { CSSTransition?: unknown }).CSSTransition;
  const cssAnimation = (globalThis as { CSSAnimation?: unknown }).CSSAnimation;

  if (
    typeof cssTransition === "function" &&
    animation instanceof (cssTransition as new () => Animation)
  ) {
    return "CSS transitions";
  }
  if (
    typeof cssAnimation === "function" &&
    animation instanceof (cssAnimation as new () => Animation)
  ) {
    return "CSS transitions";
  }

  // Animations created programmatically via `Element.animate()` are plain
  // `Animation` instances and are classified as Web Animations API delivery.
  return "WAAPI";
}

/** Keyframe keys that describe timing/composition rather than animated properties. */
const NON_PROPERTY_KEYFRAME_KEYS = new Set<string>([
  "offset",
  "computedOffset",
  "easing",
  "composite",
]);

/** Collect the set of animated property names from an animation's keyframes. */
function extractProperties(effect: AnimationEffect | null): string[] {
  const properties = new Set<string>();

  if (effect && typeof (effect as KeyframeEffect).getKeyframes === "function") {
    for (const keyframe of (effect as KeyframeEffect).getKeyframes()) {
      for (const key of Object.keys(keyframe)) {
        if (!NON_PROPERTY_KEYFRAME_KEYS.has(key)) {
          properties.add(key);
        }
      }
    }
  }

  return [...properties];
}

/**
 * Query active programmatic animations on `target` via `target.getAnimations()`
 * (Req 4.2) and map each to a normalized AnimationDescriptor.
 *
 * Easing values are normalized through the fixed conversion map (Req 4.3).
 * Returns an empty array when the target exposes no `getAnimations` method.
 */
export function parseAnimations(target: Element): AnimationDescriptor[] {
  const source = target as Element & AnimationsTarget;
  if (typeof source.getAnimations !== "function") {
    return [];
  }

  const animations = source.getAnimations();

  return animations.map((animation): AnimationDescriptor => {
    const effect = animation.effect;
    const timing = effect?.getTiming?.();

    const easingValue =
      timing && typeof timing.easing === "string" ? timing.easing : "linear";

    const duration = timing?.duration;
    const durationMs =
      typeof duration === "number" && Number.isFinite(duration) ? duration : 0;

    return {
      delivery: detectDelivery(animation),
      properties: extractProperties(effect),
      easing: normalizeEasing(easingValue),
      durationMs,
    };
  });
}

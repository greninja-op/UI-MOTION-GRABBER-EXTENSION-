/**
 * State_Diffing_Engine (Service_Worker)
 *
 * Consumes an Interaction_Timeline and computes per-transition metrics,
 * producing a State_Map (design.md "State_Diffing_Engine" / "Data Models").
 *
 * Responsibilities (task 7.1):
 *  - Compute delay/duration offsets between consecutive entries and produce
 *    exactly `max(0, N-1)` transitions (Req 3.1, 3.4).
 *  - Extract a normalized CubicBezier easing curve per transition (Req 3.2).
 *  - Extract a transform matrix when the transition's resulting state includes
 *    a transform, else `null` (Req 3.3).
 *  - Empty or single-entry timelines yield zero transitions.
 *
 * This module is an ES module and is the sole owner of timeline diffing
 * (Req 7.5: state diffing/transformation happens inside the Service_Worker).
 */

import type {
  CubicBezier,
  InteractionTimeline,
  StateMap,
  TimelineEntry,
  Transition,
} from "../shared/index.ts";

/**
 * Fixed keyword -> cubic-bezier conversion table (design.md "Animation_Parser"
 * easing map). Used here so every transition carries a valid normalized easing
 * (Req 3.2) without depending on the Animation_Parser, which is implemented
 * separately.
 */
const EASING_KEYWORD_TABLE: Readonly<Record<string, CubicBezier>> = {
  linear: { x1: 0, y1: 0, x2: 1, y2: 1 },
  ease: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
  "ease-in": { x1: 0.42, y1: 0, x2: 1, y2: 1 },
  "ease-out": { x1: 0, y1: 0, x2: 0.58, y2: 1 },
  "ease-in-out": { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
};

/** The default easing when no easing can be extracted from a state (linear). */
const DEFAULT_EASING: CubicBezier = EASING_KEYWORD_TABLE.linear;

/**
 * Compute the State_Map for an Interaction_Timeline.
 *
 * Produces exactly `max(0, N-1)` transitions for an N-entry timeline: empty and
 * single-entry timelines therefore yield zero transitions (Req 3.4).
 *
 * @param timeline  The time-ordered Interaction_Timeline.
 * @param sessionId The owning Recording_Session id (defaults to empty string).
 */
export function diff(
  timeline: InteractionTimeline,
  sessionId = "",
): StateMap {
  const entries = timeline ?? [];
  const transitions: Transition[] = [];

  for (let i = 0; i + 1 < entries.length; i++) {
    const from = entries[i];
    const to = entries[i + 1];

    // Req 3.1 / Property 8: both delay and duration offsets equal the timestamp
    // difference of the two consecutive entries (non-negative for a
    // monotonically increasing timeline).
    const offsetMs = to.timestamp - from.timestamp;

    transitions.push({
      fromIndex: i,
      toIndex: i + 1,
      delayOffsetMs: offsetMs,
      durationOffsetMs: offsetMs,
      // Req 3.2: a valid normalized easing extracted from the resulting state.
      easing: extractEasing(to),
      // Req 3.3: transform matrix when the resulting state has a transform.
      transformMatrix: extractTransformMatrix(to),
    });
  }

  return { sessionId, transitions };
}

/**
 * Extract the value of a single CSS declaration from an inline `cssText`
 * snapshot, e.g. `extractDeclaration("color: red; transform: none", "transform")`
 * returns `"none"`. Returns `null` when the property is absent.
 */
function extractDeclaration(cssText: string, property: string): string | null {
  if (!cssText) return null;
  for (const part of cssText.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    if (name === property) {
      return part.slice(colon + 1).trim();
    }
  }
  return null;
}

/**
 * Extract a normalized CubicBezier easing from a timeline entry's state.
 *
 * Looks for an explicit `cubic-bezier(...)` first (in any timing-function
 * declaration or the `transition`/`animation` shorthand), then a recognized
 * easing keyword. Falls back to `linear` so the result is always a CubicBezier
 * with finite coordinates (Req 3.2 / Property 9).
 */
function extractEasing(entry: TimelineEntry): CubicBezier {
  const cssText = entry.cssText ?? "";

  // 1. Explicit cubic-bezier() anywhere in the state's inline style.
  const bezier = parseCubicBezier(cssText);
  if (bezier) return bezier;

  // 2. A recognized easing keyword. Check the longest keywords first so
  //    `ease-in-out` is not shadowed by `ease-in` or `ease`.
  const lower = cssText.toLowerCase();
  const keywords = [
    "ease-in-out",
    "ease-in",
    "ease-out",
    "ease",
    "linear",
  ] as const;
  for (const keyword of keywords) {
    if (containsKeyword(lower, keyword)) {
      return EASING_KEYWORD_TABLE[keyword];
    }
  }

  // 3. Default.
  return DEFAULT_EASING;
}

/** Parse the first `cubic-bezier(x1,y1,x2,y2)` occurrence into a CubicBezier. */
function parseCubicBezier(value: string): CubicBezier | null {
  const match = /cubic-bezier\(\s*([^)]+)\)/i.exec(value);
  if (!match) return null;
  const nums = match[1]
    .split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n));
  if (nums.length < 4) return null;
  return { x1: nums[0], y1: nums[1], x2: nums[2], y2: nums[3] };
}

/**
 * Match an easing keyword as a whole token (delimited by start/end or a
 * non-identifier character) so `ease` does not match inside `release`.
 */
function containsKeyword(haystack: string, keyword: string): boolean {
  const escaped = keyword.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  return new RegExp(`(^|[^a-z-])${escaped}([^a-z-]|$)`, "i").test(haystack);
}

/**
 * Extract a transform matrix from a timeline entry's resulting state.
 *
 * Returns a numeric array when the state declares a transform other than
 * `none` (Req 3.3 / Property 10), and `null` when no transform is present.
 * `matrix(...)` / `matrix3d(...)` arguments are extracted directly; for other
 * transform functions the numeric arguments are collected in order.
 */
function extractTransformMatrix(entry: TimelineEntry): number[] | null {
  const transform = extractDeclaration(entry.cssText ?? "", "transform");
  if (transform === null) return null;

  const normalized = transform.trim().toLowerCase();
  if (normalized === "" || normalized === "none") return null;

  // Prefer an explicit matrix()/matrix3d() function when present.
  const matrixMatch = /matrix3?d?\(\s*([^)]+)\)/i.exec(transform);
  const source = matrixMatch ? matrixMatch[1] : transform;

  const numbers = (source.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [])
    .map(Number)
    .filter((n) => Number.isFinite(n));

  // A transform is present (non-none), so always return a non-null array,
  // even in the unusual case where it carries no numeric arguments.
  return numbers;
}

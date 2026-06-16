/**
 * Reverse_Engineering_Engine (Service_Worker component).
 *
 * Classifies how a Target_Element was built — its layout strategy, animation
 * delivery method, and the performance characteristics of its animated
 * properties — and packages those findings into a human-readable markdown
 * Architectural_Report.
 *
 * Design reference: design.md "Service_Worker Components -> Reverse_Engineering_Engine".
 * Requirements:
 *   - 5.1: classify layout strategy as Flexbox or Grid from computed `display`.
 *   - 5.2: classify animation delivery as Web Animations API or CSS transitions.
 *   - 5.3: classify `transform`/`opacity` as composite-friendly.
 *   - 5.4: classify `top`/`width`/`margin` as layout-triggering.
 *   - 5.5: generate a markdown Architectural_Report describing all three.
 */

import type {
  AnimationDescriptor,
  ComputedStyleSnapshot,
} from "../shared/index.ts";

// ---------------------------------------------------------------------------
// Classification result types
// ---------------------------------------------------------------------------

/** The layout strategy classification produced from the computed `display`. */
export type LayoutStrategy = "Flexbox" | "Grid" | "Other";

/** The animation delivery method classification. */
export type DeliveryMethod = "WAAPI" | "CSS transitions";

/**
 * The performance classification of a single animated property:
 *  - `composite-friendly`: handled on the compositor (`transform`, `opacity`).
 *  - `layout-triggering`: forces layout/reflow (`top`, `width`, `margin`).
 *  - `other`: neither of the above known buckets.
 */
export type PropertyPerformance =
  | "composite-friendly"
  | "layout-triggering"
  | "other";

// ---------------------------------------------------------------------------
// Layout classification (Req 5.1)
// ---------------------------------------------------------------------------

/**
 * Classify the layout strategy from a ComputedStyleSnapshot's `display` value
 * (Req 5.1 / Property 12).
 *
 *  - `flex` / `inline-flex`  -> `"Flexbox"`
 *  - `grid` / `inline-grid`  -> `"Grid"`
 *  - anything else           -> `"Other"`
 *
 * The `display` value is compared case-insensitively and trimmed so values
 * carrying incidental whitespace still classify correctly. This function never
 * throws — a missing/non-string `display` resolves to `"Other"`.
 */
export function classifyLayout(
  computed: ComputedStyleSnapshot | null | undefined,
): LayoutStrategy {
  const display =
    computed && typeof computed.display === "string"
      ? computed.display.trim().toLowerCase()
      : "";

  switch (display) {
    case "flex":
    case "inline-flex":
      return "Flexbox";
    case "grid":
    case "inline-grid":
      return "Grid";
    default:
      return "Other";
  }
}

// ---------------------------------------------------------------------------
// Delivery classification (Req 5.2)
// ---------------------------------------------------------------------------

/**
 * Classify the animation delivery method (Req 5.2 / Property 13).
 *
 * When any programmatic (Web Animations API) animation is present, the
 * delivery is classified as `"WAAPI"`; otherwise it is `"CSS transitions"`.
 * An empty/missing animation list classifies as `"CSS transitions"`.
 */
export function classifyDelivery(
  animations: readonly AnimationDescriptor[] | null | undefined,
): DeliveryMethod {
  const list = animations ?? [];
  const hasProgrammatic = list.some(
    (animation) => animation?.delivery === "WAAPI",
  );
  return hasProgrammatic ? "WAAPI" : "CSS transitions";
}

// ---------------------------------------------------------------------------
// Property performance classification (Req 5.3, 5.4)
// ---------------------------------------------------------------------------

/** Properties handled on the compositor and therefore cheap to animate. */
const COMPOSITE_FRIENDLY_PROPERTIES = new Set<string>(["transform", "opacity"]);

/** Properties that force layout/reflow when animated. */
const LAYOUT_TRIGGERING_PROPERTIES = new Set<string>(["top", "width", "margin"]);

/**
 * Classify a single animated property's performance characteristic
 * (Req 5.3, 5.4 / Property 14).
 *
 *  - `transform` / `opacity`     -> `"composite-friendly"`
 *  - `top` / `width` / `margin`  -> `"layout-triggering"`
 *  - anything else               -> `"other"`
 *
 * The property name is compared case-insensitively and trimmed.
 */
export function classifyProperty(prop: string | null | undefined): PropertyPerformance {
  const name = typeof prop === "string" ? prop.trim().toLowerCase() : "";

  if (COMPOSITE_FRIENDLY_PROPERTIES.has(name)) {
    return "composite-friendly";
  }
  if (LAYOUT_TRIGGERING_PROPERTIES.has(name)) {
    return "layout-triggering";
  }
  return "other";
}

// ---------------------------------------------------------------------------
// Architectural_Report generation (Req 5.5)
// ---------------------------------------------------------------------------

/** Inputs required to generate the Architectural_Report. */
export interface ReportInput {
  /** Computed-style snapshot of the Target_Element (drives layout strategy). */
  computed: ComputedStyleSnapshot | null | undefined;
  /** Active animations on the Target_Element (drives delivery method). */
  animations?: readonly AnimationDescriptor[] | null;
  /**
   * The animated property names to audit. When omitted, the property names are
   * collected from the supplied `animations` descriptors.
   */
  animatedProperties?: readonly string[] | null;
}

/** Collect the distinct animated property names from a list of descriptors. */
function collectAnimatedProperties(
  animations: readonly AnimationDescriptor[],
): string[] {
  const properties = new Set<string>();
  for (const animation of animations) {
    for (const property of animation?.properties ?? []) {
      if (typeof property === "string" && property.trim() !== "") {
        properties.add(property);
      }
    }
  }
  return [...properties];
}

/** Human-readable label for each performance classification. */
const PERFORMANCE_LABEL: Record<PropertyPerformance, string> = {
  "composite-friendly": "composite-friendly",
  "layout-triggering": "layout-triggering",
  other: "other",
};

/**
 * Generate the markdown Architectural_Report (Req 5.5 / Property 15).
 *
 * The returned markdown string always contains:
 *  - the classified layout strategy (from `classifyLayout`),
 *  - the classified animation delivery method (from `classifyDelivery`), and
 *  - the performance classification of each animated property
 *    (from `classifyProperty`).
 *
 * When no animated properties are supplied or derivable, the performance
 * section states that no animated properties were detected.
 */
export function generateReport(input: ReportInput): string {
  const animations = input.animations ?? [];

  const layout = classifyLayout(input.computed);
  const delivery = classifyDelivery(animations);

  const animatedProperties =
    input.animatedProperties && input.animatedProperties.length > 0
      ? [...input.animatedProperties]
      : collectAnimatedProperties(animations);

  const lines: string[] = [];

  lines.push("# Architectural Report");
  lines.push("");

  // Layout strategy (Req 5.1).
  lines.push("## Layout Strategy");
  lines.push("");
  lines.push(`This component uses a **${layout}** layout strategy.`);
  lines.push("");

  // Animation delivery method (Req 5.2).
  lines.push("## Animation Delivery");
  lines.push("");
  lines.push(
    `Animations are delivered via **${delivery}**.`,
  );
  lines.push("");

  // Per-property performance classification (Req 5.3, 5.4).
  lines.push("## Performance Audit");
  lines.push("");

  if (animatedProperties.length === 0) {
    lines.push("No animated properties were detected.");
  } else {
    lines.push("| Property | Performance Classification |");
    lines.push("| --- | --- |");
    for (const property of animatedProperties) {
      const performance = classifyProperty(property);
      lines.push(`| \`${property}\` | ${PERFORMANCE_LABEL[performance]} |`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

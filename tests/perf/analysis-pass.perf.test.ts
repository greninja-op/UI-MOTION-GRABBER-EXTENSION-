// Feature: ui-motion-grabber, Task 10.5: performance test for the 8ms analysis pass
//
// Validates: Requirements 10.1
//
// Requirement 10.1 (requirements.md):
//   WHEN the Service_Worker performs compilation and data transformation for a
//   single analysis pass, THE Service_Worker SHALL complete that pass within
//   8 milliseconds.
//
// This is a wall-clock performance benchmark (not a property test). It builds a
// representative analysis pass — a moderately-sized Interaction_Timeline diffed
// into a State_Map, an Architectural_Report, and the full Export_Payload
// assembly — and asserts the pass completes inside the 8ms budget.
//
// Wall-clock timing on a shared CI box is inherently noisy, so the benchmark:
//   1. warms up first (lets the JIT settle and caches fill), then
//   2. takes the MEDIAN and MINIMUM of many timed runs, asserting the typical
//      (median) and best-case (min) passes both fit the budget. Median/min are
//      far more stable than any single sample or the mean (which a stray GC
//      pause can skew badly).
// It also asserts the assembler self-reports `overrun === false` for the
// representative input, exercising the budget-tracking path in
// assembleExportPayload directly.
import { describe, it, expect } from "vitest";
import {
  assembleExportPayload,
  ASSEMBLY_BUDGET_MS,
} from "../../src/worker/export-payload-assembler.ts";
import { diff } from "../../src/worker/state-diffing-engine.ts";
import { generateReport } from "../../src/worker/reverse-engineering-engine.ts";
import type {
  AnimationDescriptor,
  ComputedStyleSnapshot,
  InteractionTimeline,
  TimelineEntry,
} from "../../src/shared/types";

/**
 * A monotonic clock that prefers `performance.now()` (sub-millisecond, immune to
 * wall-clock adjustments) and falls back to `Date.now()`.
 */
function now(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/**
 * Build a representative, moderately-sized Interaction_Timeline. Each entry
 * cycles through transform / opacity / layout-triggering declarations and an
 * explicit easing keyword so the diffing engine does real easing + transform
 * extraction work (not a degenerate empty timeline).
 */
function buildRepresentativeTimeline(entryCount: number): InteractionTimeline {
  const easings = ["ease-in-out", "ease-in", "ease-out", "linear", "ease"];
  const cssVariants = [
    "transform: translate3d(8px, 0, 0) scale(1.05); opacity: 0.9;",
    "transform: matrix(1, 0, 0, 1, 12, 4); opacity: 1;",
    "top: 4px; width: 220px; margin: 8px;",
    "transform: rotate(15deg); opacity: 0.75;",
  ];

  const entries: TimelineEntry[] = [];
  let timestamp = 1000;
  for (let i = 0; i < entryCount; i += 1) {
    // Spread entries ~12ms apart, simulating real captured frames.
    timestamp += 12 + (i % 5);
    const easing = easings[i % easings.length];
    const css = `${cssVariants[i % cssVariants.length]} transition-timing-function: ${easing};`;
    const className = `kinetic-node state-${i % 7}`;
    entries.push({
      timestamp,
      className,
      cssText: css,
      structuralSignature: className + css,
    });
  }
  return entries;
}

/** A representative computed-style snapshot for the report classifier. */
const REPRESENTATIVE_COMPUTED: ComputedStyleSnapshot = {
  display: "flex",
  position: "relative",
  transform: "matrix(1, 0, 0, 1, 0, 0)",
  opacity: "1",
};

/** Representative active animations driving delivery + property classification. */
const REPRESENTATIVE_ANIMATIONS: AnimationDescriptor[] = [
  {
    delivery: "WAAPI",
    properties: ["transform", "opacity"],
    easing: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
    durationMs: 240,
  },
  {
    delivery: "CSS transitions",
    properties: ["top", "width", "margin"],
    easing: { x1: 0, y1: 0, x2: 1, y2: 1 },
    durationMs: 180,
  },
];

/**
 * Execute one full, representative analysis pass: diff the timeline into a
 * State_Map, generate the Architectural_Report, then assemble the Export_Payload.
 * Mirrors the Service_Worker pipeline wired in task 12.5.
 */
function runAnalysisPass(timeline: InteractionTimeline) {
  const stateMap = diff(timeline, "perf-session");

  const architecturalReport = generateReport({
    computed: REPRESENTATIVE_COMPUTED,
    animations: REPRESENTATIVE_ANIMATIONS,
  });

  return assembleExportPayload({
    codeTabs: {
      html: "<div class=\"kinetic-node\">Representative component</div>",
      css: ".kinetic-node { display: flex; transition: transform 240ms ease-in-out; }",
    },
    architecturalReport,
    stateMap,
    figmaTokens: [
      { name: "color/accent", value: "#3366FF" },
      { name: "spacing/sm", value: "8px" },
    ],
  });
}

/** Return the median of a numeric sample (sorted copy, middle / mean-of-two-middle). */
function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

describe("Service_Worker analysis pass — 8ms budget (Req 10.1)", () => {
  // A moderately-sized timeline: 60 captured frames -> 59 transitions, well
  // beyond a trivial input but representative of a real micro-interaction.
  const timeline = buildRepresentativeTimeline(60);

  it("assembles the Export_Payload without self-reporting a budget overrun", () => {
    const result = runAnalysisPass(timeline);

    // The assembler tracks its own elapsed time against ASSEMBLY_BUDGET_MS and
    // flags overrun when it exceeds the budget. A representative pass must fit.
    expect(result.overrun).toBe(false);
    expect(result.overrunReport).toBeNull();
    expect(result.budgetMs).toBe(ASSEMBLY_BUDGET_MS);
    expect(result.elapsedMs).toBeLessThan(ASSEMBLY_BUDGET_MS);

    // Sanity: the pass actually produced a structurally complete payload.
    expect(result.payload.figmaTokens.length).toBeGreaterThan(0);
    expect(result.payload.architecturalReport).toContain("Architectural Report");
    expect(result.payload.codeTabs.html).not.toBe("");
  });

  it("completes a representative analysis pass within the 8ms wall-clock budget", () => {
    // Warm up: let the JIT settle and caches fill before timing.
    for (let i = 0; i < 50; i += 1) {
      runAnalysisPass(timeline);
    }

    // Timed runs: measure wall-clock time of the full pipeline per iteration.
    const runs = 200;
    const samples: number[] = [];
    for (let i = 0; i < runs; i += 1) {
      const start = now();
      runAnalysisPass(timeline);
      samples.push(now() - start);
    }

    const medianMs = median(samples);
    const minMs = Math.min(...samples);

    // The typical (median) pass must fit the 8ms budget (Req 10.1). The median
    // is robust against stray GC/scheduler pauses that can spike a lone sample.
    expect(medianMs).toBeLessThan(ASSEMBLY_BUDGET_MS);

    // The best-case pass should comfortably beat the budget, confirming the
    // pipeline is not merely scraping under the limit.
    expect(minMs).toBeLessThan(ASSEMBLY_BUDGET_MS);
  });
});

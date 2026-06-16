/**
 * Analysis Pipeline (Service_Worker orchestration).
 *
 * Composes the existing Service_Worker analysis engines into the single pass
 * the Service_Worker runs when it receives an Interaction_Timeline from the
 * Content_Script (design.md "End-to-End Data Flow"):
 *
 *   State_Diffing_Engine  ->  Animation_Parser  ->  Reverse_Engineering_Engine
 *   ->  Export_Payload Assembler
 *
 * This module is deliberately thin: it does NOT re-implement any engine. It
 * only wires their existing exported functions together and shapes their
 * inputs/outputs, so the messaging layer (see `service-worker.ts`) can stay
 * free of analysis detail and the orchestration itself stays unit-testable.
 *
 * Requirements:
 *   - 3.4 / 7.5: state diffing happens inside the Service_Worker and produces a
 *                State_Map (via `diff`).
 *   - 4.3:       easing values are normalized through the Animation_Parser's
 *                fixed conversion map (via `normalizeEasing`).
 *   - 5.5:       an Architectural_Report is generated (via `generateReport`).
 *   - 6.1:       a structurally-complete Export_Payload is assembled (via
 *                `assembleExportPayload`).
 *
 * NOTE ON DOM-DEPENDENT EXTRACTION:
 * `Animation_Parser.parseComputed` / `parseAnimations` require a live DOM
 * `Element` and therefore run on the capture (Content_Script) side; their
 * results (a ComputedStyleSnapshot and AnimationDescriptors) arrive in the
 * message payload. The Service_Worker has no DOM, so this pipeline consumes
 * those results when present and uses the Animation_Parser's pure
 * `normalizeEasing` to guarantee every easing carried into the report and
 * tokens is an explicit, normalized cubic-bezier (Req 4.3). When the optional
 * computed/animation context is absent, the pipeline still produces a complete,
 * valid State_Map and Export_Payload from the timeline alone.
 */

import type {
  AnimationDescriptor,
  CodeTabs,
  ComputedStyleSnapshot,
  CubicBezier,
  ExportPayload,
  FigmaToken,
  InteractionTimeline,
  StateMap,
} from "../shared/index.ts";

import { diff } from "./state-diffing-engine.ts";
import { normalizeEasing } from "./animation-parser.ts";
import { generateReport } from "./reverse-engineering-engine.ts";
import { assembleExportPayload } from "./export-payload-assembler.ts";

// ---------------------------------------------------------------------------
// Pipeline input / output
// ---------------------------------------------------------------------------

/**
 * A loosely-typed animation descriptor as it may arrive over the JSON
 * Message_Channel. `easing` may still be a raw keyword string (e.g.
 * `"ease-in-out"`), which this pipeline normalizes via the Animation_Parser.
 */
export interface RawAnimationDescriptor {
  delivery?: "WAAPI" | "CSS transitions";
  properties?: readonly string[];
  easing?: string | CubicBezier;
  durationMs?: number;
}

/** Inputs to a single Service_Worker analysis pass. */
export interface AnalysisPipelineInput {
  /** The frozen Interaction_Timeline forwarded by the Content_Script. */
  timeline: InteractionTimeline;
  /** The owning Recording_Session id, stamped onto the resulting State_Map. */
  sessionId?: string;
  /**
   * Computed-style snapshot of the Target_Element produced on the capture side
   * by `Animation_Parser.parseComputed` (Req 4.1). Drives layout strategy
   * classification. Optional — absent in timeline-only payloads.
   */
  computed?: ComputedStyleSnapshot | null;
  /**
   * Active-animation descriptors produced on the capture side by
   * `Animation_Parser.parseAnimations` (Req 4.2). Drives delivery-method
   * classification. Easings are re-normalized here (Req 4.3).
   */
  animations?: readonly RawAnimationDescriptor[] | null;
  /** Pre-rendered HTML/CSS code tabs to embed in the Export_Payload (Req 6.1). */
  codeTabs?: CodeTabs | null;
  /** Caller-supplied Figma tokens placed ahead of derived timing tokens. */
  figmaTokens?: readonly FigmaToken[] | null;
  /** Override the assembly budget in milliseconds (defaults to 8ms, Req 10.1). */
  budgetMs?: number;
  /** Injectable clock for deterministic testing (defaults to `performance.now`). */
  now?: () => number;
}

/** The result of a single analysis pass. */
export interface AnalysisPipelineResult {
  /** The diffed State_Map sent to the Popup_UI as `STATE_MAP` (Req 3.4). */
  stateMap: StateMap;
  /** The assembled Export_Payload sent as `EXPORT_PAYLOAD` (Req 6.1). */
  exportPayload: ExportPayload;
  /** `true` when the assembly pass exceeded its time budget (Req 10.1). */
  overrun: boolean;
  /** Human-readable overrun report when `overrun` is true; `null` otherwise. */
  overrunReport: string | null;
}

// ---------------------------------------------------------------------------
// Animation_Parser normalization (Req 4.3)
// ---------------------------------------------------------------------------

/**
 * Normalize raw animation descriptors from the payload into well-formed
 * AnimationDescriptors, routing every easing through the Animation_Parser's
 * fixed conversion map (Req 4.3). A descriptor whose `easing` is already a
 * CubicBezier is preserved as-is; a keyword string is converted.
 */
function normalizeAnimations(
  animations: readonly RawAnimationDescriptor[] | null | undefined,
): AnimationDescriptor[] {
  return (animations ?? []).map((animation): AnimationDescriptor => {
    const easing: CubicBezier =
      animation.easing && typeof animation.easing === "object"
        ? { ...animation.easing }
        : normalizeEasing(animation.easing);

    return {
      delivery: animation.delivery === "WAAPI" ? "WAAPI" : "CSS transitions",
      properties: Array.isArray(animation.properties)
        ? animation.properties.filter(
            (property): property is string => typeof property === "string",
          )
        : [],
      easing,
      durationMs:
        typeof animation.durationMs === "number" &&
        Number.isFinite(animation.durationMs)
          ? animation.durationMs
          : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full Service_Worker analysis pass over an Interaction_Timeline.
 *
 * Sequence (design.md "End-to-End Data Flow"):
 *  1. **State_Diffing_Engine** — `diff(timeline)` -> State_Map (Req 3.4, 7.5).
 *  2. **Animation_Parser** — normalize the easing of every animation descriptor
 *     through the fixed conversion map (Req 4.3).
 *  3. **Reverse_Engineering_Engine** — `generateReport(...)` -> markdown
 *     Architectural_Report (Req 5.5).
 *  4. **Export_Payload Assembler** — `assembleExportPayload(...)` -> a
 *     structurally-complete Export_Payload within the 8ms budget (Req 6.1, 10.1).
 *
 * Pure and side-effect free: it never touches the Message_Channel. The caller
 * (the Service_Worker messaging router) is responsible for transport.
 */
export function runAnalysisPipeline(
  input: AnalysisPipelineInput,
): AnalysisPipelineResult {
  const timeline = Array.isArray(input.timeline) ? input.timeline : [];
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";

  // 1. State_Diffing_Engine -> State_Map (Req 3.1-3.4, 7.5).
  const stateMap = diff(timeline, sessionId);

  // 2. Animation_Parser -> normalized animation descriptors (Req 4.3).
  const animations = normalizeAnimations(input.animations);

  // 3. Reverse_Engineering_Engine -> Architectural_Report (Req 5.1, 5.2, 5.5).
  const architecturalReport = generateReport({
    computed: input.computed ?? null,
    animations,
  });

  // 4. Export_Payload Assembler -> Export_Payload (Req 6.1, 6.2, 10.1).
  const assembly = assembleExportPayload({
    codeTabs: input.codeTabs ?? null,
    architecturalReport,
    stateMap,
    figmaTokens: input.figmaTokens ?? null,
    budgetMs: input.budgetMs,
    now: input.now,
  });

  return {
    stateMap,
    exportPayload: assembly.payload,
    overrun: assembly.overrun,
    overrunReport: assembly.overrunReport,
  };
}

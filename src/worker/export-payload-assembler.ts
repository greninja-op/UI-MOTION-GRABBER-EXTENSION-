/**
 * Export_Payload Assembler (Service_Worker component).
 *
 * Combines the outputs of the analysis pipeline — HTML/CSS code tabs, the
 * Figma design-token array, and the markdown Architectural_Report — into a
 * single JSON-serializable Export_Payload (design.md "Service_Worker
 * Components -> Export_Payload Assembler").
 *
 * Requirements:
 *   - 6.1: assemble code tabs (HTML/CSS), Figma design token variables, and the
 *          Architectural_Report string into the Export_Payload.
 *   - 6.2: emit Figma timing token values in `cubic-bezier(x1,y1,x2,y2)` form.
 *   - 10.1: complete the assembly pass within an 8ms budget; on overrun return a
 *          well-formed (possibly partial) payload and report the overrun rather
 *          than blocking.
 *
 * The Export_Payload contains only JSON-serializable primitives, arrays, and
 * plain objects (no functions, class instances, `undefined`, or circular
 * references), preserving the round-trip property in Requirement 6.4.
 */

import type {
  CodeTabs,
  CubicBezier,
  ExportPayload,
  FigmaToken,
  StateMap,
} from "../shared/index.ts";

// ---------------------------------------------------------------------------
// Budget configuration
// ---------------------------------------------------------------------------

/** The Service_Worker single-pass budget in milliseconds (Req 10.1). */
export const ASSEMBLY_BUDGET_MS = 8;

/**
 * A monotonic clock. Defaults to `performance.now()` when available, falling
 * back to `Date.now()` so the assembler runs in any environment.
 */
function defaultNow(): number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }
  return Date.now();
}

// ---------------------------------------------------------------------------
// cubic-bezier formatting / parsing (Req 6.2, Property 17)
// ---------------------------------------------------------------------------

/**
 * Format a CubicBezier as a `cubic-bezier(x1,y1,x2,y2)` string (Req 6.2).
 *
 * The output uses no internal whitespace (e.g. `cubic-bezier(0.42,0,0.58,1)`)
 * so it is a compact, copy-ready CSS timing value that round-trips through
 * {@link parseCubicBezierToken}.
 */
export function formatCubicBezier(bezier: CubicBezier): string {
  return `cubic-bezier(${bezier.x1},${bezier.y1},${bezier.x2},${bezier.y2})`;
}

/**
 * Parse a `cubic-bezier(x1,y1,x2,y2)` token string back into a CubicBezier.
 *
 * Returns `null` when the string is not a well-formed cubic-bezier value with
 * four finite numeric coordinates. Inverse of {@link formatCubicBezier}.
 */
export function parseCubicBezierToken(value: string): CubicBezier | null {
  if (typeof value !== "string") return null;
  const match = /cubic-bezier\(\s*([^)]+)\)/i.exec(value);
  if (!match) return null;
  const nums = match[1]
    .split(",")
    .map((n) => Number(n.trim()));
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
    return null;
  }
  return { x1: nums[0], y1: nums[1], x2: nums[2], y2: nums[3] };
}

// ---------------------------------------------------------------------------
// Assembler input / result
// ---------------------------------------------------------------------------

/** Inputs to the Export_Payload assembly pass. */
export interface AssemblerInput {
  /** The HTML/CSS code tabs to surface in the Popup_UI (Req 6.1). */
  codeTabs?: CodeTabs | null;
  /** The markdown Architectural_Report string (Req 6.1). */
  architecturalReport?: string | null;
  /**
   * The diffed State_Map. Its per-transition easing curves are emitted as Figma
   * timing tokens in `cubic-bezier(...)` form (Req 6.2).
   */
  stateMap?: StateMap | null;
  /**
   * Additional, caller-supplied Figma tokens (e.g. colors, spacing). These are
   * placed ahead of the derived timing tokens in the final array.
   */
  figmaTokens?: readonly FigmaToken[] | null;
  /** Override the assembly budget in milliseconds (defaults to 8ms, Req 10.1). */
  budgetMs?: number;
  /** Injectable clock for deterministic testing (defaults to `performance.now`). */
  now?: () => number;
}

/** The result of an assembly pass, including the budget-overrun report. */
export interface AssemblyResult {
  /** The assembled (possibly partial on overrun) Export_Payload. */
  payload: ExportPayload;
  /** `true` when the pass exceeded its budget and returned partial output. */
  overrun: boolean;
  /**
   * A human-readable overrun report when `overrun` is true (names the stage at
   * which the budget was exceeded and the elapsed time); `null` otherwise.
   */
  overrunReport: string | null;
  /** Wall-clock time the pass took, in milliseconds. */
  elapsedMs: number;
  /** The budget that applied to this pass, in milliseconds. */
  budgetMs: number;
}

// ---------------------------------------------------------------------------
// Figma token derivation
// ---------------------------------------------------------------------------

/** A sanitized, JSON-safe copy of a caller-supplied Figma token. */
function sanitizeToken(token: FigmaToken): FigmaToken {
  return {
    name: typeof token?.name === "string" ? token.name : "",
    value: typeof token?.value === "string" ? token.value : "",
  };
}

/**
 * Derive Figma timing tokens from a State_Map. Each transition contributes a
 * cubic-bezier timing token (Req 6.2) and a duration token. The
 * `withinBudget` callback is consulted between transitions so a long State_Map
 * can stop early on overrun, yielding a partial-but-well-formed token list.
 */
function deriveTimingTokens(
  stateMap: StateMap | null | undefined,
  withinBudget: () => boolean,
): { tokens: FigmaToken[]; overran: boolean } {
  const tokens: FigmaToken[] = [];
  const transitions = stateMap?.transitions ?? [];

  for (let i = 0; i < transitions.length; i += 1) {
    if (!withinBudget()) {
      return { tokens, overran: true };
    }

    const transition = transitions[i];

    // Timing token in cubic-bezier(x1,y1,x2,y2) string form (Req 6.2).
    tokens.push({
      name: `transition/${i}/timing`,
      value: formatCubicBezier(transition.easing),
    });

    // Companion duration token (plain CSS time value).
    tokens.push({
      name: `transition/${i}/duration`,
      value: `${transition.durationOffsetMs}ms`,
    });
  }

  return { tokens, overran: false };
}

// ---------------------------------------------------------------------------
// Assembly pass
// ---------------------------------------------------------------------------

/**
 * Assemble analysis results into an Export_Payload within the 8ms budget.
 *
 * The payload is built incrementally on top of a fully-defaulted, well-formed
 * skeleton, so any early return on budget overrun still yields a structurally
 * complete payload (HTML/CSS strings, a Figma token array, and a report string
 * — Property 16 / Req 6.1). The budget is tracked with the injected clock
 * (default `performance.now()`); on overrun the pass stops and reports it
 * rather than blocking the Service_Worker (Req 10.1).
 */
export function assembleExportPayload(input: AssemblerInput): AssemblyResult {
  const now = input.now ?? defaultNow;
  const budgetMs =
    typeof input.budgetMs === "number" && Number.isFinite(input.budgetMs)
      ? input.budgetMs
      : ASSEMBLY_BUDGET_MS;
  const start = now();

  // A well-formed skeleton with safe defaults guarantees structural
  // completeness even if we bail out early (Property 16).
  const payload: ExportPayload = {
    codeTabs: { html: "", css: "" },
    figmaTokens: [],
    architecturalReport: "",
  };

  const elapsed = (): number => now() - start;
  const overBudget = (): boolean => elapsed() > budgetMs;

  const finalize = (stage: string): AssemblyResult => ({
    payload,
    overrun: true,
    overrunReport:
      `Export_Payload assembly exceeded the ${budgetMs}ms budget at the ` +
      `"${stage}" stage (elapsed ${elapsed().toFixed(3)}ms); returning a ` +
      `partial payload.`,
    elapsedMs: elapsed(),
    budgetMs,
  });

  // Stage 1: code tabs (Req 6.1).
  payload.codeTabs = {
    html: typeof input.codeTabs?.html === "string" ? input.codeTabs.html : "",
    css: typeof input.codeTabs?.css === "string" ? input.codeTabs.css : "",
  };
  if (overBudget()) return finalize("code tabs");

  // Stage 2: Figma tokens — caller-supplied first, then derived timing tokens
  // in cubic-bezier form (Req 6.1, 6.2).
  const supplied = (input.figmaTokens ?? []).map(sanitizeToken);
  payload.figmaTokens = supplied;
  if (overBudget()) return finalize("figma tokens");

  const derived = deriveTimingTokens(input.stateMap, () => !overBudget());
  payload.figmaTokens = supplied.concat(derived.tokens);
  if (derived.overran || overBudget()) return finalize("figma tokens");

  // Stage 3: Architectural_Report markdown (Req 6.1).
  payload.architecturalReport =
    typeof input.architecturalReport === "string"
      ? input.architecturalReport
      : "";
  if (overBudget()) return finalize("architectural report");

  return {
    payload,
    overrun: false,
    overrunReport: null,
    elapsedMs: elapsed(),
    budgetMs,
  };
}

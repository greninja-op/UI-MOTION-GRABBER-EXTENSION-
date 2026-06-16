// Feature: ui-motion-grabber, Property 16: Export_Payload structural completeness
//
// Validates: Requirements 6.1
//
// Property 16 (design.md "Correctness Properties"):
//   For any completed analysis, the assembled Export_Payload SHALL contain HTML
//   and CSS code tabs (strings), a Figma design token array, and an
//   Architectural_Report string.
//
// The assembler is fed arbitrary AssemblerInput — including missing, null, and
// partial fields, plus deliberate budget-overrun scenarios (a tiny/zero/negative
// budget combined with a fast-advancing injected clock). Regardless of input,
// the resulting payload MUST be structurally complete:
//   - payload.codeTabs.html  is a string
//   - payload.codeTabs.css   is a string
//   - payload.figmaTokens    is an array (of {name:string, value:string})
//   - payload.architecturalReport is a string
// This holds even on overrun, where the assembler returns a partial-but-well-
// formed payload built on a fully-defaulted skeleton.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  assembleExportPayload,
  type AssemblerInput,
} from "../../src/worker/export-payload-assembler.ts";
import type {
  CodeTabs,
  CubicBezier,
  FigmaToken,
  StateMap,
  Transition,
} from "../../src/shared/types";

// --- Generators ------------------------------------------------------------

const finite = (opts: fc.DoubleConstraints = {}) =>
  fc.double({ noNaN: true, noDefaultInfinity: true, ...opts });

const cubicBezierArb: fc.Arbitrary<CubicBezier> = fc.record({
  x1: finite({ min: -10, max: 10 }),
  y1: finite({ min: -10, max: 10 }),
  x2: finite({ min: -10, max: 10 }),
  y2: finite({ min: -10, max: 10 }),
});

const transitionArb: fc.Arbitrary<Transition> = fc.record({
  fromIndex: fc.nat(50),
  toIndex: fc.nat(50),
  delayOffsetMs: finite({ min: -1e4, max: 1e4 }),
  durationOffsetMs: finite({ min: -1e4, max: 1e4 }),
  easing: cubicBezierArb,
  transformMatrix: fc.option(
    fc.array(finite({ min: -1e3, max: 1e3 }), { maxLength: 16 }),
    { nil: null },
  ),
});

const stateMapArb: fc.Arbitrary<StateMap> = fc.record({
  sessionId: fc.string(),
  transitions: fc.array(transitionArb, { maxLength: 30 }),
});

const codeTabsArb: fc.Arbitrary<CodeTabs> = fc.record({
  html: fc.string(),
  css: fc.string(),
});

const figmaTokenArb: fc.Arbitrary<FigmaToken> = fc.record({
  name: fc.string(),
  value: fc.string(),
});

/**
 * An injected, fast-advancing monotonic clock. Each call advances by `step`
 * milliseconds; pairing a positive step with a small/zero/negative budget makes
 * the assembler exceed its budget and return a partial payload — letting us
 * verify structural completeness on the overrun path too.
 */
function steppingClockArb(): fc.Arbitrary<() => number> {
  return fc.double({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }).map(
    (step) => {
      let t = 0;
      return () => {
        const current = t;
        t += step;
        return current;
      };
    },
  );
}

/**
 * Arbitrary AssemblerInput where every field may be present, missing, null, or
 * partial. `requiredKeys: []` lets fast-check omit keys entirely, covering the
 * "missing field" cases. A randomized budget (including 0 and negatives) plus an
 * optional fast clock exercises the budget-overrun branches.
 */
const assemblerInputArb: fc.Arbitrary<AssemblerInput> = fc.record(
  {
    codeTabs: fc.oneof(codeTabsArb, fc.constant(null)),
    architecturalReport: fc.oneof(fc.string(), fc.constant(null)),
    stateMap: fc.oneof(stateMapArb, fc.constant(null)),
    figmaTokens: fc.oneof(
      fc.array(figmaTokenArb, { maxLength: 20 }),
      fc.constant(null),
    ),
    budgetMs: fc.oneof(
      finite({ min: -5, max: 20 }),
      fc.constant(0),
    ),
    now: steppingClockArb(),
  },
  { requiredKeys: [] },
);

// --- Helpers ---------------------------------------------------------------

function assertStructurallyComplete(payload: unknown): void {
  expect(payload).toBeTypeOf("object");
  expect(payload).not.toBeNull();

  const p = payload as Record<string, unknown>;

  // HTML and CSS code tabs are strings (Req 6.1).
  expect(p.codeTabs).toBeTypeOf("object");
  expect(p.codeTabs).not.toBeNull();
  const tabs = p.codeTabs as Record<string, unknown>;
  expect(tabs.html).toBeTypeOf("string");
  expect(tabs.css).toBeTypeOf("string");

  // Figma design token array (Req 6.1) — each token is {name,value} strings.
  expect(Array.isArray(p.figmaTokens)).toBe(true);
  for (const token of p.figmaTokens as unknown[]) {
    expect(token).toBeTypeOf("object");
    expect(token).not.toBeNull();
    const t = token as Record<string, unknown>;
    expect(t.name).toBeTypeOf("string");
    expect(t.value).toBeTypeOf("string");
  }

  // Architectural_Report string (Req 6.1).
  expect(p.architecturalReport).toBeTypeOf("string");
}

// --- Property --------------------------------------------------------------

describe("Export_Payload Assembler — Property 16: structural completeness (Req 6.1)", () => {
  it("produces a structurally complete payload for any input, including missing/partial fields", () => {
    fc.assert(
      fc.property(assemblerInputArb, (input) => {
        const result = assembleExportPayload(input);
        assertStructurallyComplete(result.payload);
      }),
      { numRuns: 200 },
    );
  });

  it("stays structurally complete even on budget overrun (partial payload path)", () => {
    // Force overrun: a fast clock (step >= 1ms) with a zero/negative budget, so
    // the assembler bails early yet must still return the well-formed skeleton.
    const overrunInputArb: fc.Arbitrary<AssemblerInput> = fc.record(
      {
        codeTabs: fc.oneof(codeTabsArb, fc.constant(null)),
        architecturalReport: fc.oneof(fc.string(), fc.constant(null)),
        stateMap: stateMapArb,
        figmaTokens: fc.array(figmaTokenArb, { maxLength: 20 }),
        budgetMs: fc.constant(0),
        now: fc
          .double({ min: 1, max: 1000, noNaN: true, noDefaultInfinity: true })
          .map((step) => {
            let t = 0;
            return () => {
              const current = t;
              t += step;
              return current;
            };
          }),
      },
      { requiredKeys: ["budgetMs", "now"] },
    );

    fc.assert(
      fc.property(overrunInputArb, (input) => {
        const result = assembleExportPayload(input);
        expect(result.overrun).toBe(true);
        expect(result.overrunReport).toBeTypeOf("string");
        assertStructurallyComplete(result.payload);
      }),
      { numRuns: 200 },
    );
  });
});

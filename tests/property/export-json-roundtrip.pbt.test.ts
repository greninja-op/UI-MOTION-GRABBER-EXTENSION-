// Feature: ui-motion-grabber, Property 18: Export_Payload JSON round-trip equivalence
//
// Validates: Requirements 6.4
//
// Property 18 (design.md "Correctness Properties"):
//   For any valid Export_Payload, serializing it to JSON and parsing it back
//   SHALL produce an Export_Payload deeply equivalent to the original.
//
// Strategy:
//   The Export_Payload serialization contract (src/shared/types.ts) restricts
//   every payload to JSON-serializable values only: primitive strings, arrays,
//   and plain objects. We exercise the round-trip from two directions so the
//   property holds across the whole input space:
//     1. Directly-generated arbitrary ExportPayloads — arbitrary code-tab
//        html/css strings, an arbitrary figmaTokens array of {name,value}
//        string pairs, and an arbitrary architecturalReport string.
//     2. Payloads produced by the real `assembleExportPayload` from arbitrary
//        assembler inputs (code tabs, caller Figma tokens, a State_Map whose
//        transitions derive cubic-bezier timing tokens, and a report string),
//        guaranteeing the assembler's own output round-trips.
//   In both cases we assert JSON.parse(JSON.stringify(payload)) deep-equals the
//   original payload. We deliberately include tricky string content (unicode,
//   quotes, backslashes, newlines, JSON-significant characters) that JSON must
//   escape and restore faithfully.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  assembleExportPayload,
  type AssemblerInput,
} from "../../src/worker/export-payload-assembler.ts";
import type {
  CubicBezier,
  ExportPayload,
  FigmaToken,
  StateMap,
  Transition,
} from "../../src/shared/index.ts";

// Strings that stress JSON's escaping rules: arbitrary text plus characters
// that must survive a serialize -> parse cycle (quotes, backslashes, control
// chars, unicode, and JSON-significant punctuation).
const trickyStringArb = fc.oneof(
  fc.string(),
  fc.fullUnicodeString(),
  fc.constantFrom(
    "",
    '"quoted"',
    "back\\slash",
    "line\nbreak\ttab",
    "{\"json\":[1,2,3]}",
    "emoji 🚀 and ünïcode",
    "</script>",
  ),
);

const figmaTokenArb: fc.Arbitrary<FigmaToken> = fc.record({
  name: trickyStringArb,
  value: trickyStringArb,
});

// (1) Directly-generated arbitrary, valid ExportPayloads.
const exportPayloadArb: fc.Arbitrary<ExportPayload> = fc.record({
  codeTabs: fc.record({
    html: trickyStringArb,
    css: trickyStringArb,
  }),
  figmaTokens: fc.array(figmaTokenArb, { maxLength: 12 }),
  architecturalReport: trickyStringArb,
});

// (2) Inputs for the real assembler. A State_Map's transitions become derived
// cubic-bezier timing tokens, exercising the assembler's full output shape.
const bezierArb: fc.Arbitrary<CubicBezier> = fc.record({
  x1: fc.double({ min: -2, max: 2, noNaN: true }),
  y1: fc.double({ min: -2, max: 2, noNaN: true }),
  x2: fc.double({ min: -2, max: 2, noNaN: true }),
  y2: fc.double({ min: -2, max: 2, noNaN: true }),
});

const transitionArb: fc.Arbitrary<Transition> = fc.record({
  fromIndex: fc.nat({ max: 50 }),
  toIndex: fc.nat({ max: 50 }),
  delayOffsetMs: fc.double({ min: 0, max: 5000, noNaN: true }),
  durationOffsetMs: fc.double({ min: 0, max: 5000, noNaN: true }),
  easing: bezierArb,
  transformMatrix: fc.oneof(
    fc.constant(null),
    fc.array(fc.double({ min: -100, max: 100, noNaN: true }), {
      minLength: 6,
      maxLength: 6,
    }),
  ),
});

const stateMapArb: fc.Arbitrary<StateMap> = fc.record({
  sessionId: trickyStringArb,
  transitions: fc.array(transitionArb, { maxLength: 8 }),
});

const assemblerInputArb: fc.Arbitrary<AssemblerInput> = fc.record({
  codeTabs: fc.record({ html: trickyStringArb, css: trickyStringArb }),
  architecturalReport: trickyStringArb,
  figmaTokens: fc.array(figmaTokenArb, { maxLength: 6 }),
  stateMap: fc.oneof(fc.constant(null), stateMapArb),
  // Use a generous budget so the assembler completes a full (non-partial) pass;
  // the round-trip property must hold for partial payloads too, but a complete
  // payload exercises every field.
  budgetMs: fc.constant(Number.POSITIVE_INFINITY),
});

describe("Export_Payload Assembler — Property 18: JSON round-trip equivalence (Req 6.4)", () => {
  it("round-trips any directly-generated valid Export_Payload", () => {
    fc.assert(
      fc.property(exportPayloadArb, (payload) => {
        const roundTripped = JSON.parse(JSON.stringify(payload));
        expect(roundTripped).toEqual(payload);
      }),
      { numRuns: 300 },
    );
  });

  it("round-trips any Export_Payload produced by assembleExportPayload", () => {
    fc.assert(
      fc.property(assemblerInputArb, (input) => {
        const { payload } = assembleExportPayload(input);
        const roundTripped = JSON.parse(JSON.stringify(payload));
        expect(roundTripped).toEqual(payload);
      }),
      { numRuns: 300 },
    );
  });
});

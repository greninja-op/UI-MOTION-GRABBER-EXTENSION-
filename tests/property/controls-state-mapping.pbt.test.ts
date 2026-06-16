// Feature: ui-motion-grabber, Property 23: Session_Controls_State mirrors Recording_Status one-to-one
//
// Validates: Requirements 11.7
//
// Property 23 (design.md "Correctness Properties"):
//   For any canonical Recording_Status value, the derived Session_Controls_State
//   SHALL be defined (the mapping is total), SHALL be distinct for distinct
//   statuses (the mapping is injective/one-to-one), and SHALL never produce a
//   value outside the four canonical states (IDLE, RECORDING, PAUSED, STOPPED) —
//   so the Popup_UI view-model introduces no status absent from Recording_Status.
//
// Input spaces exercised:
//   1. The canonical RECORDING_STATUSES — asserting totality (always defined),
//      closure (output always one of the four canonical controls states), and
//      injectivity (distinct statuses produce distinct controls states).
//   2. Arbitrary strings — confirming the only outputs ever produced for the
//      canonical inputs are the four canonical controls states, i.e. the mapping
//      never escapes its codomain even under fuzzing of the input string.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  RECORDING_STATUSES,
  toControlsState,
  type RecordingStatus,
  type SessionControlsState,
} from "../../src/shared/index.ts";

// The four canonical Session_Controls_State values, restated independently from
// the implementation so the test pins the exact codomain required by design.md.
const CANONICAL_CONTROLS_STATES: readonly SessionControlsState[] = [
  "IDLE",
  "RECORDING",
  "PAUSED",
  "STOPPED",
] as const;

const canonicalStatusArb = fc.constantFrom<RecordingStatus>(...RECORDING_STATUSES);

describe("Session_Controller — Property 23: Session_Controls_State mirrors Recording_Status one-to-one (Req 11.7)", () => {
  it("is total and closed: every canonical status maps to one of the four canonical controls states", () => {
    fc.assert(
      fc.property(canonicalStatusArb, (status) => {
        let result: SessionControlsState | undefined;
        expect(() => {
          result = toControlsState(status);
        }).not.toThrow();
        // Total: a value is always produced.
        expect(result).toBeDefined();
        // Closure: the value never escapes the four canonical controls states.
        expect(CANONICAL_CONTROLS_STATES).toContain(result);
      }),
      { numRuns: 200 },
    );
  });

  it("is injective: distinct statuses map to distinct controls states", () => {
    fc.assert(
      fc.property(canonicalStatusArb, canonicalStatusArb, (a, b) => {
        const mappedA = toControlsState(a);
        const mappedB = toControlsState(b);
        // One-to-one: equal outputs imply equal inputs (and vice versa).
        expect(mappedA === mappedB).toBe(a === b);
      }),
      { numRuns: 200 },
    );
  });

  it("covers the full canonical set bijectively: the four statuses produce exactly the four distinct controls states", () => {
    const mapped = RECORDING_STATUSES.map((s) => toControlsState(s));
    // Distinctness across the whole domain (injective over the canonical set).
    expect(new Set(mapped).size).toBe(RECORDING_STATUSES.length);
    // Surjective onto the canonical codomain (no controls state left unmapped).
    expect(new Set(mapped)).toEqual(new Set(CANONICAL_CONTROLS_STATES));
  });

  it("never produces a value outside the canonical set, even for arbitrary string inputs to canonical statuses", () => {
    // Feed arbitrary strings alongside the canonical statuses. For any input the
    // implementation treats as a canonical status, the output must remain within
    // the four canonical controls states; arbitrary non-canonical strings must
    // not yield a non-canonical controls state (they yield `undefined`, never an
    // invented status value).
    fc.assert(
      fc.property(
        fc.oneof(canonicalStatusArb, fc.string()),
        (candidate) => {
          const result = toControlsState(candidate as RecordingStatus);
          if (RECORDING_STATUSES.includes(candidate as RecordingStatus)) {
            expect(CANONICAL_CONTROLS_STATES).toContain(result);
          } else {
            // Non-canonical inputs must never fabricate a canonical-looking status.
            expect(result).toBeUndefined();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

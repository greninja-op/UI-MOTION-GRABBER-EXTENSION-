import { describe, it, expect } from "vitest";
import { diff } from "./state-diffing-engine.ts";
import type { InteractionTimeline, TimelineEntry } from "../shared/index.ts";

function entry(partial: Partial<TimelineEntry> & { timestamp: number }): TimelineEntry {
  const className = partial.className ?? "";
  const cssText = partial.cssText ?? "";
  return {
    timestamp: partial.timestamp,
    className,
    cssText,
    structuralSignature: partial.structuralSignature ?? className + cssText,
  };
}

describe("diff() transition count (Req 3.4)", () => {
  it("yields zero transitions for an empty timeline", () => {
    expect(diff([]).transitions).toEqual([]);
  });

  it("yields zero transitions for a single-entry timeline", () => {
    const timeline: InteractionTimeline = [entry({ timestamp: 100 })];
    expect(diff(timeline).transitions).toEqual([]);
  });

  it("yields exactly N-1 transitions", () => {
    const timeline: InteractionTimeline = [
      entry({ timestamp: 0 }),
      entry({ timestamp: 10 }),
      entry({ timestamp: 25 }),
      entry({ timestamp: 50 }),
    ];
    expect(diff(timeline).transitions).toHaveLength(3);
  });

  it("carries the supplied sessionId", () => {
    expect(diff([], "session-42").sessionId).toBe("session-42");
  });
});

describe("diff() offsets (Req 3.1)", () => {
  it("sets delay and duration offsets to the consecutive timestamp difference", () => {
    const timeline: InteractionTimeline = [
      entry({ timestamp: 0 }),
      entry({ timestamp: 16 }),
      entry({ timestamp: 40 }),
    ];
    const { transitions } = diff(timeline);

    expect(transitions[0]).toMatchObject({
      fromIndex: 0,
      toIndex: 1,
      delayOffsetMs: 16,
      durationOffsetMs: 16,
    });
    expect(transitions[1]).toMatchObject({
      fromIndex: 1,
      toIndex: 2,
      delayOffsetMs: 24,
      durationOffsetMs: 24,
    });
  });
});

describe("diff() easing extraction (Req 3.2)", () => {
  it("defaults to linear when no easing is present", () => {
    const timeline: InteractionTimeline = [
      entry({ timestamp: 0 }),
      entry({ timestamp: 10, cssText: "color: red" }),
    ];
    expect(diff(timeline).transitions[0].easing).toEqual({
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
    });
  });

  it("normalizes an easing keyword from the resulting state", () => {
    const timeline: InteractionTimeline = [
      entry({ timestamp: 0 }),
      entry({
        timestamp: 10,
        cssText: "transition-timing-function: ease-in-out",
      }),
    ];
    expect(diff(timeline).transitions[0].easing).toEqual({
      x1: 0.42,
      y1: 0,
      x2: 0.58,
      y2: 1,
    });
  });

  it("does not match a keyword embedded in another identifier", () => {
    const timeline: InteractionTimeline = [
      entry({ timestamp: 0 }),
      // `release` contains `ease` but must not be treated as an easing keyword.
      entry({ timestamp: 10, cssText: "animation-name: release" }),
    ];
    expect(diff(timeline).transitions[0].easing).toEqual({
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
    });
  });

  it("parses an explicit cubic-bezier value", () => {
    const timeline: InteractionTimeline = [
      entry({ timestamp: 0 }),
      entry({
        timestamp: 10,
        cssText: "transition: opacity 0.3s cubic-bezier(0.1, 0.2, 0.3, 0.4)",
      }),
    ];
    expect(diff(timeline).transitions[0].easing).toEqual({
      x1: 0.1,
      y1: 0.2,
      x2: 0.3,
      y2: 0.4,
    });
  });

  it("always produces finite easing coordinates", () => {
    const timeline: InteractionTimeline = [
      entry({ timestamp: 0 }),
      entry({ timestamp: 5, cssText: "transform: scale(2)" }),
      entry({ timestamp: 9, cssText: "" }),
    ];
    for (const t of diff(timeline).transitions) {
      for (const coord of [t.easing.x1, t.easing.y1, t.easing.x2, t.easing.y2]) {
        expect(Number.isFinite(coord)).toBe(true);
      }
    }
  });
});

describe("diff() transform matrix extraction (Req 3.3)", () => {
  it("is null when the resulting state has no transform", () => {
    const timeline: InteractionTimeline = [
      entry({ timestamp: 0 }),
      entry({ timestamp: 10, cssText: "opacity: 0.5" }),
    ];
    expect(diff(timeline).transitions[0].transformMatrix).toBeNull();
  });

  it("is null when the transform is explicitly none", () => {
    const timeline: InteractionTimeline = [
      entry({ timestamp: 0 }),
      entry({ timestamp: 10, cssText: "transform: none" }),
    ];
    expect(diff(timeline).transitions[0].transformMatrix).toBeNull();
  });

  it("extracts matrix() arguments when a transform is present", () => {
    const timeline: InteractionTimeline = [
      entry({ timestamp: 0 }),
      entry({
        timestamp: 10,
        cssText: "transform: matrix(1, 0, 0, 1, 30, 40)",
      }),
    ];
    expect(diff(timeline).transitions[0].transformMatrix).toEqual([
      1, 0, 0, 1, 30, 40,
    ]);
  });

  it("extracts numeric arguments from non-matrix transform functions", () => {
    const timeline: InteractionTimeline = [
      entry({ timestamp: 0 }),
      entry({ timestamp: 10, cssText: "transform: translateX(12px)" }),
    ];
    expect(diff(timeline).transitions[0].transformMatrix).toEqual([12]);
  });

  it("returns non-null for a transform present without numeric args", () => {
    const timeline: InteractionTimeline = [
      entry({ timestamp: 0 }),
      entry({ timestamp: 10, cssText: "transform: var(--t)" }),
    ];
    expect(diff(timeline).transitions[0].transformMatrix).toEqual([]);
  });
});

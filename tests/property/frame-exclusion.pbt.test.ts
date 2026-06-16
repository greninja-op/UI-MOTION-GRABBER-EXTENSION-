// Feature: ui-motion-grabber, Property 20: Cross-origin sub-frames excluded and reported
//
// Validates: Requirements 9.2
//
// Property 20 (design.md "Correctness Properties"):
//   For any set of sub-frames mixing same-origin and cross-origin frames, the
//   System SHALL exclude every cross-origin/inaccessible frame from selection
//   and SHALL produce a FrameExclusion report for each excluded frame.
//
// Strategy:
//   We generate an arbitrary set of sub-frames, each tagged as either
//   same-origin/accessible or cross-origin/inaccessible. The top frame is
//   always present and accessible. We drive `FrameInjector.injectAllFrames`
//   with three injected collaborators:
//     - a FrameEnumerator that lists every frame (top + sub-frames),
//     - a mock ScriptingApi whose `executeScript` returns a per-frame result
//       array: accessible frames succeed, inaccessible frames carry a
//       per-frame `error` (a SecurityError-style description),
//     - a spy MessageEmitter that records every emitted FRAME_EXCLUDED report.
//   We then assert the core invariants of Property 20:
//     1. every inaccessible/cross-origin frame is excluded from
//        `injectedFrameIds`,
//     2. every such frame is emitted as a FRAME_EXCLUDED report exactly once,
//     3. every accessible frame IS injected and is NOT reported.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  FrameInjector,
  type FrameInfo,
  type InjectionResult,
  type ScriptInjection,
  type ScriptingApi,
  type MessageEmitter,
} from "../../src/worker/frame-injector.ts";
import { MessageType, type FrameExclusion } from "../../src/shared/index.ts";

// A single generated frame: an id, a url, and whether it is accessible.
interface GenFrame {
  frameId: number;
  url: string;
  accessible: boolean;
}

// Same-origin (accessible) urls share the top frame's origin so they can never
// be misclassified by the origin diff; cross-origin urls use a distinct origin
// per frame. Urls are derived from the (unique) frame id so every frame url is
// itself unique — this lets us match reports to frames by url unambiguously.
const TOP_FRAME_URL = "https://top.example.com/";

function sameOriginUrl(frameId: number): string {
  return `https://top.example.com/frame-${frameId}`;
}

function crossOriginUrl(frameId: number): string {
  // Distinct origin per frame (different host => different origin from top).
  return `https://cross-${frameId}.third-party.example/embed`;
}

// A set of sub-frames with unique, non-zero frame ids (0 is reserved for the
// top frame). Each sub-frame is independently same-origin (accessible) or
// cross-origin (inaccessible); its url is derived from its id so urls stay
// globally unique.
const subFramesArb: fc.Arbitrary<GenFrame[]> = fc
  .uniqueArray(fc.integer({ min: 1, max: 5000 }), {
    minLength: 0,
    maxLength: 8,
  })
  .chain((ids) =>
    fc.tuple(
      ...ids.map((frameId) =>
        fc.boolean().map((sameOrigin) => ({
          frameId,
          accessible: sameOrigin,
          url: sameOrigin ? sameOriginUrl(frameId) : crossOriginUrl(frameId),
        })),
      ),
    ),
  );

/**
 * Build a mock ScriptingApi for an `allFrames` injection. Accessible frames are
 * returned as successful per-frame results; inaccessible frames carry a
 * per-frame `error` describing a cross-origin SecurityError — exactly the
 * signal the platform surfaces for frames that cannot be scripted.
 */
function makeScripting(frames: GenFrame[]): {
  scripting: ScriptingApi;
  calls: ScriptInjection[];
} {
  const calls: ScriptInjection[] = [];
  const scripting: ScriptingApi = {
    executeScript(injection: ScriptInjection): Promise<InjectionResult[]> {
      calls.push(injection);
      const results: InjectionResult[] = frames.map((frame) =>
        frame.accessible
          ? { frameId: frame.frameId, result: true }
          : {
              frameId: frame.frameId,
              error:
                "SecurityError: Blocked a frame with a cross-origin origin from accessing a frame.",
            },
      );
      return Promise.resolve(results);
    },
  };
  return { scripting, calls };
}

/** A spy emitter that records every FRAME_EXCLUDED payload it receives. */
function makeEmitter(): { emit: MessageEmitter; reports: FrameExclusion[] } {
  const reports: FrameExclusion[] = [];
  const emit: MessageEmitter = (envelope) => {
    expect(envelope.type).toBe(MessageType.FRAME_EXCLUDED);
    reports.push(envelope.payload);
  };
  return { emit, reports };
}

describe("FrameInjector — Property 20: Cross-origin sub-frames excluded and reported (Req 9.2)", () => {
  it("excludes every inaccessible frame from selection and reports each exactly once", async () => {
    await fc.assert(
      fc.asyncProperty(subFramesArb, async (subFrames) => {
        // The top frame (id 0) is always present and accessible.
        const topFrame: GenFrame = {
          frameId: 0,
          url: TOP_FRAME_URL,
          accessible: true,
        };
        const allGenFrames = [topFrame, ...subFrames];

        const { scripting, calls } = makeScripting(allGenFrames);
        const { emit, reports } = makeEmitter();
        const injector = new FrameInjector(scripting, emit);

        const enumerateFrames = (): Promise<FrameInfo[]> =>
          Promise.resolve(
            allGenFrames.map(({ frameId, url }) => ({ frameId, url })),
          );

        const outcome = await injector.injectAllFrames({
          tabId: 42,
          sessionId: "session-1",
          files: ["src/content/content.js"],
          topFrameUrl: TOP_FRAME_URL,
          enumerateFrames,
        });

        // Req 9.1: a single all-frames injection was issued.
        expect(calls.length).toBeGreaterThanOrEqual(1);
        expect(calls[0]?.target.allFrames).toBe(true);

        const inaccessible = allGenFrames.filter((f) => !f.accessible);
        const accessible = allGenFrames.filter((f) => f.accessible);

        // 1. Every inaccessible frame is excluded from selection.
        for (const frame of inaccessible) {
          expect(outcome.injectedFrameIds).not.toContain(frame.frameId);
        }

        // 2. Every accessible frame IS injected.
        for (const frame of accessible) {
          expect(outcome.injectedFrameIds).toContain(frame.frameId);
        }

        // 3. A FrameExclusion report exists for each inaccessible frame —
        //    exactly once — in both the returned exclusions and the emitted
        //    reports.
        for (const frame of inaccessible) {
          const outcomeMatches = outcome.exclusions.filter(
            (e) => e.frameUrl === frame.url,
          );
          expect(outcomeMatches.length).toBe(1);

          const reportMatches = reports.filter(
            (r) => r.frameUrl === frame.url,
          );
          expect(reportMatches.length).toBe(1);
        }

        // 4. The exclusion count matches the inaccessible-frame count exactly:
        //    no accessible frame is reported and nothing is reported twice.
        expect(outcome.exclusions.length).toBe(inaccessible.length);
        expect(reports.length).toBe(inaccessible.length);

        // 5. No accessible frame's url appears in any exclusion report.
        const accessibleUrls = new Set(accessible.map((f) => f.url));
        for (const report of reports) {
          expect(accessibleUrls.has(report.frameUrl)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });
});

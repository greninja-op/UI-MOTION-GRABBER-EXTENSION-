// Feature: ui-motion-grabber — Integration test for iframe injection (Task 13.3)
//
// Validates: Requirements 9.1
//
// Requirement 9.1 (requirements.md / design.md "Iframe Injection"):
//   The System SHALL inject the Content_Script into a tab and all of its
//   permitted sub-frames using `chrome.scripting.executeScript` with
//   `allFrames: true`.
//
// This is an integration test (not a property test): it mocks
// `chrome.scripting.executeScript` with a spy and drives
// `FrameInjector.injectAllFrames`, then asserts the single all-frames
// injection was issued against the right tab with `allFrames: true` and the
// Content_Script file(s) supplied to it.
import { describe, it, expect, vi } from "vitest";
import {
  createFrameInjector,
  type InjectionResult,
  type ScriptInjection,
} from "../../src/worker/frame-injector.ts";

const CONTENT_FILES = ["src/content/content.js"];
const TAB_ID = 7;

describe("FrameInjector — iframe injection integration (Req 9.1)", () => {
  it("calls chrome.scripting.executeScript with allFrames: true and the content files", async () => {
    // Spy standing in for `chrome.scripting.executeScript`. The top frame
    // (id 0) succeeds; that is enough to exercise the all-frames injection path.
    const executeScript = vi.fn(
      (_injection: ScriptInjection): Promise<InjectionResult[]> =>
        Promise.resolve([{ frameId: 0, result: true }]),
    );

    const injector = createFrameInjector({ executeScript });

    const outcome = await injector.injectAllFrames({
      tabId: TAB_ID,
      sessionId: "session-1",
      files: CONTENT_FILES,
    });

    // A single all-frames injection was issued (Req 9.1).
    expect(executeScript).toHaveBeenCalledTimes(1);

    // It targeted the active tab with `allFrames: true` and carried the
    // Content_Script file(s).
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: TAB_ID, allFrames: true },
      files: CONTENT_FILES,
    });

    // The accessible top frame is reported as injected.
    expect(outcome.injectedFrameIds).toContain(0);
    expect(outcome.exclusions).toEqual([]);
  });

  it("resolves the scripting surface from the ambient chrome global", async () => {
    // When constructed without an explicit scripting surface, the injector
    // falls back to `globalThis.chrome.scripting` — the real wiring used by the
    // Service_Worker. We assert the same `allFrames: true` contract holds there.
    const executeScript = vi.fn(
      (_injection: ScriptInjection): Promise<InjectionResult[]> =>
        Promise.resolve([{ frameId: 0, result: true }]),
    );

    const globalWithChrome = globalThis as {
      chrome?: { scripting?: { executeScript: typeof executeScript } };
    };
    const previousChrome = globalWithChrome.chrome;
    globalWithChrome.chrome = { scripting: { executeScript } };

    try {
      const injector = createFrameInjector();
      await injector.injectAllFrames({
        tabId: TAB_ID,
        sessionId: "session-2",
        files: CONTENT_FILES,
      });

      expect(executeScript).toHaveBeenCalledTimes(1);
      const injection = executeScript.mock.calls[0]?.[0];
      expect(injection?.target.allFrames).toBe(true);
      expect(injection?.target.tabId).toBe(TAB_ID);
      expect(injection?.files).toEqual(CONTENT_FILES);
    } finally {
      if (previousChrome === undefined) {
        delete globalWithChrome.chrome;
      } else {
        globalWithChrome.chrome = previousChrome;
      }
    }
  });
});

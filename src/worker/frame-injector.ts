/**
 * Frame Injector (Service_Worker component).
 *
 * Injects the Content_Script into a tab and all of its permitted sub-frames
 * using `chrome.scripting.executeScript` with `allFrames: true` (Req 9.1).
 * Cross-origin / inaccessible sub-frames cannot be scripted; their access
 * exceptions (`SecurityError` and friends) are caught, the frames are excluded
 * from selection, and a `FRAME_EXCLUDED` report — one per excluded frame —
 * carrying a `FrameExclusion` (`{ frameUrl, reason }`) is emitted to the
 * Popup_UI (Req 9.2).
 *
 * Design reference: design.md "Iframe Injection".
 * Requirements:
 *   - 9.1: inject into sub-frames via `chrome.scripting.executeScript` with
 *          `allFrames` enabled.
 *   - 9.2: exclude inaccessible (cross-origin) sub-frames and report each one
 *          to the Popup_UI via a `FRAME_EXCLUDED` message.
 *
 * This module NEVER throws on a frame-level access failure. A frame that cannot
 * be injected is reported and skipped so the remaining accessible frames still
 * yield a usable session. The `chrome.scripting` surface and the message
 * emitter are injectable so the injector can be exercised against mocks.
 */

import type { FrameExclusion } from "../shared/index.ts";
import {
  MessageType,
  type MessageEnvelope,
} from "../shared/index.ts";

// ---------------------------------------------------------------------------
// Minimal chrome.scripting typings
// ---------------------------------------------------------------------------
//
// `@types/chrome` is intentionally not a dependency of this zero-dependency
// project, so we declare the narrow slice of the `chrome.scripting` surface
// this injector consumes. The shapes mirror the MV3 promise-based API.

/** The `target` of an `executeScript` injection. */
export interface InjectionTarget {
  tabId: number;
  /** Inject into every accessible frame of the tab (Req 9.1). */
  allFrames?: boolean;
  /** Restrict injection to specific frames (used by the per-frame fallback). */
  frameIds?: number[];
}

/** An `executeScript` injection request restricted to file-based scripts. */
export interface ScriptInjection {
  target: InjectionTarget;
  /** Content_Script file(s) to inject (e.g. `["src/content/content.js"]`). */
  files: string[];
}

/**
 * One entry of the `executeScript` result array — a single frame's outcome.
 * Newer Chrome builds surface a per-frame `error` string when a frame in an
 * `allFrames` injection could not be scripted; we honor it when present.
 */
export interface InjectionResult {
  frameId: number;
  result?: unknown;
  /** Per-frame failure description, when the platform reports one. */
  error?: string;
}

/**
 * The narrow `chrome.scripting` surface this injector depends on. Injectable so
 * the injector can be exercised against a mock in tests.
 */
export interface ScriptingApi {
  executeScript(injection: ScriptInjection): Promise<InjectionResult[]>;
}

/** A frame discovered in the target tab, used to detect exclusions. */
export interface FrameInfo {
  frameId: number;
  url: string;
}

/**
 * Optional frame enumerator. When supplied, frames it lists that were NOT
 * injected are treated as excluded (cross-origin / inaccessible) and reported.
 * Mirrors the shape of `chrome.webNavigation.getAllFrames` results.
 */
export type FrameEnumerator = (tabId: number) => Promise<FrameInfo[]>;

/** Sink for `FRAME_EXCLUDED` envelopes routed to the Popup_UI. */
export type MessageEmitter = (
  envelope: MessageEnvelope<typeof MessageType.FRAME_EXCLUDED, FrameExclusion>,
) => void;

// ---------------------------------------------------------------------------
// Public options / result
// ---------------------------------------------------------------------------

/** Inputs for an all-frames Content_Script injection pass. */
export interface InjectAllFramesOptions {
  /** The active tab to inject into. */
  tabId: number;
  /** Correlates emitted reports with the Recording_Session. */
  sessionId: string;
  /** Content_Script file(s) to inject. */
  files: string[];
  /**
   * URL of the top frame, used to classify excluded frames as `cross-origin`
   * (different origin) versus merely `inaccessible`. Optional.
   */
  topFrameUrl?: string;
  /**
   * Optional enumeration of every frame in the tab. Frames listed here that
   * were not injected are reported as excluded. When omitted, only frames the
   * platform actively reports as failed are excluded.
   */
  enumerateFrames?: FrameEnumerator;
}

/** Outcome of an all-frames injection pass. */
export interface InjectionOutcome {
  /** Frame ids the Content_Script was successfully injected into. */
  injectedFrameIds: number[];
  /** One entry per excluded sub-frame; mirrors the emitted reports (Req 9.2). */
  exclusions: FrameExclusion[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the `chrome.scripting` API from the ambient global, if present. */
function resolveAmbientScripting(): ScriptingApi | undefined {
  const chromeGlobal = (
    globalThis as {
      chrome?: { scripting?: ScriptingApi };
    }
  ).chrome;
  return chromeGlobal?.scripting;
}

/** Resolve `chrome.runtime.sendMessage` as the default emitter, if present. */
function resolveAmbientEmitter(): MessageEmitter | undefined {
  const chromeGlobal = (
    globalThis as {
      chrome?: { runtime?: { sendMessage?: (message: unknown) => unknown } };
    }
  ).chrome;
  const sendMessage = chromeGlobal?.runtime?.sendMessage;
  if (typeof sendMessage !== "function") {
    return undefined;
  }
  return (envelope) => {
    sendMessage(envelope);
  };
}

/** Extract a human-readable message from an unknown thrown value. */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return "";
}

/** Pull the `name` of a thrown value (e.g. `"SecurityError"`), if any. */
function errorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { name?: unknown }).name === "string"
  ) {
    return (error as { name: string }).name;
  }
  return "";
}

/**
 * True when a failure description denotes a cross-origin / security access
 * exception (rather than some other inaccessibility).
 */
function looksCrossOrigin(text: string): boolean {
  const haystack = text.toLowerCase();
  return (
    haystack.includes("securityerror") ||
    haystack.includes("cross-origin") ||
    haystack.includes("cross origin") ||
    haystack.includes("blocked a frame") ||
    haystack.includes("access") && haystack.includes("denied")
  );
}

/** Parse an origin from a URL string; returns `null` when it cannot be parsed. */
function originOf(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Classify why a frame is excluded. A frame whose origin differs from the top
 * frame is `cross-origin`; an explicit security/access signal also forces
 * `cross-origin`; everything else is `inaccessible`.
 */
function classifyReason(
  frameUrl: string,
  topFrameUrl: string | undefined,
  signal: string,
): FrameExclusion["reason"] {
  if (looksCrossOrigin(signal)) {
    return "cross-origin";
  }
  const frameOrigin = originOf(frameUrl);
  const topOrigin = originOf(topFrameUrl);
  if (frameOrigin && topOrigin && frameOrigin !== topOrigin) {
    return "cross-origin";
  }
  return "inaccessible";
}

// ---------------------------------------------------------------------------
// Frame Injector
// ---------------------------------------------------------------------------

/**
 * Injects the Content_Script across a tab and its permitted sub-frames, and
 * reports any sub-frame that could not be scripted to the Popup_UI.
 */
export class FrameInjector {
  private readonly scripting: ScriptingApi | undefined;
  private readonly emit: MessageEmitter | undefined;

  /**
   * @param scripting - the `chrome.scripting` surface. Defaults to the ambient
   *   `globalThis.chrome.scripting`; inject a mock in tests.
   * @param emit - sink for `FRAME_EXCLUDED` envelopes. Defaults to
   *   `chrome.runtime.sendMessage`; inject a spy in tests.
   */
  constructor(
    scripting: ScriptingApi | undefined = resolveAmbientScripting(),
    emit: MessageEmitter | undefined = resolveAmbientEmitter(),
  ) {
    this.scripting = scripting;
    this.emit = emit;
  }

  /**
   * Inject the Content_Script into every accessible frame of the tab using
   * `allFrames: true` (Req 9.1), then exclude and report each inaccessible
   * (cross-origin) sub-frame via a `FRAME_EXCLUDED` message (Req 9.2).
   *
   * Never throws on a frame-level access failure. If the whole injection call
   * rejects, the failure is treated as a top-level exclusion report and an
   * empty injection set is returned.
   */
  async injectAllFrames(
    options: InjectAllFramesOptions,
  ): Promise<InjectionOutcome> {
    const { tabId, sessionId, files, topFrameUrl, enumerateFrames } = options;

    if (!this.scripting) {
      // No scripting surface at all — nothing can be injected.
      return { injectedFrameIds: [], exclusions: [] };
    }

    const injectedFrameIds: number[] = [];
    const exclusions: FrameExclusion[] = [];

    // Enumerate frames up front (best-effort) so we can diff against whatever
    // the all-frames injection actually reached.
    const allFrames = await this.safeEnumerate(enumerateFrames, tabId);
    const frameUrlById = new Map<number, string>();
    for (const frame of allFrames) {
      frameUrlById.set(frame.frameId, frame.url);
    }

    let results: InjectionResult[] = [];
    try {
      // Req 9.1: single all-frames injection.
      results = await this.scripting.executeScript({
        target: { tabId, allFrames: true },
        files,
      });
    } catch (error) {
      // The whole injection rejected (commonly because a cross-origin frame in
      // the set raised a SecurityError). Fall back to per-frame injection when
      // we have an enumeration; otherwise report a single exclusion using the
      // best URL we have.
      if (allFrames.length > 0) {
        return this.injectPerFrame(options, allFrames);
      }
      const signal = `${errorName(error)} ${describeError(error)}`.trim();
      const frameUrl = topFrameUrl ?? "";
      const reason = classifyReason(frameUrl, topFrameUrl, signal);
      const exclusion: FrameExclusion = { frameUrl, reason };
      this.report(sessionId, exclusion);
      return { injectedFrameIds: [], exclusions: [exclusion] };
    }

    // Walk the per-frame results. Entries with an `error` are excluded; the
    // rest are considered successfully injected.
    const injectedSet = new Set<number>();
    for (const result of results) {
      if (result.error) {
        const frameUrl = frameUrlById.get(result.frameId) ?? "";
        const reason = classifyReason(frameUrl, topFrameUrl, result.error);
        const exclusion: FrameExclusion = { frameUrl, reason };
        exclusions.push(exclusion);
        this.report(sessionId, exclusion);
        continue;
      }
      injectedSet.add(result.frameId);
      injectedFrameIds.push(result.frameId);
    }

    // Any enumerated frame the injection never reached is inaccessible and must
    // be excluded + reported (Req 9.2).
    for (const frame of allFrames) {
      if (injectedSet.has(frame.frameId)) {
        continue;
      }
      if (exclusions.some((e) => e.frameUrl === frame.url)) {
        continue;
      }
      const reason = classifyReason(frame.url, topFrameUrl, "");
      const exclusion: FrameExclusion = { frameUrl: frame.url, reason };
      exclusions.push(exclusion);
      this.report(sessionId, exclusion);
    }

    return { injectedFrameIds, exclusions };
  }

  /**
   * Fallback path: inject each enumerated frame individually so we can catch a
   * `SecurityError`/access exception per frame and report exactly the frames
   * that fail (Req 9.2), while still injecting every accessible frame.
   */
  private async injectPerFrame(
    options: InjectAllFramesOptions,
    frames: FrameInfo[],
  ): Promise<InjectionOutcome> {
    const { tabId, sessionId, files, topFrameUrl } = options;
    const scripting = this.scripting;
    const injectedFrameIds: number[] = [];
    const exclusions: FrameExclusion[] = [];

    for (const frame of frames) {
      try {
        await scripting!.executeScript({
          target: { tabId, frameIds: [frame.frameId] },
          files,
        });
        injectedFrameIds.push(frame.frameId);
      } catch (error) {
        const signal = `${errorName(error)} ${describeError(error)}`.trim();
        const reason = classifyReason(frame.url, topFrameUrl, signal);
        const exclusion: FrameExclusion = { frameUrl: frame.url, reason };
        exclusions.push(exclusion);
        this.report(sessionId, exclusion);
      }
    }

    return { injectedFrameIds, exclusions };
  }

  /** Run the optional enumerator, swallowing any failure into an empty list. */
  private async safeEnumerate(
    enumerateFrames: FrameEnumerator | undefined,
    tabId: number,
  ): Promise<FrameInfo[]> {
    if (!enumerateFrames) {
      return [];
    }
    try {
      const frames = await enumerateFrames(tabId);
      return Array.isArray(frames) ? frames : [];
    } catch {
      return [];
    }
  }

  /** Emit one `FRAME_EXCLUDED` envelope for an excluded sub-frame (Req 9.2). */
  private report(sessionId: string, exclusion: FrameExclusion): void {
    if (!this.emit) {
      return;
    }
    this.emit({
      type: MessageType.FRAME_EXCLUDED,
      sessionId,
      payload: exclusion,
    });
  }
}

/**
 * Convenience factory mirroring the ambient-default constructor. Useful for the
 * Service_Worker entry point where a single shared injector suffices.
 */
export function createFrameInjector(
  scripting?: ScriptingApi,
  emit?: MessageEmitter,
): FrameInjector {
  return new FrameInjector(scripting, emit);
}

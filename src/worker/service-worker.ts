/**
 * Service_Worker messaging router.
 *
 * Wires the Message_Channel (design.md "Messaging Interface") to the analysis
 * pipeline. This is the Service_Worker half of the contract the Content_Script
 * client (`src/content/message-channel.js`) speaks:
 *
 *   * The Content_Script streams the frozen Interaction_Timeline as a
 *     `TIMELINE_CHUNK` envelope over a Chrome `Port`, then issues a
 *     `SESSION_STOP` one-shot command via `chrome.runtime.sendMessage`.
 *   * On `SESSION_STOP`, this router runs the analysis pipeline
 *     (State_Diffing_Engine -> Animation_Parser -> Reverse_Engineering_Engine
 *     -> Export_Payload Assembler) and sends `STATE_MAP` and `EXPORT_PAYLOAD`
 *     envelopes back out to the Popup_UI via `chrome.runtime.sendMessage`.
 *
 * Requirements:
 *   - 3.4: produce a State_Map and send it to the Popup_UI.
 *   - 7.5: state diffing/transformation happens inside the Service_Worker.
 *   - 7.6: cross-context traffic uses `chrome.runtime.sendMessage` + `Port`.
 *
 * The `chrome` surface is injectable so the router can be exercised against a
 * mock; it defaults to the ambient `globalThis.chrome`.
 */

import {
  MessageType,
  type MessageEnvelope,
  type CodeTabs,
  type ComputedStyleSnapshot,
  type FigmaToken,
  type InteractionTimeline,
} from "../shared/index.ts";

import {
  runAnalysisPipeline,
  type AnalysisPipelineResult,
  type RawAnimationDescriptor,
} from "./analysis-pipeline.ts";

// ---------------------------------------------------------------------------
// Minimal chrome messaging typings
// ---------------------------------------------------------------------------
//
// `@types/chrome` is intentionally not a dependency of this zero-dependency
// project, so we declare the narrow slice of the messaging surface this router
// consumes. The shapes mirror the MV3 API.

/** A listenable event with add/remove listener methods. */
export interface ChromeEvent<Listener extends (...args: never[]) => unknown> {
  addListener(listener: Listener): void;
  removeListener?(listener: Listener): void;
}

/** The narrow `Port` surface this router consumes. */
export interface ChromePort {
  name?: string;
  onMessage: ChromeEvent<(message: unknown) => void>;
  onDisconnect: ChromeEvent<(port: ChromePort) => void>;
  postMessage?(message: unknown): void;
  disconnect?(): void;
}

/** The narrow `chrome.runtime` surface this router consumes. */
export interface ChromeRuntime {
  onMessage: ChromeEvent<
    (
      message: unknown,
      sender: unknown,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void
  >;
  onConnect: ChromeEvent<(port: ChromePort) => void>;
  sendMessage(message: unknown): unknown;
}

/** The narrow `chrome` surface this router depends on. */
export interface ChromeApi {
  runtime: ChromeRuntime;
}

// ---------------------------------------------------------------------------
// Payload shapes carried over the Message_Channel
// ---------------------------------------------------------------------------

/**
 * The body of a `TIMELINE_CHUNK` / `SESSION_STOP` message. The Content_Script
 * sends `{ timeline }`; the optional fields allow capture-side Animation_Parser
 * output (computed snapshot, animation descriptors) and pre-rendered code tabs
 * to ride along so the worker can build a richer report when available.
 */
export interface TimelinePayload {
  timeline?: InteractionTimeline;
  sessionId?: string;
  computed?: ComputedStyleSnapshot | null;
  animations?: readonly RawAnimationDescriptor[] | null;
  codeTabs?: CodeTabs | null;
  figmaTokens?: readonly FigmaToken[] | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MESSAGE_TYPE_VALUES: readonly string[] = Object.values(MessageType);

/** Narrowing guard for a Message_Channel envelope (mirrors the shared guard). */
function isMessageEnvelope(value: unknown): value is MessageEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.type === "string" &&
    MESSAGE_TYPE_VALUES.includes(candidate.type) &&
    typeof candidate.sessionId === "string" &&
    "payload" in candidate
  );
}

/** Resolve the ambient `chrome` messaging surface, if present. */
function resolveAmbientChrome(): ChromeApi | undefined {
  const chromeGlobal = (globalThis as { chrome?: unknown }).chrome;
  if (
    chromeGlobal &&
    typeof chromeGlobal === "object" &&
    "runtime" in chromeGlobal
  ) {
    return chromeGlobal as ChromeApi;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Service_Worker router
// ---------------------------------------------------------------------------

/** Options for {@link installServiceWorker}. */
export interface InstallServiceWorkerOptions {
  /** The Chrome messaging surface. Defaults to ambient `globalThis.chrome`. */
  chrome?: ChromeApi;
  /**
   * Hook invoked after each completed analysis pass (after `STATE_MAP` and
   * `EXPORT_PAYLOAD` have been sent). Useful for logging/diagnostics and tests.
   */
  onAnalyzed?: (sessionId: string, result: AnalysisPipelineResult) => void;
}

/** The handle returned by {@link installServiceWorker}. */
export interface ServiceWorkerHandle {
  /**
   * Run the analysis pipeline for a session's accumulated timeline and send the
   * `STATE_MAP` + `EXPORT_PAYLOAD` envelopes to the Popup_UI. Exposed so the
   * router can be driven directly in tests; normally invoked on `SESSION_STOP`.
   */
  analyzeSession(sessionId: string, override?: TimelinePayload): AnalysisPipelineResult | null;
}

/**
 * Install the Service_Worker message handlers and wire them to the analysis
 * pipeline (Req 3.4, 7.5, 7.6).
 *
 * Listens for:
 *   * `TIMELINE_CHUNK` envelopes over a `Port` (and, defensively, as one-shot
 *     runtime messages) — accumulated per Recording_Session.
 *   * `SESSION_STOP` commands — finalize the session: run the pipeline and emit
 *     `STATE_MAP` + `EXPORT_PAYLOAD` to the Popup_UI.
 *
 * @returns a handle exposing `analyzeSession` for direct invocation/testing.
 */
export function installServiceWorker(
  options: InstallServiceWorkerOptions = {},
): ServiceWorkerHandle {
  const chromeApi = options.chrome ?? resolveAmbientChrome();
  if (!chromeApi || !chromeApi.runtime) {
    throw new Error(
      "installServiceWorker: chrome.runtime is unavailable in this context",
    );
  }
  const runtime = chromeApi.runtime;

  /**
   * Per-session accumulated capture payloads. Keyed by `sessionId` so multiple
   * concurrent Recording_Sessions never cross-contaminate. Each `TIMELINE_CHUNK`
   * merges into the session's pending payload; `SESSION_STOP` consumes it.
   */
  const pending = new Map<string, TimelinePayload>();

  /**
   * Cache of the most recent completed analysis, so the Popup_UI can fetch the
   * last capture's results when it is reopened (Chromium closes the popup the
   * moment the page is clicked, so result pushes can arrive while it is shut).
   */
  const latestBySession = new Map<string, AnalysisPipelineResult>();
  let latestAny: { sessionId: string; result: AnalysisPipelineResult } | null =
    null;

  /** Merge an incoming chunk payload into the session's accumulated payload. */
  function accumulate(sessionId: string, payload: TimelinePayload): void {
    const current = pending.get(sessionId) ?? {};
    const incomingTimeline = Array.isArray(payload.timeline)
      ? payload.timeline
      : [];
    const mergedTimeline: InteractionTimeline = [
      ...(current.timeline ?? []),
      ...incomingTimeline,
    ];

    pending.set(sessionId, {
      timeline: mergedTimeline,
      sessionId,
      // Later chunks may carry capture-side context; keep the latest non-null.
      computed: payload.computed ?? current.computed ?? null,
      animations: payload.animations ?? current.animations ?? null,
      codeTabs: payload.codeTabs ?? current.codeTabs ?? null,
      figmaTokens: payload.figmaTokens ?? current.figmaTokens ?? null,
    });
  }

  /** Build and send an envelope to the Popup_UI via `sendMessage` (Req 7.6). */
  function send<P>(type: MessageType, sessionId: string, payload: P): void {
    const envelope: MessageEnvelope<MessageType, P> = { type, sessionId, payload };
    runtime.sendMessage(envelope);
  }

  /**
   * Run the pipeline for a session and emit `STATE_MAP` + `EXPORT_PAYLOAD`
   * (Req 3.4, 7.6). Returns `null` when there is nothing to analyze.
   */
  function analyzeSession(
    sessionId: string,
    override?: TimelinePayload,
  ): AnalysisPipelineResult | null {
    const accumulated = override ?? pending.get(sessionId);
    if (!accumulated) {
      return null;
    }

    const result = runAnalysisPipeline({
      timeline: accumulated.timeline ?? [],
      sessionId,
      computed: accumulated.computed ?? null,
      animations: accumulated.animations ?? null,
      codeTabs: accumulated.codeTabs ?? null,
      figmaTokens: accumulated.figmaTokens ?? null,
    });

    // Send the diffed State_Map (Req 3.4) and the assembled Export_Payload to
    // the Popup_UI (Req 7.6).
    send(MessageType.STATE_MAP, sessionId, result.stateMap);
    send(MessageType.EXPORT_PAYLOAD, sessionId, result.exportPayload);

    // Cache the result so a (re)opened Popup_UI can fetch it on demand.
    latestBySession.set(sessionId, result);
    latestAny = { sessionId, result };

    // The session is finalized; drop its accumulated capture data.
    pending.delete(sessionId);

    options.onAnalyzed?.(sessionId, result);
    return result;
  }

  /** Dispatch a validated envelope to the appropriate handler. */
  function dispatch(envelope: MessageEnvelope): void {
    const { type, sessionId, payload } = envelope;
    switch (type) {
      case MessageType.TIMELINE_CHUNK:
        accumulate(sessionId, (payload ?? {}) as TimelinePayload);
        break;
      case MessageType.SESSION_STOP: {
        // A SESSION_STOP may itself carry the timeline; merge it before run.
        const stopPayload = (payload ?? {}) as TimelinePayload;
        if (Array.isArray(stopPayload.timeline) && stopPayload.timeline.length) {
          accumulate(sessionId, stopPayload);
        }
        analyzeSession(sessionId);
        break;
      }
      case MessageType.EXPORT_PAYLOAD: {
        // A request from the Popup_UI for the latest cached results (sent on
        // popup open). Re-emit the most recent STATE_MAP + EXPORT_PAYLOAD so the
        // UI can populate even though the live push may have been missed.
        const req = (payload ?? {}) as { request?: boolean };
        if (req.request) {
          const cached =
            latestBySession.get(sessionId) ?? latestAny?.result ?? null;
          const sid = latestBySession.has(sessionId)
            ? sessionId
            : latestAny?.sessionId ?? sessionId;
          if (cached) {
            send(MessageType.STATE_MAP, sid, cached.stateMap);
            send(MessageType.EXPORT_PAYLOAD, sid, cached.exportPayload);
          }
        }
        break;
      }
      default:
        // Other message types are handled by other Service_Worker subsystems.
        break;
    }
  }

  // Streaming chunks arrive over a Port (Req 7.6). Each connection forwards its
  // envelopes into the same dispatcher.
  runtime.onConnect.addListener((port: ChromePort) => {
    port.onMessage.addListener((message: unknown) => {
      if (isMessageEnvelope(message)) {
        dispatch(message);
      }
    });
  });

  // One-shot commands (e.g. SESSION_STOP) arrive as runtime messages (Req 7.6).
  runtime.onMessage.addListener(
    (message: unknown): boolean | void => {
      if (isMessageEnvelope(message)) {
        dispatch(message);
      }
      return undefined;
    },
  );

  return { analyzeSession };
}

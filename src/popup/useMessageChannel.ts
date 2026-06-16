/**
 * useMessageChannel — React hook that binds the Popup_UI to the Message_Channel.
 *
 * It wraps {@link createPopupMessageChannel} and:
 *   * subscribes to inbound `STATE_MAP`, `EXPORT_PAYLOAD`, and `FRAME_EXCLUDED`
 *     envelopes pushed by the Service_Worker and exposes them as React state
 *     for the presentational components to render (Req 6.3, 9.2, 7.6);
 *   * exposes start / pause / resume / stop / freeze / export command issuers
 *     that send envelopes to the Service_Worker (Req 7.6) and update the local
 *     Session_Controls_State optimistically;
 *   * surfaces inbound exclusions and lifecycle changes as User_Feedback_Message
 *     entries for the Feedback_Banner.
 *
 * The chrome surface is injectable and guarded, so the popup still renders (and
 * the commands become inert no-ops) when no extension context is present.
 *
 * Requirements: 6.3, 7.6.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MessageType,
  type ExportPayload,
  type FrameExclusion,
  type SessionControlsState,
  type StateMap,
  type UserFeedbackMessage,
} from "../shared";
import {
  createPopupMessageChannel,
  type FreezePseudoState,
  type PopupChromeApi,
} from "./messaging";

/** Options for {@link useMessageChannel}. */
export interface UseMessageChannelOptions {
  /** Chrome messaging surface. Defaults to ambient `globalThis.chrome`. */
  chrome?: PopupChromeApi;
  /** Initial Recording_Session id stamped onto outgoing envelopes. */
  sessionId?: string;
}

/** The command issuers exposed by the hook. */
export interface SessionCommands {
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  freeze(pseudo: FreezePseudoState): void;
  requestExport(): void;
}

/** The reactive surface returned by {@link useMessageChannel}. */
export interface UseMessageChannelResult {
  /** Whether an extension messaging context is reachable. */
  available: boolean;
  /** Latest diffed State_Map pushed by the Service_Worker, or null. */
  stateMap: StateMap | null;
  /** Latest assembled Export_Payload pushed by the Service_Worker, or null. */
  exportPayload: ExportPayload | null;
  /** Whether the user has requested the JSON export view (Req 6.3). */
  exportRequested: boolean;
  /** Accumulated cross-origin / inaccessible sub-frame exclusions (Req 9.2). */
  frameExclusions: FrameExclusion[];
  /** Feedback_Banner messages (newest-first). */
  feedback: UserFeedbackMessage[];
  /** The Popup_UI view-model of the Recording_Status (Req 11.7). */
  controlsState: SessionControlsState;
  /** Command issuers wired to the Service_Worker (Req 7.6). */
  commands: SessionCommands;
  /** Push a feedback message (e.g. a clipboard-copy failure, Req 6.9). */
  pushFeedback(message: UserFeedbackMessage): void;
  /** Dismiss a feedback message by index. */
  dismissFeedback(index: number): void;
}

/** Payload shape of an inbound `FRAME_EXCLUDED` envelope. */
function asFrameExclusion(payload: unknown): FrameExclusion | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.frameUrl === "string" &&
    (candidate.reason === "cross-origin" || candidate.reason === "inaccessible")
  ) {
    return { frameUrl: candidate.frameUrl, reason: candidate.reason };
  }
  return null;
}

export function useMessageChannel(
  options: UseMessageChannelOptions = {},
): UseMessageChannelResult {
  const { chrome, sessionId } = options;

  // The channel is created once per mount; the chrome surface and initial
  // session id are read on first render (stable for the popup's lifetime).
  const channel = useMemo(
    () => createPopupMessageChannel({ chrome, sessionId }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [stateMap, setStateMap] = useState<StateMap | null>(null);
  const [exportPayload, setExportPayload] = useState<ExportPayload | null>(null);
  const [exportRequested, setExportRequested] = useState(false);
  const [frameExclusions, setFrameExclusions] = useState<FrameExclusion[]>([]);
  const [feedback, setFeedback] = useState<UserFeedbackMessage[]>([]);
  const [controlsState, setControlsState] =
    useState<SessionControlsState>("IDLE");

  const pushFeedback = useCallback((message: UserFeedbackMessage) => {
    setFeedback((current) => [message, ...current]);
  }, []);

  const dismissFeedback = useCallback((index: number) => {
    setFeedback((current) => current.filter((_, i) => i !== index));
  }, []);

  // Subscribe to inbound envelopes for the lifetime of the popup.
  useEffect(() => {
    const unsubscribe = channel.onInbound((envelope) => {
      switch (envelope.type) {
        case MessageType.STATE_MAP:
          setStateMap(envelope.payload as StateMap);
          break;
        case MessageType.EXPORT_PAYLOAD:
          setExportPayload(envelope.payload as ExportPayload);
          break;
        case MessageType.FRAME_EXCLUDED: {
          const exclusion = asFrameExclusion(envelope.payload);
          if (exclusion) {
            setFrameExclusions((current) => [...current, exclusion]);
            // Excluded sub-frames also surface as WARN feedback (Req 12.6).
            pushFeedback({
              type: "WARN",
              text: `Sub-frame excluded (${exclusion.reason}): ${
                exclusion.frameUrl || "unknown frame"
              }`,
            });
          }
          break;
        }
        default:
          break;
      }
    });
    return unsubscribe;
  }, [channel, pushFeedback]);

  // Tear down the streaming Port when the popup unmounts.
  useEffect(() => {
    return () => {
      channel.disconnect();
    };
  }, [channel]);

  // On open, ask the Service_Worker for the most recent cached results so a
  // reopened popup shows the last capture even if it was closed when the live
  // push arrived.
  useEffect(() => {
    channel.requestLatest();
  }, [channel]);

  const commands = useMemo<SessionCommands>(
    () => ({
      start() {
        channel.start();
        setControlsState("RECORDING");
        pushFeedback({ type: "SUCCESS", text: "Recording started." });
      },
      pause() {
        channel.pause();
        setControlsState("PAUSED");
        pushFeedback({ type: "SUCCESS", text: "Recording paused." });
      },
      resume() {
        channel.resume();
        setControlsState("RECORDING");
        pushFeedback({ type: "SUCCESS", text: "Recording resumed." });
      },
      stop() {
        channel.stop();
        setControlsState("STOPPED");
        pushFeedback({ type: "SUCCESS", text: "Recording stopped." });
      },
      freeze(pseudo: FreezePseudoState) {
        channel.freeze(pseudo);
        pushFeedback({ type: "SUCCESS", text: `Freezing :${pseudo} state.` });
      },
      requestExport() {
        channel.requestExport();
        setExportRequested(true);
      },
    }),
    [channel, pushFeedback],
  );

  return {
    available: channel.available,
    stateMap,
    exportPayload,
    exportRequested,
    frameExclusions,
    feedback,
    controlsState,
    commands,
    pushFeedback,
    dismissFeedback,
  };
}

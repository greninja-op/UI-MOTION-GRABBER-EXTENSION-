/**
 * App — composes the Popup_UI and wires it to the Message_Channel.
 *
 * Layout order (top → bottom):
 *   FeedbackBanner  (Req 12.1, always at the top)
 *   SessionControls (start / pause / resume / stop / freeze / export — Req 7.6)
 *   FrameNotice     (Req 9.2)
 *   CodeTabs        (Req 6.5, 6.6, 6.7, 6.9)
 *   EasingTimeline  (Req 6.5)
 *   JsonExportView  (Req 6.3)
 *
 * Live data slices arrive over the Message_Channel via {@link useMessageChannel}
 * (inbound `STATE_MAP` / `EXPORT_PAYLOAD` / `FRAME_EXCLUDED`), and the control
 * toolbar issues start/pause/resume/stop/freeze/export commands to the
 * Service_Worker (Req 6.3, 7.6). The `chrome` surface is injectable/guarded so
 * the popup still renders (with commands inert) outside an extension context.
 *
 * The optional props remain for graceful default rendering and tests: when a
 * live value is absent, the corresponding prop seed (or an empty default) is
 * shown instead, so the popup never crashes on partial/missing data.
 */
import { useCallback, useMemo } from "react";
import type {
  ExportPayload,
  FrameExclusion,
  SessionControlsState,
  StateMap,
  CodeTabs as CodeTabsData,
  UserFeedbackMessage,
} from "../shared";
import {
  CodeTabs,
  EasingTimeline,
  FeedbackBanner,
  FrameNotice,
  JsonExportView,
} from "./components";
import { useMessageChannel } from "./useMessageChannel";
import type { PopupChromeApi } from "./messaging";

export interface AppProps {
  /** Chrome messaging surface. Defaults to ambient `globalThis.chrome`. */
  chrome?: PopupChromeApi;
  /** Recording_Session id stamped onto outgoing command envelopes. */
  sessionId?: string;
  /** Seed/override for the HTML/CSS code tabs (live Export_Payload wins). */
  codeTabs?: CodeTabsData | null;
  /** Seed/override for the State_Map (live STATE_MAP wins). */
  stateMap?: StateMap | null;
  /** Seed/override for the Export_Payload (live EXPORT_PAYLOAD wins). */
  exportPayload?: ExportPayload | null;
  /** Force the JSON export view open regardless of user request. */
  exportRequested?: boolean;
  /** Seed/override for excluded sub-frames (live FRAME_EXCLUDED appends). */
  frameExclusions?: FrameExclusion[];
  /** Seed feedback messages prepended to live messages. */
  feedbackMessages?: UserFeedbackMessage[];
}

/** The session control toolbar — issues commands to the Service_Worker. */
function SessionControls({
  state,
  available,
  onStart,
  onPause,
  onResume,
  onStop,
  onFreeze,
  onExport,
}: {
  state: SessionControlsState;
  available: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onFreeze: () => void;
  onExport: () => void;
}): JSX.Element {
  const isRecording = state === "RECORDING";
  const isPaused = state === "PAUSED";
  const isActive = isRecording || isPaused;
  const btn =
    "rounded px-3 py-1 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <section
      data-testid="session-controls"
      data-controls-state={state}
      aria-label="Session controls"
      className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-2"
    >
      <span
        data-testid="controls-state"
        className="mr-1 rounded bg-slate-100 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600"
      >
        {state}
      </span>
      <button
        type="button"
        data-command="start"
        onClick={onStart}
        disabled={isActive}
        className={`${btn} bg-blue-600 text-white hover:bg-blue-700`}
      >
        Start
      </button>
      {isPaused ? (
        <button
          type="button"
          data-command="resume"
          onClick={onResume}
          className={`${btn} bg-blue-600 text-white hover:bg-blue-700`}
        >
          Resume
        </button>
      ) : (
        <button
          type="button"
          data-command="pause"
          onClick={onPause}
          disabled={!isRecording}
          className={`${btn} bg-slate-200 text-slate-700 hover:bg-slate-300`}
        >
          Pause
        </button>
      )}
      <button
        type="button"
        data-command="stop"
        onClick={onStop}
        disabled={!isActive}
        className={`${btn} bg-slate-200 text-slate-700 hover:bg-slate-300`}
      >
        Stop
      </button>
      <button
        type="button"
        data-command="freeze"
        onClick={onFreeze}
        disabled={!isActive}
        className={`${btn} bg-slate-200 text-slate-700 hover:bg-slate-300`}
      >
        Freeze :hover
      </button>
      <button
        type="button"
        data-command="export"
        onClick={onExport}
        className={`${btn} bg-slate-800 text-white hover:bg-slate-900`}
      >
        Export
      </button>
      {!available ? (
        <span
          data-testid="controls-offline"
          className="text-xs italic text-slate-400"
        >
          extension context unavailable
        </span>
      ) : null}
    </section>
  );
}

export function App({
  chrome,
  sessionId,
  codeTabs = null,
  stateMap = null,
  exportPayload = null,
  exportRequested,
  frameExclusions = [],
  feedbackMessages = [],
}: AppProps): JSX.Element {
  const channel = useMessageChannel({ chrome, sessionId });

  // Live Message_Channel values take precedence over prop seeds; props provide
  // graceful defaults so the popup renders before any analysis arrives.
  const effectiveStateMap = channel.stateMap ?? stateMap;
  const effectiveExportPayload = channel.exportPayload ?? exportPayload;
  const effectiveCodeTabs = effectiveExportPayload?.codeTabs ?? codeTabs;
  const effectiveExportRequested =
    exportRequested ?? channel.exportRequested;

  const effectiveExclusions = useMemo(
    () => [...frameExclusions, ...channel.frameExclusions],
    [frameExclusions, channel.frameExclusions],
  );

  const messages = useMemo(
    () => [...channel.feedback, ...feedbackMessages],
    [channel.feedback, feedbackMessages],
  );

  // Copy-to-clipboard failures surface as ERROR feedback (Req 6.9).
  const handleCopyError = useCallback(
    (message: UserFeedbackMessage) => {
      channel.pushFeedback(message);
    },
    [channel],
  );

  // Dismissals target the live feedback list; seed messages sit after it.
  const handleDismiss = useCallback(
    (index: number) => {
      if (index < channel.feedback.length) {
        channel.dismissFeedback(index);
      }
    },
    [channel],
  );

  return (
    <div className="flex w-full flex-col bg-white text-slate-900">
      <FeedbackBanner messages={messages} onDismiss={handleDismiss} />
      <SessionControls
        state={channel.controlsState}
        available={channel.available}
        onStart={channel.commands.start}
        onPause={channel.commands.pause}
        onResume={channel.commands.resume}
        onStop={channel.commands.stop}
        onFreeze={() => channel.commands.freeze("hover")}
        onExport={channel.commands.requestExport}
      />
      <FrameNotice exclusions={effectiveExclusions} />
      <CodeTabs codeTabs={effectiveCodeTabs} onCopyError={handleCopyError} />
      <EasingTimeline stateMap={effectiveStateMap} />
      <JsonExportView
        payload={effectiveExportPayload}
        requested={effectiveExportRequested}
      />
    </div>
  );
}

export default App;

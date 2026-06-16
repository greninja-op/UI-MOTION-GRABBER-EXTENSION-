// UI Motion Grabber — Content_Script entry point (content.js)
// Pure Vanilla JavaScript, zero dependencies, unbundled (native ES module).
//
// This is the wiring layer for the Content_Script. It composes the capture
// subsystems into a single Recording_Session app:
//
//   Highlighter      — hover visuals via an isolated CSS class (Req 1.1–1.3)
//   Picker           — capture-phase listeners, click-locking (Req 1.4–1.8)
//   Mutation_Engine  — observer lifecycle + dedup gates (Req 2.x, 10.3)
//   Overlay_UI Host  — isolated Shadow DOM overlay (Req 8.x, 10.2)
//   Session_Controller — Recording_Status state machine + teardown (Req 11.x)
//   Message_Channel  — transport to the Service_Worker (Req 7.6)
//
// The Session_Controller owns the lifecycle; the Picker locks a Target_Element
// which drives Idle -> Recording, and stop()/picker-end performs finally-style
// teardown and forwards the frozen Interaction_Timeline to the Service_Worker.

import { createHighlighter } from "./highlighter.js";
import { createPicker } from "./picker.js";
import { createMutationEngine } from "./mutation-engine.js";
import { OverlayUIHost } from "./overlay-ui.js";
import { createSessionController, RECORDING_STATUS } from "./session-controller.js";
// The Message_Channel client is owned by a sibling module (task 12.1). We only
// reference it here for transport — we do not define it.
import { createMessageChannel, MessageType } from "./message-channel.js";

// Re-export the overlay surface so consumers/tests can reach it via the entry.
export { OverlayUIHost, OVERLAY_CONTAINER_ID, ROOT_STYLE_RESET } from "./overlay-ui.js";
export { createSessionController, RECORDING_STATUS } from "./session-controller.js";

/**
 * Generate a reasonably-unique Recording_Session id. Uses `crypto.randomUUID`
 * when available, falling back to a timestamp+random token otherwise.
 * @returns {string}
 */
function generateSessionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `umg-${crypto.randomUUID()}`;
  }
  return `umg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Compose the Content_Script Recording_Session app, wiring the Picker,
 * Mutation_Engine, Overlay_UI, Session_Controller, and Message_Channel together.
 *
 * Construction is side-effect free aside from creating subsystem instances;
 * call {@link ContentApp.start} to activate Picker_Mode and mount the overlay.
 *
 * @param {object} [options]
 * @param {string} [options.sessionId] - Session id (defaults to a generated id).
 * @param {EventTarget} [options.root] - Picker listener target (defaults to `document`).
 * @param {typeof chrome} [options.chrome] - Chrome API for the Message_Channel
 *   (injectable for testing; defaults to the global `chrome`).
 * @param {boolean} [options.mountOverlay=true] - Whether `start()` mounts the overlay.
 * @returns {{
 *   sessionId: string,
 *   picker: ReturnType<typeof createPicker>,
 *   mutationEngine: ReturnType<typeof createMutationEngine>,
 *   sessionController: ReturnType<typeof createSessionController>,
 *   overlay: OverlayUIHost,
 *   channel: ReturnType<typeof createMessageChannel>,
 *   start: () => void,
 *   pause: () => string,
 *   resume: () => string,
 *   stop: () => string,
 *   getStatus: () => string,
 * }}
 */
export function createContentApp(options = {}) {
  const sessionId = options.sessionId || generateSessionId();
  const mountOverlay = options.mountOverlay !== false;

  // Message_Channel transport to the Service_Worker (Req 7.6). Defined in the
  // sibling module; we only consume it here.
  const channel = createMessageChannel({ chrome: options.chrome, sessionId });

  // Capture subsystems.
  const highlighter = createHighlighter();
  const mutationEngine = createMutationEngine();
  const overlay = new OverlayUIHost();

  /**
   * Forward the frozen Interaction_Timeline to the Service_Worker over the
   * Message_Channel (Req 11.6). Streamed as a TIMELINE_CHUNK and followed by a
   * SESSION_STOP command. Transport failures (e.g. no extension context in
   * tests) are swallowed so teardown is never disrupted.
   * @param {ReadonlyArray<object>} timeline
   * @param {string} sid
   */
  function sendFrozenTimeline(timeline, sid) {
    try {
      channel.streamChunk(MessageType.TIMELINE_CHUNK, { timeline });
      channel.sendCommand(MessageType.SESSION_STOP, { sessionId: sid }).catch(() => {});
    } catch (_transportError) {
      // Messaging is best-effort during teardown; ignore transport errors.
    }
  }

  /**
   * Notify the Popup_UI of canonical Recording_Status changes (Req 11.7). The
   * popup derives its Session_Controls_State view-model from this status.
   * @param {string} status
   */
  function notifyStatus(status) {
    try {
      channel.sendCommand(MessageType.TARGET_LOCKED, { status }).catch(() => {});
    } catch (_transportError) {
      // Best-effort status surfacing; ignore transport errors.
    }
  }

  // Picker locks a Target_Element on click, driving Idle -> Recording via the
  // Session_Controller (forward reference resolved at call time).
  const picker = createPicker({
    root: options.root,
    highlighter,
    onTargetLocked: (target) => {
      sessionController.lock(target);
    },
  });

  // The Session_Controller owns the Recording_Status state machine and the
  // Mutation_Engine + Picker lifecycle, and forwards the frozen timeline on stop.
  const sessionController = createSessionController({
    mutationEngine,
    picker,
    sessionId,
    sendTimeline: sendFrozenTimeline,
    onStatusChange: notifyStatus,
  });

  /**
   * Activate Picker_Mode and (optionally) mount the isolated overlay. The
   * session remains Idle until the user clicks to lock a Target_Element.
   */
  function start() {
    if (mountOverlay) {
      overlay.mount();
    }
    picker.activate();
  }

  return {
    sessionId,
    picker,
    mutationEngine,
    sessionController,
    overlay,
    channel,
    start,
    pause: () => sessionController.pause(),
    resume: () => sessionController.resume(),
    stop: () => {
      const status = sessionController.stop();
      overlay.unmount();
      return status;
    },
    getStatus: () => sessionController.getStatus(),
  };
}

/**
 * Browser bootstrap. When the Content_Script is injected into a real page
 * (`chrome.runtime` present), construct a single Recording_Session app and let
 * the Popup_UI drive it via Message_Channel commands delivered to this tab:
 *
 *   PICKER_START                -> start Picker_Mode (mount overlay, activate picker)
 *   PICKER_START {control:pause}  -> pause the active session
 *   PICKER_START {control:resume} -> resume a paused session
 *   SESSION_STOP                -> stop, tear down, and forward the timeline
 *
 * Construction is side-effect free; nothing touches the host page until a
 * PICKER_START arrives, so merely injecting the script never alters the page.
 * Guarded so importing the module in tests/non-extension contexts is inert.
 *
 * @returns {ReturnType<typeof createContentApp> | null}
 */
export function bootstrapContentScript() {
  if (
    typeof chrome === "undefined" ||
    !chrome.runtime ||
    !chrome.runtime.onMessage
  ) {
    return null;
  }

  const app = createContentApp();

  app.channel.onCommand((envelope) => {
    if (!envelope || typeof envelope !== "object") {
      return;
    }
    switch (envelope.type) {
      case MessageType.PICKER_START: {
        const control =
          envelope.payload && typeof envelope.payload === "object"
            ? envelope.payload.control
            : undefined;
        if (control === "pause") {
          app.pause();
        } else if (control === "resume") {
          app.resume();
        } else {
          app.start();
        }
        break;
      }
      case MessageType.SESSION_STOP:
        app.stop();
        break;
      default:
        break;
    }
  });

  return app;
}

// Activate the bootstrap when running as an injected Content_Script.
bootstrapContentScript();

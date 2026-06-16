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
import { resolveElement } from "./shadow-resolver.js";
import { captureElement } from "./capture.js";

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

  // Message_Channel transport to the Service_Worker (Req 7.6).
  const channel = createMessageChannel({ chrome: options.chrome, sessionId });

  // Capture subsystems.
  const highlighter = createHighlighter();
  const mutationEngine = createMutationEngine();
  const overlay = new OverlayUIHost();

  /** On-page control panel handle, created on start() and dropped on teardown. */
  let panel = null;

  /**
   * Snapshot of the locked Target_Element (markup, computed styles, declared
   * animations, Figma tokens) captured on lock. This is the real payload the
   * Service_Worker analyzes — without it the report comes back empty.
   * @type {{ html: string, css: string, computed: object, animations: object[], figmaTokens: object[] } | null}
   */
  let captured = null;

  /**
   * Forward the frozen Interaction_Timeline plus the captured element context
   * to the Service_Worker (Req 11.6): a TIMELINE_CHUNK carrying the timeline,
   * computed styles, animation descriptors, code tabs, and Figma tokens, then a
   * SESSION_STOP command. Best effort — transport failures never disrupt teardown.
   */
  function sendFrozenTimeline(timeline, sid) {
    try {
      const chunk = { timeline };
      if (captured) {
        chunk.computed = captured.computed;
        chunk.animations = captured.animations;
        chunk.codeTabs = { html: captured.html, css: captured.css };
        chunk.figmaTokens = captured.figmaTokens;
      }
      channel.streamChunk(MessageType.TIMELINE_CHUNK, chunk);
      channel.sendCommand(MessageType.SESSION_STOP, { sessionId: sid }).catch(() => {});
    } catch (_transportError) {
      // Messaging is best-effort during teardown; ignore transport errors.
    }
  }

  /** True when a node belongs to our own injected Overlay_UI (so we ignore it). */
  function isOverlayNode(node) {
    if (!node) {
      return false;
    }
    if (
      overlay.container &&
      (node === overlay.container ||
        (typeof overlay.container.contains === "function" &&
          overlay.container.contains(node)))
    ) {
      return true;
    }
    return (
      typeof node.getRootNode === "function" &&
      Boolean(overlay.shadowRoot) &&
      node.getRootNode() === overlay.shadowRoot
    );
  }

  /** A short, human-readable selector for the locked Target_Element. */
  function describeTarget(el) {
    if (!el || !el.tagName) {
      return "element";
    }
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    let cls = "";
    if (typeof el.className === "string" && el.className.trim()) {
      cls = "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
    }
    return `${tag}${id}${cls}`;
  }

  /**
   * Notify the Popup_UI of canonical Recording_Status changes (Req 11.7) and
   * keep the on-page control panel's status in sync.
   */
  function notifyStatus(status) {
    if (panel) {
      panel.setStatus(status);
    }
    try {
      channel.sendCommand(MessageType.TARGET_LOCKED, { status }).catch(() => {});
    } catch (_transportError) {
      // Best-effort status surfacing; ignore transport errors.
    }
  }

  // Picker locks a Target_Element on click, driving Idle -> Recording.
  const picker = createPicker({
    root: options.root,
    highlighter,
    // Ignore our own overlay so hovering/clicking the control panel never
    // resolves to (or locks) the panel itself.
    resolve: (x, y) => {
      const el = resolveElement(x, y);
      return isOverlayNode(el) ? null : el;
    },
    onTargetLocked: (target) => {
      if (isOverlayNode(target)) {
        return;
      }
      sessionController.lock(target);
      // Capture the element's markup, computed styles, and declared animations
      // now that it is locked — this is the data the report is built from.
      try {
        captured = captureElement(target);
      } catch (_captureError) {
        captured = null;
      }
      // Selection complete: stop intercepting page clicks so the user can
      // freely trigger the element's animations while we observe its mutations.
      picker.deactivate();
      if (panel) {
        panel.setTarget(describeTarget(target));
      }
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
   * Activate Picker_Mode, mount the isolated overlay, and show the on-page
   * control panel. The session stays Idle until the user clicks an element.
   */
  function start() {
    if (sessionController.getStatus() !== RECORDING_STATUS.IDLE) {
      return;
    }
    if (mountOverlay) {
      const shadow = overlay.mount();
      const doc =
        overlay.document || (typeof document !== "undefined" ? document : null);
      if (doc && shadow) {
        panel = buildControlPanel(doc, shadow, {
          onPause: () => api.pause(),
          onResume: () => api.resume(),
          onStop: () => api.stop(),
        });
      }
    }
    picker.activate();
  }

  const api = {
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
      if (panel) {
        panel.finish();
        const finishedPanel = panel;
        panel = null;
        // Leave the "captured" confirmation up briefly, then tear down the UI.
        setTimeout(() => {
          overlay.unmount();
          if (typeof finishedPanel.destroy === "function") {
            finishedPanel.destroy();
          }
        }, 2500);
      } else {
        overlay.unmount();
      }
      return status;
    },
    getStatus: () => sessionController.getStatus(),
  };

  return api;
}

/**
 * Build the on-page control panel inside the Overlay_UI shadow root so a user
 * can run a full capture (pick → record → stop) without keeping the Popup_UI
 * open — Chromium closes the popup the moment the page is clicked.
 *
 * Renders a small fixed panel with a status line and Pause/Resume/Stop buttons.
 * All styling is inline within the isolated shadow tree, so it neither pollutes
 * nor is affected by the host page.
 *
 * @param {Document} doc
 * @param {ShadowRoot} shadowRoot
 * @param {{ onPause: () => void, onResume: () => void, onStop: () => void }} handlers
 * @returns {{ setStatus: (s: string) => void, setTarget: (d: string) => void, finish: () => void, destroy: () => void }}
 */
function buildControlPanel(doc, shadowRoot, handlers) {
  const wrap = doc.createElement("div");
  wrap.setAttribute(
    "style",
    [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "pointer-events:auto",
      "font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
      "color:#0f172a",
      "background:#ffffff",
      "border:1px solid #e2e8f0",
      "border-radius:10px",
      "box-shadow:0 8px 28px rgba(0,0,0,.20)",
      "padding:12px 14px",
      "min-width:230px",
    ].join(";"),
  );

  const title = doc.createElement("div");
  title.textContent = "UI Motion Grabber";
  title.setAttribute("style", "font-weight:600;margin-bottom:6px");

  const status = doc.createElement("div");
  status.textContent = "Hover and click an element to capture.";
  status.setAttribute("style", "margin-bottom:10px;color:#475569");

  const row = doc.createElement("div");
  row.setAttribute("style", "display:flex;gap:8px");

  const makeButton = (label, bg, fg) => {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute(
      "style",
      `cursor:pointer;border:0;border-radius:6px;padding:6px 12px;font:inherit;background:${bg};color:${fg}`,
    );
    return button;
  };

  const pauseButton = makeButton("Pause", "#e2e8f0", "#0f172a");
  const resumeButton = makeButton("Resume", "#2563eb", "#ffffff");
  const stopButton = makeButton("Stop", "#dc2626", "#ffffff");
  resumeButton.style.display = "none";

  pauseButton.addEventListener("click", () => handlers.onPause && handlers.onPause());
  resumeButton.addEventListener("click", () => handlers.onResume && handlers.onResume());
  stopButton.addEventListener("click", () => handlers.onStop && handlers.onStop());

  row.append(pauseButton, resumeButton, stopButton);
  wrap.append(title, status, row);
  shadowRoot.appendChild(wrap);

  return {
    setStatus(next) {
      if (next === "Recording") {
        status.textContent = "Recording… interact with the element.";
        pauseButton.style.display = "";
        resumeButton.style.display = "none";
      } else if (next === "Paused") {
        status.textContent = "Paused.";
        pauseButton.style.display = "none";
        resumeButton.style.display = "";
      } else if (next === "Stopped") {
        status.textContent = "Captured! Open the popup to view the results.";
      }
    },
    setTarget(description) {
      status.textContent = `Recording ${description} — interact with it, then Stop.`;
    },
    finish() {
      pauseButton.style.display = "none";
      resumeButton.style.display = "none";
      stopButton.textContent = "Done";
      stopButton.disabled = true;
      stopButton.style.opacity = "0.6";
      stopButton.style.cursor = "default";
    },
    destroy() {
      if (typeof wrap.remove === "function") {
        wrap.remove();
      }
    },
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

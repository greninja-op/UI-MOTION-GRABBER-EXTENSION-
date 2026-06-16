/**
 * Popup_UI Message_Channel client.
 *
 * The Popup_UI half of the Message_Channel contract (design.md "Messaging
 * Interface"). It is a read-mostly consumer that:
 *
 *   * SUBSCRIBES to inbound envelopes pushed by the Service_Worker via
 *     `chrome.runtime.sendMessage` — specifically `STATE_MAP`,
 *     `EXPORT_PAYLOAD`, and `FRAME_EXCLUDED` (Req 6.3, 9.2, 7.6). A streaming
 *     `Port` is also opened opportunistically so the worker may stream chunks
 *     down the same channel when available.
 *   * ISSUES one-shot commands to the Service_Worker via
 *     `chrome.runtime.sendMessage` — start / pause / resume / stop / freeze /
 *     export (Req 7.6). Every command uses the shared envelope
 *     `{ type, sessionId, payload }` and the shared `MessageType` constants.
 *
 * The `chrome` surface is injectable and fully guarded: when no extension
 * context is present (e.g. the popup is rendered in a plain browser tab or a
 * test harness), the channel reports `available === false`, command sends are
 * inert no-ops, and subscriptions return no-op unsubscribers. This lets the
 * Popup_UI render gracefully outside an extension.
 *
 * Requirements: 6.3, 7.6.
 */

import {
  MessageType,
  isMessageEnvelope,
  type MessageEnvelope,
} from "../shared";

// ---------------------------------------------------------------------------
// Minimal chrome messaging typings
// ---------------------------------------------------------------------------
//
// `@types/chrome` is intentionally not a dependency of this zero-dependency
// project, so we declare only the narrow slice of the messaging surface the
// Popup_UI consumes. The shapes mirror the MV3 API.

/** A listenable event with add/remove listener methods. */
export interface ChromeEvent<Listener extends (...args: never[]) => unknown> {
  addListener(listener: Listener): void;
  removeListener?(listener: Listener): void;
}

/** The narrow `Port` surface the popup consumes. */
export interface PopupChromePort {
  name?: string;
  onMessage: ChromeEvent<(message: unknown) => void>;
  onDisconnect: ChromeEvent<(port: PopupChromePort) => void>;
  postMessage?(message: unknown): void;
  disconnect?(): void;
}

/** The narrow `chrome.runtime` surface the popup depends on. */
export interface PopupChromeRuntime {
  onMessage: ChromeEvent<
    (
      message: unknown,
      sender: unknown,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void
  >;
  sendMessage(message: unknown): unknown;
  connect?(connectInfo?: { name?: string }): PopupChromePort;
}

/** A minimal tab record (only the `id` is consumed). */
export interface PopupChromeTab {
  id?: number;
}

/** The narrow `chrome.tabs` surface used to reach the active tab's content script. */
export interface PopupChromeTabs {
  query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<PopupChromeTab[]>;
  sendMessage(tabId: number, message: unknown): unknown;
}

/** The narrow `chrome` surface this client depends on. */
export interface PopupChromeApi {
  runtime?: PopupChromeRuntime;
  tabs?: PopupChromeTabs;
}

/** The `:hover` / `:active` pseudo-states the popup can request a freeze for. */
export type FreezePseudoState = "hover" | "active";

/** The default `Port` name used when opening the inbound streaming connection. */
export const POPUP_PORT_NAME = "ui-motion-grabber/popup";

/** A handler for inbound Message_Channel envelopes delivered to the popup. */
export type InboundHandler = (envelope: MessageEnvelope) => void;

/** The Popup_UI Message_Channel client surface. */
export interface PopupMessageChannel {
  /** Whether an extension messaging context is reachable. */
  readonly available: boolean;
  /** The Recording_Session id stamped onto every outgoing envelope. */
  readonly sessionId: string;
  /** Update the session id stamped onto subsequent outgoing envelopes. */
  setSessionId(sessionId: string): void;
  /** Build a `{ type, sessionId, payload }` envelope for the active session. */
  makeEnvelope(type: MessageType, payload?: unknown): MessageEnvelope;
  /** Send a one-shot command to the Service_Worker (Req 7.6). Inert when unavailable. */
  sendCommand(type: MessageType, payload?: unknown): void;
  /** Begin picking/recording — `PICKER_START`. */
  start(payload?: unknown): void;
  /** Pause the active Recording_Session. */
  pause(payload?: unknown): void;
  /** Resume a paused Recording_Session. */
  resume(payload?: unknown): void;
  /** Stop the active Recording_Session — `SESSION_STOP`. */
  stop(payload?: unknown): void;
  /** Request a frozen pseudo-state — `FREEZE_PSEUDO`. */
  freeze(pseudo: FreezePseudoState): void;
  /** Request the Export_Payload as JSON — `EXPORT_PAYLOAD` (Req 6.3). */
  requestExport(payload?: unknown): void;
  /** Subscribe to inbound envelopes. Returns an unsubscribe fn (no-op when unavailable). */
  onInbound(handler: InboundHandler): () => void;
  /** Tear down the streaming Port and drop subscribers. */
  disconnect(): void;
}

/**
 * Recording-lifecycle control discriminators carried in a command payload.
 *
 * The shared `MessageType` enum (the single source of truth, frozen by the
 * shared contract) has no dedicated pause/resume constants, so the popup rides
 * pause/resume on the `PICKER_START` recording-control channel and lets the
 * Session_Controller interpret the `control` discriminator. `start` carries no
 * discriminator (a bare `PICKER_START`).
 */
export type RecordingControl = "pause" | "resume";

/** Options for {@link createPopupMessageChannel}. */
export interface CreatePopupMessageChannelOptions {
  /** Chrome messaging surface. Defaults to ambient `globalThis.chrome`. */
  chrome?: PopupChromeApi;
  /** Initial Recording_Session id stamped onto outgoing envelopes. */
  sessionId?: string;
  /** Name used when opening the inbound streaming `Port`. */
  portName?: string;
}

/** Resolve the ambient `chrome` messaging surface, if present. */
function resolveAmbientChrome(): PopupChromeApi | undefined {
  const chromeGlobal = (globalThis as { chrome?: unknown }).chrome;
  if (
    chromeGlobal &&
    typeof chromeGlobal === "object" &&
    "runtime" in chromeGlobal
  ) {
    return chromeGlobal as PopupChromeApi;
  }
  return undefined;
}

/**
 * Create a Popup_UI Message_Channel client bound to a Recording_Session.
 *
 * @param options - injectable chrome surface, initial session id, port name.
 * @returns a {@link PopupMessageChannel}. When no chrome runtime is reachable
 *   the returned client is fully inert (`available === false`).
 */
export function createPopupMessageChannel(
  options: CreatePopupMessageChannelOptions = {},
): PopupMessageChannel {
  const chromeApi = options.chrome ?? resolveAmbientChrome();
  const runtime = chromeApi?.runtime;
  const available = Boolean(runtime && typeof runtime.sendMessage === "function");
  const portName =
    typeof options.portName === "string" ? options.portName : POPUP_PORT_NAME;

  let currentSessionId =
    typeof options.sessionId === "string" ? options.sessionId : "";

  /** Inbound subscribers fanned out from runtime + port messages. */
  const subscribers = new Set<InboundHandler>();
  /** Whether the shared `runtime.onMessage` listener is installed. */
  let runtimeListenerInstalled = false;
  /** The lazily-opened inbound streaming Port (when supported). */
  let port: PopupChromePort | null = null;

  function makeEnvelope(type: MessageType, payload?: unknown): MessageEnvelope {
    return {
      type,
      sessionId: currentSessionId,
      payload: payload === undefined ? {} : payload,
    };
  }

  function sendCommand(type: MessageType, payload?: unknown): void {
    if (!available || !runtime) {
      return;
    }
    runtime.sendMessage(makeEnvelope(type, payload));
  }

  /**
   * Deliver a command to the Content_Script running in the active tab via
   * `chrome.tabs.sendMessage`. Picker/session lifecycle commands target the page
   * (not the Service_Worker), so they are routed to the active tab. Falls back to
   * `runtime.sendMessage` when the `chrome.tabs` surface is unavailable. Inert
   * when no messaging context is present.
   */
  function sendToActiveTab(type: MessageType, payload?: unknown): void {
    if (!available) {
      return;
    }
    const envelope = makeEnvelope(type, payload);
    const tabs = chromeApi?.tabs;
    if (
      tabs &&
      typeof tabs.query === "function" &&
      typeof tabs.sendMessage === "function"
    ) {
      Promise.resolve(tabs.query({ active: true, currentWindow: true }))
        .then((result) => {
          const tabId = Array.isArray(result) ? result[0]?.id : undefined;
          if (typeof tabId === "number") {
            tabs.sendMessage(tabId, envelope);
          }
        })
        .catch(() => {
          /* active-tab delivery is best-effort */
        });
      return;
    }
    // Fallback: route over the runtime channel.
    if (runtime) {
      runtime.sendMessage(envelope);
    }
  }

  /** Fan a valid inbound envelope out to every subscriber. */
  function fanOut(message: unknown): void {
    if (!isMessageEnvelope(message)) {
      return;
    }
    for (const handler of subscribers) {
      handler(message);
    }
  }

  /** Install the shared `runtime.onMessage` listener exactly once. */
  function ensureRuntimeListener(): void {
    if (runtimeListenerInstalled || !runtime || !runtime.onMessage) {
      return;
    }
    if (typeof runtime.onMessage.addListener !== "function") {
      return;
    }
    runtime.onMessage.addListener((message: unknown) => {
      fanOut(message);
      return undefined;
    });
    runtimeListenerInstalled = true;
  }

  /** Open the inbound streaming `Port` opportunistically (when supported). */
  function ensurePort(): void {
    if (port || !runtime || typeof runtime.connect !== "function") {
      return;
    }
    try {
      port = runtime.connect({ name: portName });
    } catch {
      port = null;
      return;
    }
    if (port.onMessage && typeof port.onMessage.addListener === "function") {
      port.onMessage.addListener((message: unknown) => fanOut(message));
    }
    if (
      port.onDisconnect &&
      typeof port.onDisconnect.addListener === "function"
    ) {
      port.onDisconnect.addListener(() => {
        port = null;
      });
    }
  }

  function onInbound(handler: InboundHandler): () => void {
    if (!available) {
      return () => {};
    }
    ensureRuntimeListener();
    ensurePort();
    subscribers.add(handler);
    return () => {
      subscribers.delete(handler);
    };
  }

  function disconnect(): void {
    if (port && typeof port.disconnect === "function") {
      port.disconnect();
    }
    port = null;
    subscribers.clear();
  }

  return {
    get available() {
      return available;
    },
    get sessionId() {
      return currentSessionId;
    },
    setSessionId(sessionId: string) {
      currentSessionId = sessionId;
    },
    makeEnvelope,
    sendCommand,
    start(payload?: unknown) {
      sendToActiveTab(MessageType.PICKER_START, payload);
    },
    pause(payload?: unknown) {
      sendToActiveTab(MessageType.PICKER_START, {
        control: "pause" satisfies RecordingControl,
        ...(payload && typeof payload === "object" ? payload : {}),
      });
    },
    resume(payload?: unknown) {
      sendToActiveTab(MessageType.PICKER_START, {
        control: "resume" satisfies RecordingControl,
        ...(payload && typeof payload === "object" ? payload : {}),
      });
    },
    stop(payload?: unknown) {
      sendToActiveTab(MessageType.SESSION_STOP, payload);
    },
    freeze(pseudo: FreezePseudoState) {
      sendCommand(MessageType.FREEZE_PSEUDO, { pseudo });
    },
    requestExport(payload?: unknown) {
      sendCommand(MessageType.EXPORT_PAYLOAD, {
        request: true,
        ...(payload && typeof payload === "object" ? payload : {}),
      });
    },
    onInbound,
    disconnect,
  };
}

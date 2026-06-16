// UI Motion Grabber — Message_Channel client (Content_Script)
// Pure Vanilla JavaScript, zero dependencies, unbundled.
//
// The Content_Script's client for the Message_Channel. All cross-context
// traffic between the Content_Script, Service_Worker, and Popup_UI flows over
// this channel (Req 7.6):
//
//   * one-shot COMMANDS  -> `chrome.runtime.sendMessage` (request/response)
//   * streaming CHUNKS   -> a Chrome `Port` from `chrome.runtime.connect`
//     (used to stream the Interaction_Timeline / State_Map in pieces)
//
// Every message uses the shared envelope shape `{ type, sessionId, payload }`
// and the `MessageType` constants. The single source of truth for those lives
// in `src/shared/messages.ts`; because the Content_Script is shipped as pure,
// unbundled Vanilla JS it cannot import the TypeScript module at runtime, so
// the constants and the envelope guard are mirrored here. Keep this in sync
// with `src/shared/messages.ts`.
//
// Design reference: design.md "Messaging Interface (Message_Channel)".
// Requirements: 7.6.

/**
 * The canonical Message_Channel message-type constants. Mirrors
 * `MessageType` in `src/shared/messages.ts` — keep the two in sync.
 * @type {Readonly<Record<string, string>>}
 */
export const MessageType = Object.freeze({
  PICKER_START: "PICKER_START",
  TARGET_LOCKED: "TARGET_LOCKED",
  TIMELINE_CHUNK: "TIMELINE_CHUNK",
  STATE_MAP: "STATE_MAP",
  EXPORT_PAYLOAD: "EXPORT_PAYLOAD",
  FREEZE_PSEUDO: "FREEZE_PSEUDO",
  FRAME_EXCLUDED: "FRAME_EXCLUDED",
  SESSION_STOP: "SESSION_STOP",
});

/**
 * All valid message-type values, used to validate incoming envelopes.
 * @type {readonly string[]}
 */
export const MESSAGE_TYPES = Object.freeze(Object.values(MessageType));

/**
 * The default `Port` name used when opening the streaming connection. Lets the
 * Service_Worker distinguish the Content_Script timeline/state stream from
 * other connections.
 * @type {string}
 */
export const DEFAULT_PORT_NAME = "ui-motion-grabber/stream";

/**
 * Narrowing guard for a Message_Channel envelope. Mirrors `isMessageEnvelope`
 * in `src/shared/messages.ts`.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isMessageEnvelope(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof candidate.type === "string" &&
    MESSAGE_TYPES.includes(candidate.type) &&
    typeof candidate.sessionId === "string" &&
    "payload" in candidate
  );
}

/**
 * Create a Message_Channel client bound to a single Recording_Session.
 *
 * Wraps `chrome.runtime.sendMessage` for one-shot commands and a Chrome `Port`
 * (`chrome.runtime.connect`) for streaming timeline/state chunks. The chrome
 * API is injectable for testability and defaults to the global `chrome`.
 *
 * @param {object} [options]
 * @param {typeof chrome} [options.chrome] - The Chrome extension API surface.
 *   Injectable for testing; defaults to the global `chrome`.
 * @param {string} [options.sessionId] - The Recording_Session id stamped onto
 *   every outgoing envelope's `sessionId` field. Defaults to `""`.
 * @param {string} [options.portName] - The name used when opening the streaming
 *   `Port`. Defaults to {@link DEFAULT_PORT_NAME}.
 * @returns {{
 *   readonly sessionId: string,
 *   readonly port: chrome.runtime.Port | null,
 *   makeEnvelope: (type: string, payload?: unknown) => { type: string, sessionId: string, payload: unknown },
 *   sendCommand: (type: string, payload?: unknown) => Promise<unknown>,
 *   connect: () => chrome.runtime.Port,
 *   streamChunk: (type: string, payload?: unknown) => void,
 *   onCommand: (handler: (envelope: object, sender?: unknown, sendResponse?: Function) => unknown) => (() => void),
 *   onChunk: (handler: (envelope: object, port: chrome.runtime.Port) => void) => (() => void),
 *   disconnect: () => void,
 * }}
 */
export function createMessageChannel(options = {}) {
  const chromeApi =
    options.chrome || (typeof chrome !== "undefined" ? chrome : undefined);
  const sessionId =
    typeof options.sessionId === "string" ? options.sessionId : "";
  const portName =
    typeof options.portName === "string" ? options.portName : DEFAULT_PORT_NAME;

  /** @type {chrome.runtime.Port | null} The lazily-opened streaming Port. */
  let port = null;

  /** Local subscribers for incoming one-shot commands (runtime messages). */
  const commandSubscribers = new Set();
  /** Local subscribers for incoming streaming chunks (Port messages). */
  const chunkSubscribers = new Set();
  /** Whether the shared `chrome.runtime.onMessage` listener is installed. */
  let runtimeListenerInstalled = false;

  /**
   * @returns {chrome.runtime} The `chrome.runtime` namespace.
   * @throws {Error} when the chrome API is unavailable.
   */
  function runtime() {
    if (!chromeApi || !chromeApi.runtime) {
      throw new Error(
        "Message_Channel: chrome.runtime is unavailable in this context",
      );
    }
    return chromeApi.runtime;
  }

  /**
   * Build a Message_Channel envelope stamped with this client's `sessionId`.
   * @param {string} type - one of {@link MessageType}.
   * @param {unknown} [payload] - JSON-serializable body (defaults to `{}`).
   * @returns {{ type: string, sessionId: string, payload: unknown }}
   */
  function makeEnvelope(type, payload) {
    return {
      type,
      sessionId,
      payload: payload === undefined ? {} : payload,
    };
  }

  /**
   * Send a one-shot command over `chrome.runtime.sendMessage` (Req 7.6).
   *
   * Returns the promise from `sendMessage` (MV3 returns a promise when no
   * callback is supplied) so callers can await a response. Errors from a
   * missing chrome API surface synchronously as a rejected promise.
   *
   * @param {string} type - one of {@link MessageType}.
   * @param {unknown} [payload]
   * @returns {Promise<unknown>}
   */
  function sendCommand(type, payload) {
    let runtimeApi;
    try {
      runtimeApi = runtime();
    } catch (error) {
      return Promise.reject(error);
    }
    const result = runtimeApi.sendMessage(makeEnvelope(type, payload));
    // MV3 returns a promise; guard older/callback shapes by normalizing.
    return result && typeof result.then === "function"
      ? result
      : Promise.resolve(result);
  }

  /**
   * Dispatch an incoming Port message to every chunk subscriber, ignoring
   * anything that is not a valid envelope.
   * @param {unknown} message
   */
  function handlePortMessage(message) {
    if (!isMessageEnvelope(message)) {
      return;
    }
    for (const handler of chunkSubscribers) {
      handler(message, port);
    }
  }

  /**
   * Reset Port references when the connection is torn down (by either side).
   */
  function handlePortDisconnect() {
    port = null;
  }

  /**
   * Open (or reuse) the streaming `Port` to the Service_Worker via
   * `chrome.runtime.connect` (Req 7.6). The Port carries streamed
   * timeline/state chunks. Idempotent: repeated calls return the same Port
   * until it is disconnected.
   * @returns {chrome.runtime.Port}
   */
  function connect() {
    if (port) {
      return port;
    }
    port = runtime().connect({ name: portName });
    if (port.onMessage && typeof port.onMessage.addListener === "function") {
      port.onMessage.addListener(handlePortMessage);
    }
    if (
      port.onDisconnect &&
      typeof port.onDisconnect.addListener === "function"
    ) {
      port.onDisconnect.addListener(handlePortDisconnect);
    }
    return port;
  }

  /**
   * Stream a timeline/state chunk over the `Port`, opening the connection on
   * first use (Req 7.6).
   * @param {string} type - one of {@link MessageType}.
   * @param {unknown} [payload]
   */
  function streamChunk(type, payload) {
    const activePort = connect();
    activePort.postMessage(makeEnvelope(type, payload));
  }

  /**
   * Ensure the shared `chrome.runtime.onMessage` listener is installed exactly
   * once. The single listener fans incoming envelopes out to all command
   * subscribers.
   */
  function ensureRuntimeListener() {
    if (runtimeListenerInstalled) {
      return;
    }
    const runtimeApi = runtime();
    if (!runtimeApi.onMessage || typeof runtimeApi.onMessage.addListener !== "function") {
      return;
    }
    runtimeApi.onMessage.addListener(dispatchCommand);
    runtimeListenerInstalled = true;
  }

  /**
   * `chrome.runtime.onMessage` handler: fan a valid envelope out to every
   * command subscriber. If any subscriber returns `true`, the response channel
   * is kept open for an async `sendResponse` (Chrome's contract).
   * @param {unknown} message
   * @param {unknown} [sender]
   * @param {Function} [sendResponse]
   * @returns {boolean | undefined}
   */
  function dispatchCommand(message, sender, sendResponse) {
    if (!isMessageEnvelope(message)) {
      return undefined;
    }
    let keepChannelOpen = false;
    for (const handler of commandSubscribers) {
      if (handler(message, sender, sendResponse) === true) {
        keepChannelOpen = true;
      }
    }
    return keepChannelOpen ? true : undefined;
  }

  /**
   * Subscribe to incoming one-shot commands delivered via
   * `chrome.runtime.onMessage`. Returns an unsubscribe function.
   * @param {(envelope: object, sender?: unknown, sendResponse?: Function) => unknown} handler
   * @returns {() => void}
   */
  function onCommand(handler) {
    ensureRuntimeListener();
    commandSubscribers.add(handler);
    return () => {
      commandSubscribers.delete(handler);
    };
  }

  /**
   * Subscribe to incoming streaming chunks delivered over the `Port`. Opens the
   * connection if it is not already open. Returns an unsubscribe function.
   * @param {(envelope: object, port: chrome.runtime.Port) => void} handler
   * @returns {() => void}
   */
  function onChunk(handler) {
    connect();
    chunkSubscribers.add(handler);
    return () => {
      chunkSubscribers.delete(handler);
    };
  }

  /**
   * Tear down the streaming `Port` and drop chunk subscribers, leaving the
   * channel inert. The one-shot command listener (and its subscribers) is left
   * intact so commands can still be exchanged after a stream closes; callers
   * that subscribed via `onCommand` should call the returned unsubscribe fn.
   */
  function disconnect() {
    if (port) {
      if (
        port.onMessage &&
        typeof port.onMessage.removeListener === "function"
      ) {
        port.onMessage.removeListener(handlePortMessage);
      }
      if (typeof port.disconnect === "function") {
        port.disconnect();
      }
      port = null;
    }
    chunkSubscribers.clear();
  }

  return {
    get sessionId() {
      return sessionId;
    },
    get port() {
      return port;
    },
    makeEnvelope,
    sendCommand,
    connect,
    streamChunk,
    onCommand,
    onChunk,
    disconnect,
  };
}

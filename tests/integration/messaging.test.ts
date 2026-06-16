import { describe, it, expect, vi, beforeEach } from "vitest";

// The Content_Script Message_Channel client is pure, unbundled Vanilla JS, so it
// ships without a .d.ts. Import it with a suppressed type error.
// @ts-expect-error — Content_Script is pure unbundled Vanilla JS (no .d.ts).
import { createMessageChannel, MessageType } from "../../src/content/message-channel.js";

import { installServiceWorker } from "../../src/worker/service-worker.ts";
import type { InteractionTimeline } from "../../src/shared/index.ts";

/**
 * Integration test for Task 12.7 — messaging fabric.
 *
 * Requirements:
 *   7.6 — When runtime contexts exchange data, the System SHALL pass messages
 *         over the Message_Channel using `chrome.runtime.sendMessage` (one-shot
 *         commands) and Chrome `Port` connections (streaming) between the
 *         Content_Script, the Service_Worker, and the Popup_UI.
 *
 * Strategy: build a mock `chrome.runtime` that plumbs two cooperating contexts
 * together — the Content_Script's `createMessageChannel` client and the
 * Service_Worker router from `installServiceWorker`. The mock implements:
 *
 *   * `sendMessage(msg)`  — fans the message out to every `onMessage` listener
 *     (the worker router and any Popup_UI subscriber), modelling one-shot
 *     command delivery.
 *   * `connect({ name })` — creates a linked pair of `Port`s: the content-facing
 *     port is returned to the caller, and the worker-facing port is delivered to
 *     every `onConnect` listener. `postMessage` on one port is delivered to the
 *     peer port's `onMessage` listeners, modelling streaming.
 *
 * The test then asserts that one-shot commands travel via `sendMessage` and that
 * streamed timeline chunks travel via the `Port`, carrying their envelopes
 * intact across the (mocked) context boundary.
 */

// ---------------------------------------------------------------------------
// Mock chrome.runtime with cross-context sendMessage + Port plumbing
// ---------------------------------------------------------------------------

interface MockPort {
  name?: string;
  onMessage: {
    addListener: (fn: (message: unknown) => void) => void;
    removeListener: (fn: (message: unknown) => void) => void;
  };
  onDisconnect: {
    addListener: (fn: (port: MockPort) => void) => void;
    removeListener: (fn: (port: MockPort) => void) => void;
  };
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  // Internal: the listeners registered on THIS port, and a link to its peer.
  _messageListeners: Set<(message: unknown) => void>;
  _disconnectListeners: Set<(port: MockPort) => void>;
  _peer: MockPort | null;
}

function makePort(name?: string): MockPort {
  const messageListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<(port: MockPort) => void>();

  const port: MockPort = {
    name,
    _messageListeners: messageListeners,
    _disconnectListeners: disconnectListeners,
    _peer: null,
    onMessage: {
      addListener: (fn) => messageListeners.add(fn),
      removeListener: (fn) => messageListeners.delete(fn),
    },
    onDisconnect: {
      addListener: (fn) => disconnectListeners.add(fn),
      removeListener: (fn) => disconnectListeners.delete(fn),
    },
    // Deliver to the PEER port's message listeners (cross-context hop).
    postMessage: (message) => {
      const peer = port._peer;
      if (!peer) return;
      for (const listener of [...peer._messageListeners]) {
        listener(message);
      }
    },
    // Notify the PEER's disconnect listeners (the other side observes the drop).
    disconnect: () => {
      const peer = port._peer;
      if (!peer) return;
      for (const listener of [...peer._disconnectListeners]) {
        listener(peer);
      }
    },
  };

  return port;
}

function createMockChrome() {
  const messageListeners = new Set<
    (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => unknown
  >();
  const connectListeners = new Set<(port: MockPort) => void>();

  // Records every connection established, exposing both ends for assertions.
  const connections: { content: MockPort; worker: MockPort }[] = [];

  const sendMessage = vi.fn((message: unknown) => {
    // Fan out to all registered onMessage listeners (worker + popup).
    // Iterate a copy so re-entrant sends (worker replying mid-dispatch) are safe.
    for (const listener of [...messageListeners]) {
      listener(message, { id: "mock-sender" }, () => {});
    }
    return Promise.resolve(undefined);
  });

  const connect = vi.fn((info?: { name?: string }) => {
    const name = info?.name;
    const contentSide = makePort(name);
    const workerSide = makePort(name);
    contentSide._peer = workerSide;
    workerSide._peer = contentSide;
    connections.push({ content: contentSide, worker: workerSide });
    // Hand the worker-facing port to every onConnect listener.
    for (const listener of [...connectListeners]) {
      listener(workerSide);
    }
    return contentSide;
  });

  const chrome = {
    runtime: {
      onMessage: {
        addListener: (fn: (typeof messageListeners) extends Set<infer F> ? F : never) =>
          messageListeners.add(fn),
        removeListener: (fn: (typeof messageListeners) extends Set<infer F> ? F : never) =>
          messageListeners.delete(fn),
      },
      onConnect: {
        addListener: (fn: (port: MockPort) => void) => connectListeners.add(fn),
        removeListener: (fn: (port: MockPort) => void) => connectListeners.delete(fn),
      },
      sendMessage,
      connect,
    },
  };

  return { chrome, sendMessage, connect, connections };
}

// A small, well-formed Interaction_Timeline with monotonically increasing
// timestamps so the State_Diffing_Engine yields N-1 non-negative transitions.
function makeTimeline(): InteractionTimeline {
  return [
    { timestamp: 0, className: "btn", cssText: "", structuralSignature: "btn" },
    {
      timestamp: 120,
      className: "btn hover",
      cssText: "transform: translateY(-2px);",
      structuralSignature: "btn hovertransform: translateY(-2px);",
    },
    {
      timestamp: 300,
      className: "btn active",
      cssText: "transform: translateY(0px);",
      structuralSignature: "btn activetransform: translateY(0px);",
    },
  ];
}

describe("Messaging fabric integration — sendMessage + Port (Req 7.6)", () => {
  let mock: ReturnType<typeof createMockChrome>;

  beforeEach(() => {
    mock = createMockChrome();
  });

  it("streams TIMELINE_CHUNK over a Port and finalizes via a SESSION_STOP command", async () => {
    // Capture the analysis result the worker produces.
    const analyzed = vi.fn();
    installServiceWorker({ chrome: mock.chrome as never, onAnalyzed: analyzed });

    // A Popup_UI subscriber that records messages the worker sends back.
    const popupInbox: { type: string; sessionId: string; payload: unknown }[] = [];
    mock.chrome.runtime.onMessage.addListener((message: unknown) => {
      const m = message as { type: string; sessionId: string; payload: unknown };
      if (m.type === MessageType.STATE_MAP || m.type === MessageType.EXPORT_PAYLOAD) {
        popupInbox.push(m);
      }
    });

    // Content_Script side channel bound to a session.
    const channel = createMessageChannel({ chrome: mock.chrome, sessionId: "session-A" });
    const timeline = makeTimeline();

    // 1. Stream the timeline as a TIMELINE_CHUNK over the Port.
    channel.streamChunk(MessageType.TIMELINE_CHUNK, { timeline });

    // The streaming path must open exactly one Port connection (not sendMessage).
    expect(mock.connect).toHaveBeenCalledTimes(1);
    expect(mock.connections).toHaveLength(1);
    // streamChunk must NOT have used the one-shot command channel.
    expect(mock.sendMessage).not.toHaveBeenCalled();

    // 2. Issue the one-shot SESSION_STOP command via sendMessage.
    await channel.sendCommand(MessageType.SESSION_STOP, {});

    // The command travelled over sendMessage carrying the correct envelope.
    expect(mock.sendMessage).toHaveBeenCalled();
    const stopEnvelope = mock.sendMessage.mock.calls[0][0] as {
      type: string;
      sessionId: string;
      payload: unknown;
    };
    expect(stopEnvelope.type).toBe(MessageType.SESSION_STOP);
    expect(stopEnvelope.sessionId).toBe("session-A");

    // 3. The worker analyzed the streamed timeline (N entries -> N-1 transitions).
    expect(analyzed).toHaveBeenCalledTimes(1);
    const [analyzedSessionId, result] = analyzed.mock.calls[0];
    expect(analyzedSessionId).toBe("session-A");
    expect(result.stateMap.sessionId).toBe("session-A");
    expect(result.stateMap.transitions).toHaveLength(timeline.length - 1);

    // 4. The worker pushed STATE_MAP and EXPORT_PAYLOAD back to the Popup_UI.
    const types = popupInbox.map((m) => m.type);
    expect(types).toContain(MessageType.STATE_MAP);
    expect(types).toContain(MessageType.EXPORT_PAYLOAD);
    for (const m of popupInbox) {
      expect(m.sessionId).toBe("session-A");
    }
    const stateMapMsg = popupInbox.find((m) => m.type === MessageType.STATE_MAP)!;
    expect((stateMapMsg.payload as { transitions: unknown[] }).transitions).toHaveLength(
      timeline.length - 1,
    );
    const exportMsg = popupInbox.find((m) => m.type === MessageType.EXPORT_PAYLOAD)!;
    const exportPayload = exportMsg.payload as {
      codeTabs: { html: string; css: string };
      figmaTokens: unknown[];
      architecturalReport: string;
    };
    expect(typeof exportPayload.codeTabs.html).toBe("string");
    expect(typeof exportPayload.codeTabs.css).toBe("string");
    expect(Array.isArray(exportPayload.figmaTokens)).toBe(true);
    expect(typeof exportPayload.architecturalReport).toBe("string");
  });

  it("delivers Port chunks to the content channel's onChunk subscriber (worker -> content)", () => {
    installServiceWorker({ chrome: mock.chrome as never });

    const channel = createMessageChannel({ chrome: mock.chrome, sessionId: "session-B" });

    const received: { type: string; sessionId: string; payload: unknown }[] = [];
    channel.onChunk((envelope: { type: string; sessionId: string; payload: unknown }) => {
      received.push(envelope);
    });

    // onChunk opens the connection; the worker side is the peer of connection[0].
    expect(mock.connections).toHaveLength(1);
    const workerPort = mock.connections[0].worker;

    // The worker streams a STATE_MAP chunk back down the Port to the content side.
    const envelope = {
      type: MessageType.STATE_MAP,
      sessionId: "session-B",
      payload: { sessionId: "session-B", transitions: [] },
    };
    workerPort.postMessage(envelope);

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe(MessageType.STATE_MAP);
    expect(received[0].sessionId).toBe("session-B");

    // Non-envelope traffic on the Port is ignored by the content channel.
    workerPort.postMessage({ not: "an envelope" });
    expect(received).toHaveLength(1);
  });

  it("keeps multiple Recording_Sessions isolated across the channel", async () => {
    const analyzed = vi.fn();
    installServiceWorker({ chrome: mock.chrome as never, onAnalyzed: analyzed });

    const channelA = createMessageChannel({ chrome: mock.chrome, sessionId: "A" });
    const channelB = createMessageChannel({ chrome: mock.chrome, sessionId: "B" });

    channelA.streamChunk(MessageType.TIMELINE_CHUNK, { timeline: makeTimeline() });
    channelB.streamChunk(MessageType.TIMELINE_CHUNK, {
      timeline: makeTimeline().slice(0, 2),
    });

    await channelA.sendCommand(MessageType.SESSION_STOP, {});
    await channelB.sendCommand(MessageType.SESSION_STOP, {});

    expect(analyzed).toHaveBeenCalledTimes(2);
    const bySession = new Map<string, number>(
      analyzed.mock.calls.map(([sessionId, result]) => [
        sessionId,
        result.stateMap.transitions.length,
      ]),
    );
    // Session A streamed 3 entries -> 2 transitions; B streamed 2 -> 1.
    expect(bySession.get("A")).toBe(2);
    expect(bySession.get("B")).toBe(1);
  });
});

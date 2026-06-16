import { describe, it, expect } from "vitest";
import {
  RECORDING_STATUSES,
  toControlsState,
  type ExportPayload,
  type RecordingStatus,
  type SessionControlsState,
} from "../src/shared/types";
import {
  MessageType,
  MESSAGE_TYPES,
  isMessageEnvelope,
  type MessageEnvelope,
} from "../src/shared/messages";

describe("toControlsState mapping", () => {
  it("maps each canonical status to its view-model state", () => {
    expect(toControlsState("Idle")).toBe("IDLE");
    expect(toControlsState("Recording")).toBe("RECORDING");
    expect(toControlsState("Paused")).toBe("PAUSED");
    expect(toControlsState("Stopped")).toBe("STOPPED");
  });

  it("is total over every canonical Recording_Status", () => {
    for (const status of RECORDING_STATUSES) {
      expect(() => toControlsState(status)).not.toThrow();
    }
  });

  it("is injective and stays within the four canonical controls states", () => {
    const allowed: SessionControlsState[] = [
      "IDLE",
      "RECORDING",
      "PAUSED",
      "STOPPED",
    ];
    const mapped = RECORDING_STATUSES.map(toControlsState);
    // Stays within the canonical set.
    for (const value of mapped) {
      expect(allowed).toContain(value);
    }
    // Distinct statuses map to distinct controls states.
    expect(new Set(mapped).size).toBe(RECORDING_STATUSES.length);
  });
});

describe("Message_Channel envelope", () => {
  it("exposes all expected message-type constants", () => {
    expect(MESSAGE_TYPES).toEqual([
      "PICKER_START",
      "TARGET_LOCKED",
      "TIMELINE_CHUNK",
      "STATE_MAP",
      "EXPORT_PAYLOAD",
      "FREEZE_PSEUDO",
      "FRAME_EXCLUDED",
      "SESSION_STOP",
    ]);
  });

  it("recognizes a well-formed envelope", () => {
    const envelope: MessageEnvelope = {
      type: MessageType.STATE_MAP,
      sessionId: "session-1",
      payload: { transitions: [] },
    };
    expect(isMessageEnvelope(envelope)).toBe(true);
  });

  it("rejects malformed values", () => {
    expect(isMessageEnvelope(null)).toBe(false);
    expect(isMessageEnvelope({ sessionId: "s", payload: {} })).toBe(false);
    expect(
      isMessageEnvelope({ type: "UNKNOWN", sessionId: "s", payload: {} }),
    ).toBe(false);
    expect(
      isMessageEnvelope({ type: MessageType.STATE_MAP, payload: {} }),
    ).toBe(false);
  });
});

describe("ExportPayload JSON serializability", () => {
  it("round-trips through JSON without loss", () => {
    const payload: ExportPayload = {
      codeTabs: { html: "<div></div>", css: ".a{color:red}" },
      figmaTokens: [{ name: "ease/standard", value: "cubic-bezier(0.42,0,0.58,1)" }],
      architecturalReport: "# Report\n\nLayout: Flexbox",
    };
    const roundTripped = JSON.parse(JSON.stringify(payload)) as ExportPayload;
    expect(roundTripped).toEqual(payload);
  });
});

// Compile-time guard: ensure RecordingStatus union and constant list stay aligned.
const _statusCheck: RecordingStatus[] = [...RECORDING_STATUSES];
void _statusCheck;

/**
 * Message_Channel envelope and message-type constants for UI Motion Grabber.
 *
 * All cross-context traffic (Content_Script <-> Service_Worker <-> Popup_UI)
 * uses `chrome.runtime.sendMessage` for one-shot commands and Chrome `Port`
 * connections for streaming the timeline/state (Req 7.6).
 *
 * Design reference: design.md "Messaging Interface (Message_Channel)".
 * Requirements: 7.6.
 *
 * Every envelope payload must remain JSON-serializable (no functions, class
 * instances, `undefined`, or circular references).
 */

/**
 * The canonical message-type constants exchanged over the Message_Channel.
 * Declared `as const` so each value is a string-literal type.
 */
export const MessageType = {
  PICKER_START: "PICKER_START",
  TARGET_LOCKED: "TARGET_LOCKED",
  TIMELINE_CHUNK: "TIMELINE_CHUNK",
  STATE_MAP: "STATE_MAP",
  EXPORT_PAYLOAD: "EXPORT_PAYLOAD",
  FREEZE_PSEUDO: "FREEZE_PSEUDO",
  FRAME_EXCLUDED: "FRAME_EXCLUDED",
  SESSION_STOP: "SESSION_STOP",
} as const;

/** The union of all valid Message_Channel message-type string literals. */
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/** All message-type values as a readonly tuple (useful for validation). */
export const MESSAGE_TYPES: readonly MessageType[] = Object.values(
  MessageType,
) as MessageType[];

/**
 * The Message_Channel envelope. Every message exchanged between runtime
 * contexts conforms to this shape.
 *
 * @typeParam T - the message-type discriminant.
 * @typeParam P - the JSON-serializable payload shape for this message type.
 */
export interface MessageEnvelope<
  T extends MessageType = MessageType,
  P = unknown,
> {
  /** The discriminant identifying how `payload` should be interpreted. */
  type: T;
  /** Correlates the message with a specific Recording_Session. */
  sessionId: string;
  /** The JSON-serializable body of the message. */
  payload: P;
}

/** Narrowing type guard for a value that is a Message_Channel envelope. */
export function isMessageEnvelope(value: unknown): value is MessageEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.type === "string" &&
    (MESSAGE_TYPES as readonly string[]).includes(candidate.type) &&
    typeof candidate.sessionId === "string" &&
    "payload" in candidate
  );
}

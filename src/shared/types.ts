/**
 * Shared data-model definitions for UI Motion Grabber.
 *
 * These shapes are the single source of truth for the data exchanged between
 * the three runtime contexts (Content_Script, Service_Worker, Popup_UI).
 *
 * Design reference: design.md "Data Models".
 * Requirements: 6.1 (Export_Payload structure), 7.6 (Message_Channel data).
 *
 * SERIALIZATION CONTRACT:
 * Every Export_Payload-related shape below is restricted to JSON-serializable
 * values only: primitives (string | number | boolean | null), arrays of those,
 * and plain objects of those. No functions, class instances, `undefined`, or
 * circular references are permitted. This guarantees the JSON round-trip
 * property in Requirement 6.4.
 */

// ---------------------------------------------------------------------------
// Interaction_Timeline
// ---------------------------------------------------------------------------

/**
 * A single time-stamped snapshot of the Target_Element's observed state.
 * Appended by the Mutation_Engine after passing the Frame_Guard and
 * Structural_Signature gates (Req 2.6, 2.7).
 */
export interface TimelineEntry {
  /** `performance.now()` value captured at processing time. */
  timestamp: number;
  /** Snapshot of `Target_Element.className`. */
  className: string;
  /** Snapshot of `Target_Element.style.cssText`. */
  cssText: string;
  /** `className + cssText` — the dedup key (Structural_Signature). */
  structuralSignature: string;
}

/** The time-ordered record of captured state transitions for a Target_Element. */
export type InteractionTimeline = TimelineEntry[];

// ---------------------------------------------------------------------------
// CubicBezier
// ---------------------------------------------------------------------------

/** A normalized easing curve expressed as explicit cubic-bezier coordinates. */
export interface CubicBezier {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// ---------------------------------------------------------------------------
// State_Map
// ---------------------------------------------------------------------------

/**
 * Per-transition metrics computed by the State_Diffing_Engine between two
 * consecutive Interaction_Timeline entries.
 */
export interface Transition {
  fromIndex: number;
  toIndex: number;
  /** Delay offset in ms between consecutive states (Req 3.1). */
  delayOffsetMs: number;
  /** Duration offset in ms between consecutive states (Req 3.1). */
  durationOffsetMs: number;
  /** Normalized easing curve for this transition (Req 3.2). */
  easing: CubicBezier;
  /** Transform matrix when a transform is present, else `null` (Req 3.3). */
  transformMatrix: number[] | null;
}

/** The processed structure produced by the State_Diffing_Engine. */
export interface StateMap {
  sessionId: string;
  transitions: Transition[];
}

// ---------------------------------------------------------------------------
// Animation parsing
// ---------------------------------------------------------------------------

/** A description of an active animation extracted from the Target_Element. */
export interface AnimationDescriptor {
  delivery: "WAAPI" | "CSS transitions";
  properties: string[];
  easing: CubicBezier;
  durationMs: number;
}

/**
 * A computed-style snapshot. `display` is always present; arbitrary additional
 * computed properties are addressable by name.
 */
export interface ComputedStyleSnapshot {
  display: string;
  [property: string]: string;
}

// ---------------------------------------------------------------------------
// Export_Payload (JSON-serializable)
// ---------------------------------------------------------------------------

/** HTML and CSS code tabs presented in the Popup_UI. */
export interface CodeTabs {
  html: string;
  css: string;
}

/**
 * A single Figma design token. Timing tokens carry a
 * `cubic-bezier(x1,y1,x2,y2)` string value (Req 6.2).
 */
export interface FigmaToken {
  name: string;
  value: string;
}

/**
 * The structured JSON data model assembled by the Service_Worker (Req 6.1).
 * Contains only JSON-serializable primitives, arrays, and plain objects so the
 * serialize -> parse round-trip is an identity (Req 6.4).
 */
export interface ExportPayload {
  codeTabs: CodeTabs;
  figmaTokens: FigmaToken[];
  /** Markdown Architectural_Report string. */
  architecturalReport: string;
}

// ---------------------------------------------------------------------------
// Recording_Session
// ---------------------------------------------------------------------------

/**
 * The single canonical lifecycle status enumeration for a Recording_Session,
 * owned by the Session_Controller (Requirement 11). This is the one
 * authoritative source of lifecycle truth.
 */
export type RecordingStatus = "Idle" | "Recording" | "Paused" | "Stopped";

/** All canonical Recording_Status values, in lifecycle order. */
export const RECORDING_STATUSES: readonly RecordingStatus[] = [
  "Idle",
  "Recording",
  "Paused",
  "Stopped",
] as const;

/** A single capture lifecycle for one Target_Element. */
export interface RecordingSession {
  sessionId: string;
  /** Canonical status (Req 11). */
  status: RecordingStatus;
  timeline: InteractionTimeline;
  stateMap: StateMap | null;
}

// ---------------------------------------------------------------------------
// Session_Controls_State (Popup_UI view-model)
// ---------------------------------------------------------------------------

/**
 * The Popup_UI view-model representation of Recording_Status. It mirrors the
 * canonical status one-to-one and introduces no additional or alternative
 * status values; it is NOT a separate source of truth (Req 11.7).
 */
export type SessionControlsState = "IDLE" | "RECORDING" | "PAUSED" | "STOPPED";

/**
 * Total, order-preserving, one-to-one mapping from the canonical
 * `RecordingStatus` to the Popup_UI `SessionControlsState` view-model.
 *
 * The mapping is total (defined for every canonical status), injective
 * (distinct statuses map to distinct controls states), and never escapes the
 * four canonical states (Req 11.7).
 */
export function toControlsState(status: RecordingStatus): SessionControlsState {
  switch (status) {
    case "Idle":
      return "IDLE";
    case "Recording":
      return "RECORDING";
    case "Paused":
      return "PAUSED";
    case "Stopped":
      return "STOPPED";
  }
}

// ---------------------------------------------------------------------------
// User_Feedback_Message (Feedback_Banner)
// ---------------------------------------------------------------------------

/** The severity/category of a User_Feedback_Message (Req 12.3). */
export type UserFeedbackType = "SUCCESS" | "ERROR" | "WARN";

/** A message rendered by the Feedback_Banner (Requirement 12). */
export interface UserFeedbackMessage {
  type: UserFeedbackType;
  text: string;
}

// ---------------------------------------------------------------------------
// Frame exclusion
// ---------------------------------------------------------------------------

/** A report describing a sub-frame excluded from selection (Req 9.2). */
export interface FrameExclusion {
  frameUrl: string;
  reason: "cross-origin" | "inaccessible";
}

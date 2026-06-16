// UI Motion Grabber — Session_Controller (Content_Script subsystem)
// Pure Vanilla JavaScript, zero dependencies, unbundled (native ES module).
//
// Responsibility (design.md "Content_Script Components > Session_Controller",
// Requirement 11):
//   Implement the Recording_Session / Recording_Status state machine and be the
//   single owner of Recording_Status transitions. Coordinate the
//   MutationObserver lifecycle (through the Mutation_Engine) across those
//   transitions, own the Picker lifecycle, and perform finally-style teardown
//   on Stop / picker-end before forwarding the frozen Interaction_Timeline to
//   the Service_Worker.
//
// Requirements covered by this module:
//   1.8  — on picker-end / stop, remove every listener (via Picker.deactivate).
//   10.3 — disconnect the MutationObserver when the Target_Element is released.
//   10.4 — release all page-attached listeners and observer references.
//   11.3 — on Recording -> Paused, disconnect the observer immediately.
//   11.4 — on Paused -> Recording, create a NEW observer bound to the cached
//          Target_Element (delegated to Mutation_Engine.attach).
//   11.5 — while Paused, no entries are appended (the observer is disconnected).
//   11.6 — on -> Stopped: detach, deactivate picker, release refs, forward the
//          frozen Interaction_Timeline to the Service_Worker.
//
// State machine (design.md "Recording_Session Lifecycle"):
//
//   [*] -> Idle
//   Idle      -> Recording : lock(target)   (Mutation_Engine.attach(target))
//   Recording -> Paused    : pause()        (Mutation_Engine.detach())
//   Paused    -> Recording : resume()       (Mutation_Engine.attach(cachedTarget) — NEW observer)
//   Recording -> Stopped   : stop()         (detach + teardown + forward timeline)
//   Paused    -> Stopped   : stop()         (detach + teardown + forward timeline)
//
// The Session_Controller exposes the canonical Recording_Status; the Popup_UI
// derives its Session_Controls_State view-model one-to-one from it (Req 11.7).

/**
 * The canonical Recording_Status values (the single authoritative lifecycle
 * enumeration, Requirement 11). Mirrors the `RecordingStatus` string-literal
 * union in `src/shared/types.ts`; inlined here because the Content_Script is
 * pure, unbundled Vanilla JS and cannot import the TypeScript shared module at
 * runtime.
 * @type {Readonly<{IDLE: "Idle", RECORDING: "Recording", PAUSED: "Paused", STOPPED: "Stopped"}>}
 */
export const RECORDING_STATUS = Object.freeze({
  IDLE: "Idle",
  RECORDING: "Recording",
  PAUSED: "Paused",
  STOPPED: "Stopped",
});

/**
 * Create a Session_Controller that owns the Recording_Status state machine and
 * coordinates the Mutation_Engine + Picker lifecycle.
 *
 * The controller is the single source of lifecycle truth: callers drive it only
 * through `lock`, `pause`, `resume`, and `stop`, and read the canonical status
 * through `getStatus()`.
 *
 * @param {object} options
 * @param {ReturnType<import("./mutation-engine.js").createMutationEngine>} options.mutationEngine
 *   The Mutation_Engine that owns the MutationObserver. `attach(target)` builds
 *   a fresh observer; `detach()` disconnects it (Req 11.3, 11.4, 11.6).
 * @param {{ deactivate: () => void }} [options.picker]
 *   The Picker; `deactivate()` removes every attached host-page listener on
 *   stop / picker-end (Req 1.8, 10.4).
 * @param {string} [options.sessionId]
 *   Identifier correlating this session across the Message_Channel.
 * @param {(timeline: import("../shared/types").InteractionTimeline, sessionId: string) => void} [options.sendTimeline]
 *   Sink invoked with the frozen Interaction_Timeline when the session reaches
 *   Stopped (Req 11.6). Injectable so the controller stays decoupled from the
 *   Message_Channel transport; `content.js` wires this to the channel client.
 * @param {(status: string) => void} [options.onStatusChange]
 *   Optional observer notified after every successful status transition (used
 *   by the Popup_UI bridge to mirror Session_Controls_State, Req 11.7).
 * @returns {{
 *   lock: (target: Element) => string,
 *   pause: () => string,
 *   resume: () => string,
 *   stop: () => string,
 *   getStatus: () => string,
 *   getTarget: () => Element | null,
 *   isActive: () => boolean,
 * }}
 */
export function createSessionController(options = {}) {
  const mutationEngine = options.mutationEngine;
  if (!mutationEngine || typeof mutationEngine.attach !== "function") {
    throw new Error(
      "createSessionController requires a Mutation_Engine with attach/detach",
    );
  }

  const picker = options.picker || null;
  const sessionId = options.sessionId || "";
  const sendTimeline =
    typeof options.sendTimeline === "function" ? options.sendTimeline : null;
  const onStatusChange =
    typeof options.onStatusChange === "function" ? options.onStatusChange : null;

  /** @type {string} The canonical Recording_Status (Req 11). Starts Idle. */
  let status = RECORDING_STATUS.IDLE;

  /**
   * The cached Target_Element. Retained across Paused so `resume()` can bind a
   * fresh observer to the same node (Req 11.4). Released on teardown (Req 10.4).
   * @type {Element | null}
   */
  let cachedTarget = null;

  /**
   * Commit a status transition and notify the observer. Centralized so every
   * transition path emits exactly one change notification.
   * @param {string} next
   * @returns {string} the new status.
   */
  function setStatus(next) {
    status = next;
    if (onStatusChange) {
      onStatusChange(status);
    }
    return status;
  }

  /**
   * Idle -> Recording. Cache the Target_Element and attach a fresh observer to
   * it (Req 11.1, 11.2). No-op (returns the current status) when not Idle so the
   * controller never re-locks over an active or stopped session.
   * @param {Element} target
   * @returns {string} the resulting status.
   */
  function lock(target) {
    if (status !== RECORDING_STATUS.IDLE) {
      return status;
    }
    if (!target) {
      throw new Error("Session_Controller.lock requires a Target_Element");
    }
    cachedTarget = target;
    mutationEngine.attach(target);
    return setStatus(RECORDING_STATUS.RECORDING);
  }

  /**
   * Recording -> Paused. Disconnect the observer IMMEDIATELY so the paused
   * session imposes zero observation/processor overhead on the host page
   * (Req 11.3); while Paused no entries are appended because no observer is
   * connected (Req 11.5). The cached Target_Element is retained for resume.
   * No-op when not Recording.
   * @returns {string} the resulting status.
   */
  function pause() {
    if (status !== RECORDING_STATUS.RECORDING) {
      return status;
    }
    mutationEngine.detach();
    return setStatus(RECORDING_STATUS.PAUSED);
  }

  /**
   * Paused -> Recording. Construct a BRAND-NEW MutationObserver bound to the
   * cached Target_Element (Req 11.4) — it does not re-enable a retained
   * observer. No-op when not Paused.
   * @returns {string} the resulting status.
   */
  function resume() {
    if (status !== RECORDING_STATUS.PAUSED) {
      return status;
    }
    // Mutation_Engine.attach always constructs a fresh observer instance.
    mutationEngine.attach(cachedTarget);
    return setStatus(RECORDING_STATUS.RECORDING);
  }

  /**
   * Recording|Paused -> Stopped. Finally-style teardown: disconnect the
   * observer, deactivate the Picker (removing every host-page listener), and
   * release all observer/listener references (Req 1.8, 10.3, 10.4, 11.6). The
   * frozen Interaction_Timeline is captured before references are dropped and
   * forwarded to the Service_Worker afterwards. Idempotent once Stopped.
   * @returns {string} the resulting status.
   */
  function stop() {
    if (status === RECORDING_STATUS.STOPPED) {
      return status;
    }

    // Capture (freeze) the timeline BEFORE teardown so the forwarded record is
    // immutable and unaffected by any later activity.
    const frozenTimeline = freezeTimeline(mutationEngine.timeline);

    try {
      // Disconnect the observer and drop its references (Req 10.3, 11.6).
      mutationEngine.detach();
      // Remove every listener the Picker attached to the host page (Req 1.8, 10.4).
      if (picker && typeof picker.deactivate === "function") {
        picker.deactivate();
      }
    } finally {
      // Release the cached Target_Element reference no matter what (Req 10.4).
      cachedTarget = null;
      setStatus(RECORDING_STATUS.STOPPED);
    }

    // Forward the frozen Interaction_Timeline to the Service_Worker (Req 11.6).
    if (sendTimeline) {
      sendTimeline(frozenTimeline, sessionId);
    }

    return status;
  }

  /**
   * @returns {string} the canonical Recording_Status.
   */
  function getStatus() {
    return status;
  }

  /**
   * @returns {Element | null} the cached Target_Element, or `null` when none /
   *   after teardown.
   */
  function getTarget() {
    return cachedTarget;
  }

  /**
   * @returns {boolean} whether the session is actively capturing (Recording).
   */
  function isActive() {
    return status === RECORDING_STATUS.RECORDING;
  }

  return { lock, pause, resume, stop, getStatus, getTarget, isActive };
}

/**
 * Produce a frozen, defensively-copied snapshot of an Interaction_Timeline so
 * the forwarded record cannot be mutated after the session stops.
 *
 * @param {import("../shared/types").InteractionTimeline | undefined} timeline
 * @returns {ReadonlyArray<Readonly<import("../shared/types").TimelineEntry>>}
 */
function freezeTimeline(timeline) {
  if (!Array.isArray(timeline)) {
    return Object.freeze([]);
  }
  return Object.freeze(timeline.map((entry) => Object.freeze({ ...entry })));
}

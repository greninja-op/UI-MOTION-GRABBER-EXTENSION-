// UI Motion Grabber — Picker (Content_Script subsystem)
// Pure Vanilla JavaScript, zero dependencies, unbundled.
//
// Responsibility (design.md "Content_Script Components > Picker"):
//   Manage Picker_Mode. Register `mouseover`, `mouseout`, and `click` listeners
//   with `{ capture: true }`, tracking each in a teardown registry for
//   guaranteed removal. On hover, drive the Highlighter (apply to the current
//   element, remove from the previous). On click, freeze host-site navigation
//   with `stopPropagation()` + `preventDefault()` and lock the clicked element
//   as the Target_Element.
//
// Requirements:
//   1.4 — register mouse event listeners in the capture phase with `capture: true`.
//   1.5 — on click, call `stopPropagation()` and `preventDefault()` to prevent
//         host-site link/navigation traversal.
//   1.6 — on click, set that element as the Target_Element.
//   1.8 — when Picker_Mode ends, remove every event listener it attached.
//
// Element resolution under the pointer (recursive Shadow_Root descent, Req 1.7)
// lives in a sibling module owned by a parallel task; we import it here and
// reference it rather than re-implementing it.
import { resolveElement } from "./shadow-resolver.js";
import { createHighlighter } from "./highlighter.js";

/**
 * The capture-phase listener options used for every Picker listener.
 * `capture: true` satisfies Requirement 1.4; the object is frozen and reused so
 * the exact same options reference is passed to both `addEventListener` and
 * `removeEventListener` (required for reliable removal on some engines).
 * @type {AddEventListenerOptions}
 */
export const CAPTURE_OPTIONS = Object.freeze({ capture: true });

/**
 * The DOM events the Picker intercepts in Picker_Mode.
 * @type {readonly ["mouseover", "mouseout", "click"]}
 */
export const PICKER_EVENTS = Object.freeze(["mouseover", "mouseout", "click"]);

/**
 * Creates a Picker that manages Picker_Mode lifecycle.
 *
 * @param {object} [options]
 * @param {EventTarget} [options.root] - The event target the listeners are
 *   attached to (defaults to the global `document`). Injectable for testing.
 * @param {ReturnType<typeof createHighlighter>} [options.highlighter] - The
 *   Highlighter driving hover visuals (defaults to a fresh instance).
 * @param {(element: Element) => void} [options.onTargetLocked] - Callback
 *   invoked with the locked Target_Element when the user clicks (Req 1.6). The
 *   Session_Controller wires this to its `lock(target)` transition.
 * @param {(x: number, y: number) => (Element | null)} [options.resolve] -
 *   Pointer-to-element resolver (defaults to the recursive Shadow_Root resolver
 *   from `./shadow-resolver.js`, Req 1.7). Injectable for testing.
 * @returns {{
 *   activate: () => void,
 *   deactivate: () => void,
 *   onHover: (element: Element | null | undefined) => void,
 *   onClick: (event: Event) => void,
 *   isActive: () => boolean,
 *   getTarget: () => Element | null,
 * }}
 */
export function createPicker(options = {}) {
  const root =
    options.root || (typeof document !== "undefined" ? document : null);
  const highlighter = options.highlighter || createHighlighter();
  const onTargetLocked =
    typeof options.onTargetLocked === "function" ? options.onTargetLocked : null;
  const resolve =
    typeof options.resolve === "function" ? options.resolve : resolveElement;

  /**
   * Teardown registry of every listener the Picker has attached. Each entry
   * records the exact `target`, `type`, `handler`, and `options` used at
   * registration so `deactivate()` can remove all of them (Req 1.8).
   * @type {Array<{ target: EventTarget, type: string, handler: EventListener, options: AddEventListenerOptions }>}
   */
  const listenerRegistry = [];

  /** @type {boolean} Whether Picker_Mode is currently active. */
  let active = false;

  /** @type {Element | null} The locked Target_Element, if any (Req 1.6). */
  let targetElement = null;

  /**
   * Register a listener and track it in the teardown registry so it is
   * guaranteed to be removed on `deactivate()` (Req 1.8). All Picker listeners
   * are registered in the capture phase (Req 1.4).
   * @param {string} type
   * @param {EventListener} handler
   */
  function addTrackedListener(type, handler) {
    if (!root || typeof root.addEventListener !== "function") {
      return;
    }
    root.addEventListener(type, handler, CAPTURE_OPTIONS);
    listenerRegistry.push({
      target: root,
      type,
      handler,
      options: CAPTURE_OPTIONS,
    });
  }

  /**
   * Resolve the element under the pointer for a pointer event, descending
   * through open Shadow_Root instances (Req 1.7). Falls back to the event's
   * `target` when client coordinates are unavailable (e.g., synthetic events).
   * @param {Event} event
   * @returns {Element | null}
   */
  function resolveFromEvent(event) {
    const x = typeof event.clientX === "number" ? event.clientX : NaN;
    const y = typeof event.clientY === "number" ? event.clientY : NaN;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const resolved = resolve(x, y);
      if (resolved) {
        return resolved;
      }
    }
    return event.target instanceof Element ? event.target : null;
  }

  /**
   * Hover handler: move the Highlight_Class onto `element`, removing it from the
   * previously highlighted element (Req 1.1, 1.2 — delivered via the Highlighter
   * which never touches inline styles, Req 1.3).
   * @param {Element | null | undefined} element
   */
  function onHover(element) {
    highlighter.highlight(element || null);
  }

  /**
   * `mouseover` capture handler: resolve the element under the pointer and drive
   * the Highlighter.
   * @param {Event} event
   */
  function handleMouseOver(event) {
    onHover(resolveFromEvent(event));
  }

  /**
   * `mouseout` capture handler: clear the current highlight as the pointer
   * leaves an element (Req 1.2).
   */
  function handleMouseOut() {
    highlighter.clear();
  }

  /**
   * Click handler: freeze host-site navigation and lock the Target_Element.
   *
   * Calls `stopPropagation()` and `preventDefault()` so the host page never sees
   * the click and no link/navigation traversal occurs (Req 1.5), then resolves
   * the clicked element (Shadow_Root aware, Req 1.7) and locks it as the
   * Target_Element (Req 1.6).
   * @param {Event} event
   */
  function onClick(event) {
    if (typeof event.stopPropagation === "function") {
      event.stopPropagation();
    }
    if (typeof event.preventDefault === "function") {
      event.preventDefault();
    }

    const element = resolveFromEvent(event);
    if (!element) {
      return;
    }

    targetElement = element;
    highlighter.clear();
    if (onTargetLocked) {
      onTargetLocked(element);
    }
  }

  /**
   * Activate Picker_Mode: register the capture-phase `mouseover`, `mouseout`,
   * and `click` listeners (Req 1.4). Idempotent — repeated calls while active do
   * not double-register.
   */
  function activate() {
    if (active) {
      return;
    }
    active = true;
    addTrackedListener("mouseover", handleMouseOver);
    addTrackedListener("mouseout", handleMouseOut);
    addTrackedListener("click", onClick);
  }

  /**
   * Deactivate Picker_Mode: remove EVERY listener the Picker attached to the
   * host page and clear any lingering highlight (Req 1.8). Idempotent — safe to
   * call when already inactive and safe to call multiple times.
   */
  function deactivate() {
    while (listenerRegistry.length > 0) {
      const { target, type, handler, options: opts } = listenerRegistry.pop();
      if (target && typeof target.removeEventListener === "function") {
        target.removeEventListener(type, handler, opts);
      }
    }
    highlighter.clear();
    active = false;
  }

  /**
   * @returns {boolean} Whether Picker_Mode is currently active.
   */
  function isActive() {
    return active;
  }

  /**
   * @returns {Element | null} The currently locked Target_Element, if any.
   */
  function getTarget() {
    return targetElement;
  }

  return { activate, deactivate, onHover, onClick, isActive, getTarget };
}

// UI Motion Grabber — Mutation_Engine (Content_Script)
// Pure Vanilla JavaScript, zero dependencies, unbundled.
//
// Owns the MutationObserver lifecycle and the two dedup gates that protect the
// host page from runaway recomputation (steering "MUTATION OBSERVER GUARD
// MATRIX"). Records Target_Element state transitions over time into an
// Interaction_Timeline.
//
// Design reference: design.md "Content_Script Components > Mutation_Engine".
// Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 10.3.
//
// Public surface (matches design.md):
//   attach(target): void   // construct a FRESH observer bound only to target
//   handle(records): void  // Frame_Guard -> Structural_Signature -> append
//   detach(): void         // disconnect observer and drop the reference

/**
 * The Frame_Guard debounce window, in milliseconds. Mutations arriving less
 * than this many ms after the previously processed mutation are dropped to
 * prevent infinite rendering cycles / tab freezes (Req 2.4, steering rule 3).
 * @type {number}
 */
export const FRAME_GUARD_MS = 16;

/**
 * The MutationObserver configuration. The `attributeFilter` is strictly
 * restricted to `class` and `style` so analytics/text updates are ignored
 * (Req 2.3, steering rule 2).
 * @type {MutationObserverInit}
 */
export const OBSERVER_CONFIG = Object.freeze({
  attributes: true,
  attributeFilter: ["class", "style"],
});

/**
 * Compute the Structural_Signature for an element: the combination of its
 * `className` and inline `style.cssText` (Req 2.5, 2.6, steering rule 4).
 *
 * `className` is coerced with `String(...)` to remain a plain string even for
 * SVG elements (where it would otherwise be an `SVGAnimatedString`).
 *
 * @param {Element} element
 * @returns {string}
 */
export function structuralSignature(element) {
  const className = String(element.className);
  const cssText = element.style ? element.style.cssText : "";
  return className + cssText;
}

/**
 * Create a Mutation_Engine instance.
 *
 * The engine owns a single MutationObserver at a time. Each `attach(target)`
 * constructs a brand-new observer; `detach()` disconnects it and drops the
 * reference, leaving the engine inert (Req 10.3). The Session_Controller drives
 * these calls across the Recording_Session lifecycle.
 *
 * @param {object} [options]
 * @param {import("../shared/types").InteractionTimeline} [options.timeline]
 *   Optional externally-owned timeline array to append to. When omitted, the
 *   engine owns a fresh timeline. Exposed via the `timeline` getter.
 * @param {() => number} [options.now]
 *   Optional time source (defaults to `performance.now`). Used by the
 *   Frame_Guard and timeline timestamps; injectable for deterministic tests.
 * @param {new (callback: MutationCallback) => MutationObserver} [options.ObserverCtor]
 *   Optional MutationObserver constructor (defaults to the global). Injectable
 *   for environments/tests that provide a custom observer.
 */
export function createMutationEngine(options = {}) {
  const timeline = options.timeline || [];
  const now =
    options.now || (() => performance.now());
  const ObserverCtor =
    options.ObserverCtor ||
    (typeof MutationObserver !== "undefined" ? MutationObserver : undefined);

  /** @type {MutationObserver | null} */
  let observer = null;
  /** @type {Element | null} */
  let target = null;
  /** Cached Structural_Signature for dedup (Req 2.5). `null` until first append. */
  let cachedSignature = null;
  /** Timestamp of the previously processed (appended) mutation (Req 2.4). */
  let lastProcessed = Number.NEGATIVE_INFINITY;

  /**
   * Bind a fresh MutationObserver to the Target_Element node.
   *
   * Always constructs a NEW observer (Req 11.4) bound ONLY to the supplied
   * Target_Element node — never `document` or `body` (Req 2.1, 2.2). The
   * observer is configured with the strict `class`/`style` attribute filter
   * (Req 2.3). Any previously attached observer is disconnected first.
   *
   * Each attach resets the dedup/debounce state so the engine starts clean for
   * the (re)bound target.
   *
   * @param {Element} nextTarget
   * @returns {MutationObserver}
   */
  function attach(nextTarget) {
    if (!nextTarget) {
      throw new Error("Mutation_Engine.attach requires a Target_Element node");
    }
    if (typeof ObserverCtor !== "function") {
      throw new Error("Mutation_Engine: no MutationObserver constructor available");
    }

    // Drop any prior observer before binding a fresh one.
    detach();

    target = nextTarget;
    cachedSignature = null;
    lastProcessed = Number.NEGATIVE_INFINITY;

    observer = new ObserverCtor((records) => handle(records));
    observer.observe(target, OBSERVER_CONFIG);
    return observer;
  }

  /**
   * Process a batch of MutationRecords through the gate pipeline.
   *
   * Gate order (design.md):
   *   1. Frame_Guard      — drop if < FRAME_GUARD_MS since last processed (Req 2.4)
   *   2. Structural_Sig.  — drop if signature equals the cached signature (Req 2.5)
   *   3. Append           — update cache/timestamp, push a timeline entry (Req 2.6, 2.7)
   *
   * The whole batch is treated as a single state-transition event, using one
   * `now()` reading for both the Frame_Guard comparison and the entry timestamp.
   *
   * @param {MutationRecord[]} [_records] Unused; the engine reads live state
   *   from the Target_Element so it always captures the latest signature.
   * @returns {boolean} `true` when an entry was appended, `false` when dropped.
   */
  function handle(_records) {
    if (!target) {
      return false;
    }

    // Gate 1: Frame_Guard (Req 2.4).
    const timestamp = now();
    if (timestamp - lastProcessed < FRAME_GUARD_MS) {
      return false;
    }

    // Gate 2: Structural_Signature dedup (Req 2.5).
    const signature = structuralSignature(target);
    if (signature === cachedSignature) {
      return false;
    }

    // Gate 3: update cache + timestamp, then append (Req 2.6, 2.7).
    cachedSignature = signature;
    lastProcessed = timestamp;
    timeline.push({
      timestamp,
      className: String(target.className),
      cssText: target.style ? target.style.cssText : "",
      structuralSignature: signature,
    });
    return true;
  }

  /**
   * Disconnect the MutationObserver and drop all references to it and the
   * Target_Element, leaving the engine inert (Req 10.3, 11.3, 11.6).
   */
  function detach() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    target = null;
  }

  return {
    attach,
    handle,
    detach,
    /** The Interaction_Timeline this engine appends to. */
    get timeline() {
      return timeline;
    },
    /** The currently bound MutationObserver, or `null` when detached. */
    get observer() {
      return observer;
    },
    /** The currently bound Target_Element node, or `null` when detached. */
    get target() {
      return target;
    },
    /** The cached Structural_Signature, or `null` before the first append. */
    get cachedSignature() {
      return cachedSignature;
    },
  };
}

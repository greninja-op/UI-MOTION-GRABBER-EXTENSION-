// UI Motion Grabber — Overlay_UI Host (Content_Script)
// Pure Vanilla JavaScript, zero dependencies, unbundled (native ES module).
//
// Implements Requirement 8 (Overlay UI Style Isolation) and Requirement 10.2
// (rAF-scheduled interpolation):
//   - 8.1: render the Overlay_UI inside an open Shadow_Root container.
//   - 8.2: apply an `all: initial` reset to the Overlay_UI container.
//   - 8.3: render with its own styles even against host `!important` rules.
//   - 10.2: schedule interpolated layer shifts via `requestAnimationFrame`
//           so the host page sustains a 60fps paint rate.
//
// Design reference: design.md → "Overlay_UI Host". The container element gets
// an open shadow root and a root stylesheet whose first declaration is
// `all: initial`. If shadow attachment fails for the primary container, we fall
// back to a fresh top-level container with its own shadow root.

/**
 * Stable id used for the overlay container element so teardown / re-mount can
 * find and remove any prior instance.
 */
export const OVERLAY_CONTAINER_ID = "ui-motion-grabber-overlay-host";

/**
 * The CSS reset declaration that MUST lead the root stylesheet (Req 8.2).
 * Kept as a named export so tests and callers can assert against the exact
 * value rather than a magic string.
 */
export const ROOT_STYLE_RESET = "all: initial";

/**
 * Build the root stylesheet text injected into the overlay's Shadow_Root.
 *
 * The very first declaration is `all: initial` (Req 8.2). Because the overlay
 * lives in its own shadow tree, this reset — combined with shadow encapsulation
 * — guarantees the overlay computes to its own styles even when the host page
 * declares conflicting `!important` rules (Req 8.3).
 *
 * @returns {string} CSS text whose leading declaration is `all: initial`.
 */
export function buildRootStyleText() {
  // `:host` targets the shadow host (the overlay container). `all: initial`
  // is the leading declaration so the reset is applied before any other rule.
  return [
    ":host {",
    `  ${ROOT_STYLE_RESET};`,
    "  position: fixed;",
    "  top: 0;",
    "  left: 0;",
    "  width: 0;",
    "  height: 0;",
    "  z-index: 2147483647;",
    "  pointer-events: none;",
    "}",
  ].join("\n");
}

/**
 * Resolve the rAF/cAF/now functions, allowing injection for testability while
 * defaulting to the live browser globals (Req 10.2).
 *
 * @param {object} [options]
 * @returns {{ raf: Function, caf: Function, now: Function }}
 */
function resolveScheduler(options = {}) {
  const raf =
    options.requestAnimationFrame ||
    (typeof requestAnimationFrame === "function"
      ? requestAnimationFrame.bind(globalThis)
      : (cb) => setTimeout(() => cb(nowMs()), 16));
  const caf =
    options.cancelAnimationFrame ||
    (typeof cancelAnimationFrame === "function"
      ? cancelAnimationFrame.bind(globalThis)
      : (handle) => clearTimeout(handle));
  const now = options.now || nowMs;
  return { raf, caf, now };
}

function nowMs() {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}

/**
 * Overlay_UI Host.
 *
 * Owns an isolated Shadow DOM container for the injected overlay and an
 * rAF-driven interpolation loop for layer shifts. Construction is side-effect
 * free; call {@link OverlayUIHost#mount} to attach to the document.
 */
export class OverlayUIHost {
  /**
   * @param {object} [options]
   * @param {Document} [options.document] - Document to attach to (defaults to global `document`).
   * @param {Element} [options.parent] - Preferred parent for the container (defaults to `document.body`).
   * @param {Function} [options.requestAnimationFrame] - Injectable rAF.
   * @param {Function} [options.cancelAnimationFrame] - Injectable cAF.
   * @param {Function} [options.now] - Injectable high-resolution clock.
   */
  constructor(options = {}) {
    this.document =
      options.document || (typeof document !== "undefined" ? document : null);
    this.preferredParent = options.parent || null;

    const scheduler = resolveScheduler(options);
    this._raf = scheduler.raf;
    this._caf = scheduler.caf;
    this._now = scheduler.now;

    /** @type {HTMLElement | null} */
    this.container = null;
    /** @type {ShadowRoot | null} */
    this.shadowRoot = null;
    /** @type {HTMLStyleElement | null} */
    this.styleElement = null;
    /** Whether mount used the fresh top-level fallback container. */
    this.usedFallback = false;

    // Active rAF handle for the interpolation loop (null when idle).
    this._frameHandle = null;
  }

  /**
   * Create the container, attach an open Shadow_Root, and inject the root
   * stylesheet (Req 8.1, 8.2).
   *
   * If shadow attachment to the primary container fails, fall back to a fresh
   * top-level container with its own shadow root.
   *
   * @returns {ShadowRoot} the attached open shadow root.
   */
  mount() {
    if (!this.document) {
      throw new Error("OverlayUIHost.mount requires a document");
    }
    if (this.shadowRoot) {
      return this.shadowRoot;
    }

    try {
      const parent =
        this.preferredParent || this.document.body || this.document.documentElement;
      const container = this._createContainer();
      parent.appendChild(container);
      this.shadowRoot = this._attachShadow(container);
      this.container = container;
      this.usedFallback = false;
    } catch (_primaryError) {
      // Fallback: a fresh top-level container with its own shadow root.
      this.shadowRoot = this._mountFallback();
      this.usedFallback = true;
    }

    this._injectRootStylesheet(this.shadowRoot);
    return this.shadowRoot;
  }

  /**
   * Mount a brand-new container at the document root and attach its own shadow
   * root. Used when the primary mount path fails.
   *
   * @returns {ShadowRoot}
   */
  _mountFallback() {
    // Drop any partially-attached primary container before retrying.
    if (this.container && typeof this.container.remove === "function") {
      this.container.remove();
    }
    this.container = null;

    const container = this._createContainer();
    const root = this.document.documentElement || this.document.body;
    if (!root) {
      throw new Error("OverlayUIHost fallback requires a document root");
    }
    root.appendChild(container);
    const shadow = this._attachShadow(container);
    this.container = container;
    return shadow;
  }

  /**
   * @returns {HTMLElement} a fresh, isolated container element.
   */
  _createContainer() {
    const container = this.document.createElement("div");
    container.id = OVERLAY_CONTAINER_ID;
    // The container itself carries no host-page styling hooks; all visuals live
    // inside the shadow tree. Mark it non-interactive so it never intercepts
    // host-page pointer events outside of explicitly interactive overlay layers.
    container.setAttribute("data-ui-motion-grabber", "overlay");
    return container;
  }

  /**
   * Attach an OPEN shadow root to the given container (Req 8.1).
   *
   * @param {HTMLElement} container
   * @returns {ShadowRoot}
   */
  _attachShadow(container) {
    if (!container || typeof container.attachShadow !== "function") {
      throw new Error("Element does not support attachShadow");
    }
    const shadow = container.attachShadow({ mode: "open" });
    if (!shadow) {
      throw new Error("attachShadow returned no ShadowRoot");
    }
    return shadow;
  }

  /**
   * Inject the root stylesheet whose leading declaration is `all: initial`
   * (Req 8.2). Idempotent: re-injecting replaces the existing style element.
   *
   * @param {ShadowRoot} shadowRoot
   */
  _injectRootStylesheet(shadowRoot) {
    const style = this.document.createElement("style");
    style.textContent = buildRootStyleText();
    // Insert as the first child so the reset applies before any later rules.
    shadowRoot.insertBefore(style, shadowRoot.firstChild);
    this.styleElement = style;
  }

  /**
   * Schedule an interpolated layer shift via `requestAnimationFrame` (Req 10.2).
   *
   * Interpolates a scalar from `from` to `to` over `durationMs`, invoking
   * `onFrame(value, progress)` on each animation frame. Using rAF (rather than
   * timers) lets the browser align updates to the compositor so the host page
   * can sustain a 60fps paint rate.
   *
   * @param {object} shift
   * @param {number} shift.from - Starting scalar value.
   * @param {number} shift.to - Target scalar value.
   * @param {number} shift.durationMs - Duration in milliseconds (<= 0 snaps to `to`).
   * @param {(value: number, progress: number) => void} shift.onFrame - Per-frame callback.
   * @param {() => void} [shift.onComplete] - Invoked once interpolation reaches `to`.
   * @returns {() => void} a cancel function for this shift.
   */
  scheduleLayerShift({ from, to, durationMs, onFrame, onComplete }) {
    if (typeof onFrame !== "function") {
      throw new Error("scheduleLayerShift requires an onFrame callback");
    }

    // Cancel any in-flight interpolation so a new shift takes over cleanly.
    this.cancelLayerShift();

    const start = this._now();
    const total = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;

    const step = (frameTime) => {
      // rAF passes a timestamp; fall back to the injected clock if absent.
      const current = typeof frameTime === "number" ? frameTime : this._now();
      const elapsed = current - start;
      const progress = total <= 0 ? 1 : Math.min(1, Math.max(0, elapsed / total));
      const value = from + (to - from) * progress;

      onFrame(value, progress);

      if (progress < 1) {
        this._frameHandle = this._raf(step);
      } else {
        this._frameHandle = null;
        if (typeof onComplete === "function") {
          onComplete();
        }
      }
    };

    this._frameHandle = this._raf(step);
    return () => this.cancelLayerShift();
  }

  /**
   * Cancel any in-flight rAF-scheduled layer shift.
   */
  cancelLayerShift() {
    if (this._frameHandle != null) {
      this._caf(this._frameHandle);
      this._frameHandle = null;
    }
  }

  /**
   * Tear down the overlay: cancel pending frames, drop the shadow tree, and
   * remove the container from the document. Safe to call multiple times.
   */
  unmount() {
    this.cancelLayerShift();
    if (this.container && typeof this.container.remove === "function") {
      this.container.remove();
    }
    this.container = null;
    this.shadowRoot = null;
    this.styleElement = null;
    this.usedFallback = false;
  }
}

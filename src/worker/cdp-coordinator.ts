/**
 * CDP Coordinator (Service_Worker component).
 *
 * On a freeze request, attaches the Chrome DevTools Protocol debugger to the
 * active tab and issues `DOM.forcePseudoState` to freeze the Target_Element in
 * the requested `:hover` or `:active` pseudo-state. While the element is
 * frozen, computed metrics can be extracted even when the pointer is not over
 * the element (Req 4.5) — the freeze is driven by the protocol, not by real
 * pointer position.
 *
 * Design reference: design.md "Service_Worker Components -> CDP Coordinator"
 * and "Error Handling -> Service_Worker -> CDP attach/command failure".
 * Requirements:
 *   - 4.4: issue a CDP `DOM.forcePseudoState` command to freeze the
 *          Target_Element in the requested `:hover`/`:active` pseudo-state.
 *   - 4.5: while frozen, extract computed style metrics even when the pointer
 *          is not over the Target_Element.
 *
 * Error handling (Req 12.4): if `debugger` attach or `DOM.forcePseudoState`
 * fails (tab navigated, target detached, permission denied), this coordinator
 * NEVER throws. It resolves with an `ok: false` result carrying an ERROR
 * `User_Feedback_Message` for the Feedback_Banner, and analysis continues using
 * the live (non-frozen) computed styles via the same extractor.
 */

import type { UserFeedbackMessage } from "../shared/index.ts";

// ---------------------------------------------------------------------------
// Minimal chrome.debugger typings
// ---------------------------------------------------------------------------
//
// `@types/chrome` is intentionally not a dependency of this zero-dependency
// project, so we declare the narrow slice of the `chrome.debugger` surface this
// coordinator consumes. The shapes mirror the MV3 promise-based API.

/** A CDP debuggee target. We always address the active tab by `tabId`. */
export interface Debuggee {
  tabId?: number;
  extensionId?: string;
  targetId?: string;
}

/**
 * The narrow `chrome.debugger` surface this coordinator depends on. Injectable
 * so the coordinator can be exercised against a mock in tests.
 */
export interface DebuggerApi {
  attach(target: Debuggee, requiredVersion: string): Promise<void>;
  detach(target: Debuggee): Promise<void>;
  sendCommand(
    target: Debuggee,
    method: string,
    commandParams?: Record<string, unknown>,
  ): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Public request/result types
// ---------------------------------------------------------------------------

/** The pseudo-classes that may be frozen (Req 4.4). */
export type FrozenPseudoClass = "hover" | "active";

/** A freeze request targeting one element in the active tab. */
export interface FreezeRequest {
  /** The active tab to attach the debugger to. */
  tabId: number;
  /**
   * The pseudo-state to force. Accepts the bare class (`"hover"`/`"active"`)
   * or the colon-prefixed selector form (`":hover"`/`":active"`).
   */
  pseudoClass: FrozenPseudoClass | ":hover" | ":active";
  /**
   * A CSS selector resolving the Target_Element within the tab's document.
   * Used when an explicit `nodeId` is not supplied.
   */
  selector?: string;
  /** An explicit CDP `nodeId` for the Target_Element, if already resolved. */
  nodeId?: number;
}

/**
 * The metrics extractor. Invoked with `frozen: true` once the pseudo-state has
 * been forced (Req 4.5), or with `frozen: false` on the live-styles fallback
 * path when attach/command failed. May be sync or async and is the only place
 * the actual computed-style read happens, keeping this coordinator agnostic to
 * the metric shape.
 */
export type MetricsExtractor<T> = (context: {
  frozen: boolean;
}) => T | Promise<T>;

/** Successful freeze: the pseudo-state was forced and metrics were extracted. */
export interface FreezeSuccess<T> {
  ok: true;
  frozen: true;
  metrics: T;
}

/**
 * Failed freeze: attach or a CDP command failed. Carries an ERROR feedback
 * message for the Popup_UI (Req 12.4) and the live (non-frozen) metrics so the
 * caller can continue analysis with live styles.
 */
export interface FreezeFailure<T> {
  ok: false;
  frozen: false;
  metrics: T;
  error: UserFeedbackMessage;
}

/** The outcome of a freeze-and-extract pass. */
export type FreezeResult<T> = FreezeSuccess<T> | FreezeFailure<T>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The CDP protocol version requested on attach. */
const CDP_PROTOCOL_VERSION = "1.3";

/** Normalize a request pseudo value to the bare CDP forced-pseudo-class token. */
function normalizePseudoClass(
  value: FreezeRequest["pseudoClass"],
): FrozenPseudoClass {
  return value === ":hover" || value === "hover" ? "hover" : "active";
}

/** Extract a human-readable message from an unknown thrown value. */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  // chrome.* APIs surface `{ message }` objects on failure paths.
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return "Unknown CDP failure";
}

/** Resolve the `chrome.debugger` API from the ambient global, if present. */
function resolveAmbientDebugger(): DebuggerApi | undefined {
  const chromeGlobal = (
    globalThis as {
      chrome?: { debugger?: DebuggerApi };
    }
  ).chrome;
  return chromeGlobal?.debugger;
}

// ---------------------------------------------------------------------------
// CDP Coordinator
// ---------------------------------------------------------------------------

/**
 * Coordinates CDP-driven pseudo-state freezing for the Service_Worker. The
 * Service_Worker is the sole holder of the `debugger` attachment (design.md
 * "Module Boundaries").
 */
export class CdpCoordinator {
  private readonly debuggerApi: DebuggerApi | undefined;

  /**
   * @param debuggerApi - the `chrome.debugger` surface. Defaults to the ambient
   *   `globalThis.chrome.debugger`; inject a mock in tests.
   */
  constructor(debuggerApi: DebuggerApi | undefined = resolveAmbientDebugger()) {
    this.debuggerApi = debuggerApi;
  }

  /**
   * Freeze the Target_Element in the requested pseudo-state and extract metrics
   * while frozen (Req 4.4, 4.5).
   *
   * This method NEVER throws. On any attach/command failure it returns an
   * `ok: false` result with an ERROR `User_Feedback_Message` (Req 12.4) and
   * invokes `extract({ frozen: false })` so the caller continues with live
   * (non-frozen) computed styles.
   *
   * @param request - the tab, pseudo-class, and element identity to freeze.
   * @param extract - reads the metrics; called with `frozen: true` while the
   *   pseudo-state is forced, or `frozen: false` on the fallback path.
   */
  async freezeAndExtract<T>(
    request: FreezeRequest,
    extract: MetricsExtractor<T>,
  ): Promise<FreezeResult<T>> {
    const debuggerApi = this.debuggerApi;

    if (!debuggerApi) {
      return this.fail(
        extract,
        "CDP debugger API is unavailable; using live styles.",
      );
    }

    const target: Debuggee = { tabId: request.tabId };
    const pseudoClass = normalizePseudoClass(request.pseudoClass);
    let attached = false;

    try {
      await debuggerApi.attach(target, CDP_PROTOCOL_VERSION);
      attached = true;

      const nodeId = await this.resolveNodeId(debuggerApi, target, request);

      // Issue DOM.forcePseudoState to freeze the element (Req 4.4).
      await debuggerApi.sendCommand(target, "DOM.forcePseudoState", {
        nodeId,
        forcedPseudoClasses: [pseudoClass],
      });

      // While frozen, extract computed metrics even though the pointer is not
      // over the element (Req 4.5).
      const metrics = await extract({ frozen: true });

      return { ok: true, frozen: true, metrics };
    } catch (error) {
      return this.fail(
        extract,
        `CDP ${pseudoClass} freeze failed: ${describeError(error)}`,
      );
    } finally {
      if (attached) {
        await this.cleanup(debuggerApi, target);
      }
    }
  }

  /**
   * Resolve the CDP `nodeId` for the Target_Element. Prefers an explicit
   * `nodeId`; otherwise resolves a CSS `selector` against the document root.
   */
  private async resolveNodeId(
    debuggerApi: DebuggerApi,
    target: Debuggee,
    request: FreezeRequest,
  ): Promise<number> {
    if (typeof request.nodeId === "number") {
      return request.nodeId;
    }

    if (!request.selector) {
      throw new Error(
        "Freeze request requires either a nodeId or a selector to resolve the Target_Element.",
      );
    }

    // DOM domain must be enabled before the node tree can be queried.
    await debuggerApi.sendCommand(target, "DOM.enable");

    const document = (await debuggerApi.sendCommand(
      target,
      "DOM.getDocument",
      { depth: 0 },
    )) as { root?: { nodeId?: number } } | null;

    const rootNodeId = document?.root?.nodeId;
    if (typeof rootNodeId !== "number") {
      throw new Error("DOM.getDocument did not return a document root node.");
    }

    const queried = (await debuggerApi.sendCommand(target, "DOM.querySelector", {
      nodeId: rootNodeId,
      selector: request.selector,
    })) as { nodeId?: number } | null;

    const nodeId = queried?.nodeId;
    if (typeof nodeId !== "number" || nodeId === 0) {
      throw new Error(
        `DOM.querySelector resolved no element for selector "${request.selector}".`,
      );
    }

    return nodeId;
  }

  /**
   * Release any forced pseudo-state and detach the debugger. Best-effort:
   * cleanup failures are swallowed so they never mask the primary result.
   */
  private async cleanup(
    debuggerApi: DebuggerApi,
    target: Debuggee,
  ): Promise<void> {
    try {
      await debuggerApi.detach(target);
    } catch {
      // Detaching can fail if the tab already closed/navigated; ignore.
    }
  }

  /**
   * Build a failure result: surface an ERROR feedback message (Req 12.4) and
   * fall back to live (non-frozen) metrics extraction.
   */
  private async fail<T>(
    extract: MetricsExtractor<T>,
    text: string,
  ): Promise<FreezeFailure<T>> {
    const metrics = await extract({ frozen: false });
    return {
      ok: false,
      frozen: false,
      metrics,
      error: { type: "ERROR", text },
    };
  }
}

/**
 * Convenience factory mirroring the ambient-default constructor. Useful for the
 * Service_Worker entry point where a single shared coordinator suffices.
 */
export function createCdpCoordinator(
  debuggerApi?: DebuggerApi,
): CdpCoordinator {
  return new CdpCoordinator(debuggerApi);
}

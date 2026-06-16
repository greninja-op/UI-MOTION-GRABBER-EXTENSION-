import { describe, it, expect, vi, afterEach } from "vitest";

import {
  parseComputed,
  parseAnimations,
} from "../../src/worker/animation-parser.ts";
import {
  CdpCoordinator,
  createCdpCoordinator,
  type DebuggerApi,
  type Debuggee,
} from "../../src/worker/cdp-coordinator.ts";

// ---------------------------------------------------------------------------
// Animation_Parser: computed-style + active-animation extraction
// (Req 4.1, 4.2)
// ---------------------------------------------------------------------------

/**
 * Build a minimal CSSStyleDeclaration-like object exposing only the surface
 * `parseComputed` consumes: `display`, `length`, `item(i)`, and
 * `getPropertyValue(name)`.
 */
function makeDeclaration(
  props: Record<string, string>,
): CSSStyleDeclaration {
  const names = Object.keys(props);
  const declaration = {
    display: props.display ?? "block",
    length: names.length,
    item: (index: number): string => names[index] ?? "",
    getPropertyValue: (name: string): string => props[name] ?? "",
  };
  return declaration as unknown as CSSStyleDeclaration;
}

describe("Animation_Parser computed-style extraction (Req 4.1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("consumes window.getComputedStyle on the Target_Element", () => {
    const target = document.createElement("div");
    const declaration = makeDeclaration({
      display: "flex",
      "transition-duration": "0.3s",
    });

    const spy = vi
      .spyOn(window, "getComputedStyle")
      .mockReturnValue(declaration);

    const snapshot = parseComputed(target);

    // getComputedStyle was consumed, with the Target_Element as its argument.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(target);

    // Every enumerable computed property is mapped into the snapshot.
    expect(snapshot.display).toBe("flex");
    expect(snapshot["transition-duration"]).toBe("0.3s");
  });

  it("maps all enumerable computed properties by name", () => {
    const target = document.createElement("span");
    const declaration = makeDeclaration({
      display: "grid",
      opacity: "0.5",
      transform: "matrix(1, 0, 0, 1, 0, 0)",
    });
    vi.spyOn(window, "getComputedStyle").mockReturnValue(declaration);

    const snapshot = parseComputed(target);

    expect(snapshot).toMatchObject({
      display: "grid",
      opacity: "0.5",
      transform: "matrix(1, 0, 0, 1, 0, 0)",
    });
  });
});

describe("Animation_Parser active-animation extraction (Req 4.2)", () => {
  /**
   * Build a fake `Animation` whose effect mirrors the slice `parseAnimations`
   * reads: `getTiming()` (easing + duration) and `getKeyframes()` (properties).
   */
  function makeAnimation(options: {
    easing: string;
    duration: number;
    keyframes: Array<Record<string, unknown>>;
  }): Animation {
    const effect = {
      getTiming: () => ({
        easing: options.easing,
        duration: options.duration,
      }),
      getKeyframes: () => options.keyframes,
    };
    return { effect } as unknown as Animation;
  }

  it("consumes Target_Element.getAnimations() and maps descriptors", () => {
    const target = document.createElement("div");
    const animation = makeAnimation({
      easing: "ease-in-out",
      duration: 250,
      keyframes: [
        { offset: 0, easing: "linear", transform: "none" },
        { offset: 1, transform: "scale(1.2)", opacity: 0.8 },
      ],
    });

    const getAnimations = vi.fn(() => [animation]);
    (target as unknown as { getAnimations: () => Animation[] }).getAnimations =
      getAnimations;

    const descriptors = parseAnimations(target);

    // getAnimations() was consumed.
    expect(getAnimations).toHaveBeenCalledTimes(1);

    expect(descriptors).toHaveLength(1);
    const [descriptor] = descriptors;

    // Easing keyword normalized to explicit cubic-bezier (Req 4.3 conversion).
    expect(descriptor.easing).toEqual({ x1: 0.42, y1: 0, x2: 0.58, y2: 1 });
    expect(descriptor.durationMs).toBe(250);
    // Property names (not timing/composition keys) are extracted.
    expect(descriptor.properties).toEqual(
      expect.arrayContaining(["transform", "opacity"]),
    );
    expect(descriptor.properties).not.toContain("offset");
    expect(descriptor.properties).not.toContain("easing");
    // Programmatic (Element.animate) animations are classified as WAAPI.
    expect(descriptor.delivery).toBe("WAAPI");
  });

  it("returns an empty array when the target exposes no getAnimations", () => {
    const target = document.createElement("div");
    // No getAnimations on the bare jsdom element.
    expect(parseAnimations(target)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CDP Coordinator: pseudo-state freezing + frozen extraction
// (Req 4.4, 4.5) and failure fallback (Req 12.4)
// ---------------------------------------------------------------------------

interface SentCommand {
  method: string;
  params?: Record<string, unknown>;
}

/**
 * A mock `chrome.debugger` surface. Records attach/detach/sendCommand calls and
 * serves canned `DOM.getDocument`/`DOM.querySelector` responses so the
 * coordinator can resolve a nodeId by selector.
 */
function makeMockDebugger(
  overrides: Partial<{
    failOnAttach: boolean;
    failOnForce: boolean;
    rootNodeId: number;
    resolvedNodeId: number;
  }> = {},
): {
  api: DebuggerApi;
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  sendCommand: ReturnType<typeof vi.fn>;
  commands: SentCommand[];
} {
  const {
    failOnAttach = false,
    failOnForce = false,
    rootNodeId = 1,
    resolvedNodeId = 42,
  } = overrides;

  const commands: SentCommand[] = [];

  const attach = vi.fn(async (_target: Debuggee, _version: string) => {
    if (failOnAttach) {
      throw new Error("Cannot attach to the target tab.");
    }
  });

  const detach = vi.fn(async (_target: Debuggee) => {});

  const sendCommand = vi.fn(
    async (
      _target: Debuggee,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown> => {
      commands.push({ method, params });

      if (method === "DOM.getDocument") {
        return { root: { nodeId: rootNodeId } };
      }
      if (method === "DOM.querySelector") {
        return { nodeId: resolvedNodeId };
      }
      if (method === "DOM.forcePseudoState" && failOnForce) {
        throw new Error("forcePseudoState rejected: node detached.");
      }
      return {};
    },
  );

  const api: DebuggerApi = { attach, detach, sendCommand };
  return { api, attach, detach, sendCommand, commands };
}

describe("CdpCoordinator pseudo-state freezing (Req 4.4, 4.5)", () => {
  it("attaches and issues DOM.forcePseudoState for :hover, extracting while frozen", async () => {
    const mock = makeMockDebugger();
    const coordinator = new CdpCoordinator(mock.api);

    // Track the frozen flag the extractor receives — proves metrics are read
    // while frozen, independent of real pointer hover.
    const extract = vi.fn((ctx: { frozen: boolean }) => ({
      frozen: ctx.frozen,
      width: "120px",
    }));

    const result = await coordinator.freezeAndExtract(
      { tabId: 7, pseudoClass: ":hover", selector: ".btn" },
      extract,
    );

    // Debugger attached to the active tab.
    expect(mock.attach).toHaveBeenCalledTimes(1);
    expect(mock.attach).toHaveBeenCalledWith({ tabId: 7 }, "1.3");

    // DOM.forcePseudoState issued with the hover pseudo-class (Req 4.4).
    const force = mock.commands.find(
      (c) => c.method === "DOM.forcePseudoState",
    );
    expect(force).toBeDefined();
    expect(force?.params?.forcedPseudoClasses).toEqual(["hover"]);
    expect(force?.params?.nodeId).toBe(42);

    // Metrics extracted WHILE frozen (Req 4.5) — extractor saw frozen: true.
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledWith({ frozen: true });

    expect(result.ok).toBe(true);
    expect(result.frozen).toBe(true);
    expect(result.metrics).toEqual({ frozen: true, width: "120px" });
  });

  it("issues DOM.forcePseudoState for :active when requested", async () => {
    const mock = makeMockDebugger();
    const coordinator = createCdpCoordinator(mock.api);

    const result = await coordinator.freezeAndExtract(
      { tabId: 3, pseudoClass: "active", nodeId: 99 },
      () => ({ ok: true }),
    );

    const force = mock.commands.find(
      (c) => c.method === "DOM.forcePseudoState",
    );
    expect(force?.params?.forcedPseudoClasses).toEqual(["active"]);
    // Explicit nodeId is used directly without a selector lookup.
    expect(force?.params?.nodeId).toBe(99);
    expect(
      mock.commands.some((c) => c.method === "DOM.querySelector"),
    ).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("reads metrics while frozen without any real pointer hover (Req 4.5)", async () => {
    const mock = makeMockDebugger();
    const coordinator = new CdpCoordinator(mock.api);

    // The extractor records ordering: it must run AFTER forcePseudoState and
    // never depends on a pointer event.
    let forcedBeforeExtract = false;
    const extract = vi.fn((ctx: { frozen: boolean }) => {
      forcedBeforeExtract = mock.commands.some(
        (c) => c.method === "DOM.forcePseudoState",
      );
      return { frozen: ctx.frozen };
    });

    await coordinator.freezeAndExtract(
      { tabId: 1, pseudoClass: ":hover", nodeId: 5 },
      extract,
    );

    expect(forcedBeforeExtract).toBe(true);
    expect(extract).toHaveBeenCalledWith({ frozen: true });
  });
});

describe("CdpCoordinator failure fallback (Req 12.4)", () => {
  it("returns an ERROR feedback message and extracts with frozen: false on attach failure", async () => {
    const mock = makeMockDebugger({ failOnAttach: true });
    const coordinator = new CdpCoordinator(mock.api);

    const extract = vi.fn((ctx: { frozen: boolean }) => ({
      frozen: ctx.frozen,
    }));

    const result = await coordinator.freezeAndExtract(
      { tabId: 2, pseudoClass: ":hover", nodeId: 5 },
      extract,
    );

    // Never forced a pseudo-state since attach failed.
    expect(
      mock.commands.some((c) => c.method === "DOM.forcePseudoState"),
    ).toBe(false);

    // Falls back to live (non-frozen) extraction.
    expect(extract).toHaveBeenCalledWith({ frozen: false });

    expect(result.ok).toBe(false);
    expect(result.frozen).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("ERROR");
      expect(result.error.text).toMatch(/freeze failed/i);
    }
  });

  it("falls back with frozen: false when DOM.forcePseudoState fails", async () => {
    const mock = makeMockDebugger({ failOnForce: true });
    const coordinator = new CdpCoordinator(mock.api);

    const extract = vi.fn((ctx: { frozen: boolean }) => ({
      frozen: ctx.frozen,
    }));

    const result = await coordinator.freezeAndExtract(
      { tabId: 8, pseudoClass: "active", nodeId: 5 },
      extract,
    );

    // The command was attempted but rejected.
    expect(
      mock.commands.some((c) => c.method === "DOM.forcePseudoState"),
    ).toBe(true);
    // After a command failure the debugger is detached (best-effort cleanup).
    expect(mock.detach).toHaveBeenCalledTimes(1);

    expect(extract).toHaveBeenCalledWith({ frozen: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("ERROR");
    }
  });

  it("never throws and reports ERROR when no debugger API is available", async () => {
    const coordinator = new CdpCoordinator(undefined);
    const extract = vi.fn((ctx: { frozen: boolean }) => ({
      frozen: ctx.frozen,
    }));

    const result = await coordinator.freezeAndExtract(
      { tabId: 1, pseudoClass: ":hover", nodeId: 5 },
      extract,
    );

    expect(extract).toHaveBeenCalledWith({ frozen: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("ERROR");
    }
  });
});

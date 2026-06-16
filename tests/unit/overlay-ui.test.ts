import { describe, it, expect, beforeEach, vi } from "vitest";
// @ts-expect-error — Content_Script is pure unbundled Vanilla JS (no .d.ts).
import {
  OverlayUIHost,
  OVERLAY_CONTAINER_ID,
  ROOT_STYLE_RESET,
  buildRootStyleText,
  // @ts-expect-error — see above.
} from "../../src/content/overlay-ui.js";

describe("OverlayUIHost — overlay setup (Req 8.1, 8.2)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.querySelectorAll(`#${OVERLAY_CONTAINER_ID}`).forEach((n) => n.remove());
  });

  it("mount() attaches an OPEN shadow root to the container (Req 8.1)", () => {
    const host = new OverlayUIHost({ document });
    const shadow = host.mount();

    expect(shadow).toBeTruthy();
    expect(shadow).toBe(host.shadowRoot);
    // jsdom exposes the open shadow root via the element's shadowRoot getter.
    expect(host.container).toBeTruthy();
    expect(host.container.id).toBe(OVERLAY_CONTAINER_ID);
    expect(host.container.shadowRoot).toBe(shadow);
    // An open shadow root is reachable from the element.
    expect(host.container.shadowRoot).not.toBeNull();
    // The container is attached to the document.
    expect(document.getElementById(OVERLAY_CONTAINER_ID)).toBe(host.container);
  });

  it("injects a root stylesheet whose leading declaration is `all: initial` (Req 8.2)", () => {
    const host = new OverlayUIHost({ document });
    const shadow = host.mount();

    const style = shadow.querySelector("style");
    expect(style).toBeTruthy();
    expect(host.styleElement).toBe(style);

    // The reset must be present and must lead the rule block.
    const text = style!.textContent ?? "";
    expect(text).toContain(`${ROOT_STYLE_RESET};`);

    // The first CSS *declaration* (after the `:host {` selector line) is the reset.
    const firstDeclaration = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.endsWith("{") && line !== "}")[0];
    expect(firstDeclaration).toBe(`${ROOT_STYLE_RESET};`);
  });

  it("buildRootStyleText() begins with the `all: initial` reset declaration (Req 8.2)", () => {
    const firstDeclaration = buildRootStyleText()
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0 && !line.endsWith("{") && line !== "}")[0];
    expect(firstDeclaration).toBe(`${ROOT_STYLE_RESET};`);
  });

  it("the style element is inserted as the first child of the shadow root (Req 8.2)", () => {
    const host = new OverlayUIHost({ document });
    const shadow = host.mount();
    expect(shadow.firstChild).toBe(host.styleElement);
  });
});

describe("OverlayUIHost — rAF-scheduled interpolation (Req 10.2)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("scheduleLayerShift() schedules interpolation through the injected requestAnimationFrame", () => {
    const raf = vi.fn();
    const caf = vi.fn();
    const host = new OverlayUIHost({
      document,
      requestAnimationFrame: raf,
      cancelAnimationFrame: caf,
      now: () => 0,
    });

    const onFrame = vi.fn();
    host.scheduleLayerShift({ from: 0, to: 100, durationMs: 100, onFrame });

    // Interpolation is scheduled via rAF, not synchronously or via timers.
    expect(raf).toHaveBeenCalledTimes(1);
    expect(typeof raf.mock.calls[0][0]).toBe("function");
    // No frame callback has fired yet because rAF was only scheduled, not run.
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("drives interpolation across frames by re-scheduling through requestAnimationFrame", () => {
    let clock = 0;
    const raf = vi.fn();
    const host = new OverlayUIHost({
      document,
      requestAnimationFrame: raf,
      cancelAnimationFrame: vi.fn(),
      now: () => clock,
    });

    const onFrame = vi.fn();
    const onComplete = vi.fn();
    host.scheduleLayerShift({ from: 0, to: 100, durationMs: 100, onFrame, onComplete });

    // Manually pump the frames the host registered through rAF.
    // Frame 1 at t=0 → progress 0.
    raf.mock.calls[0][0](0);
    expect(onFrame).toHaveBeenLastCalledWith(0, 0);
    // A follow-up frame was scheduled through rAF because progress < 1.
    expect(raf).toHaveBeenCalledTimes(2);

    // Frame 2 at t=50 → progress 0.5, value 50.
    raf.mock.calls[1][0](50);
    expect(onFrame).toHaveBeenLastCalledWith(50, 0.5);
    expect(raf).toHaveBeenCalledTimes(3);

    // Final frame at t=100 → progress 1, value 100, completion fires, no more rAF.
    raf.mock.calls[2][0](100);
    expect(onFrame).toHaveBeenLastCalledWith(100, 1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(raf).toHaveBeenCalledTimes(3);
  });

  it("cancelLayerShift() cancels the pending frame through the injected cancelAnimationFrame", () => {
    const raf = vi.fn().mockReturnValue(42);
    const caf = vi.fn();
    const host = new OverlayUIHost({
      document,
      requestAnimationFrame: raf,
      cancelAnimationFrame: caf,
      now: () => 0,
    });

    host.scheduleLayerShift({ from: 0, to: 1, durationMs: 100, onFrame: vi.fn() });
    host.cancelLayerShift();

    expect(caf).toHaveBeenCalledWith(42);
  });

  it("scheduleLayerShift() throws when no onFrame callback is provided", () => {
    const host = new OverlayUIHost({
      document,
      requestAnimationFrame: vi.fn(),
      cancelAnimationFrame: vi.fn(),
      now: () => 0,
    });
    expect(() =>
      // @ts-expect-error — intentionally omitting onFrame to assert the guard.
      host.scheduleLayerShift({ from: 0, to: 1, durationMs: 100 }),
    ).toThrow();
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
// @ts-expect-error — Content_Script is pure unbundled Vanilla JS (no .d.ts).
import {
  createPicker,
  CAPTURE_OPTIONS,
  PICKER_EVENTS,
} from "../../src/content/picker.js";

/**
 * Unit tests for Task 3.8 — capture-phase registration and click freezing.
 *
 * Requirements:
 *   1.4 — Picker registers its mouse event listeners in the capture phase
 *         (`{ capture: true }`).
 *   1.5 — On click, the Picker calls `stopPropagation()` and `preventDefault()`
 *         to freeze host-site link/navigation traversal.
 */
describe("Picker — capture-phase listener registration (Req 1.4)", () => {
  /** A minimal fake root whose `addEventListener` is spied. */
  let root: { addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    root = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });

  it("registers every Picker event with { capture: true } on activate()", () => {
    const picker = createPicker({ root });

    picker.activate();

    // One registration per Picker event (mouseover, mouseout, click).
    expect(root.addEventListener).toHaveBeenCalledTimes(PICKER_EVENTS.length);

    // Each registration uses capture-phase options.
    for (const call of root.addEventListener.mock.calls) {
      const [type, handler, options] = call;
      expect(PICKER_EVENTS).toContain(type);
      expect(typeof handler).toBe("function");
      expect(options).toEqual({ capture: true });
    }
  });

  it("registers the canonical mouseover/mouseout/click capture listeners", () => {
    const picker = createPicker({ root });

    picker.activate();

    const registeredTypes = root.addEventListener.mock.calls.map((c) => c[0]);
    expect(registeredTypes).toEqual(
      expect.arrayContaining(["mouseover", "mouseout", "click"]),
    );

    // The exact frozen CAPTURE_OPTIONS reference is reused for reliable removal.
    for (const call of root.addEventListener.mock.calls) {
      expect(call[2]).toBe(CAPTURE_OPTIONS);
    }
    expect(CAPTURE_OPTIONS).toEqual({ capture: true });
  });

  it("does not double-register listeners when activate() is called twice", () => {
    const picker = createPicker({ root });

    picker.activate();
    picker.activate();

    expect(root.addEventListener).toHaveBeenCalledTimes(PICKER_EVENTS.length);
  });
});

describe("Picker — click freezing (Req 1.5)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("calls stopPropagation() and preventDefault() on click via onClick()", () => {
    const picker = createPicker({ root: document, resolve: () => null });

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    const stopSpy = vi.spyOn(event, "stopPropagation");
    const preventSpy = vi.spyOn(event, "preventDefault");

    picker.onClick(event);

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(preventSpy).toHaveBeenCalledTimes(1);
  });

  it("freezes a real dispatched click while Picker_Mode is active", () => {
    const picker = createPicker({ root: document, resolve: () => null });
    picker.activate();

    const target = document.createElement("a");
    document.body.appendChild(target);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    const stopSpy = vi.spyOn(event, "stopPropagation");
    const preventSpy = vi.spyOn(event, "preventDefault");

    target.dispatchEvent(event);

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(preventSpy).toHaveBeenCalledTimes(1);
    // A cancelable event that had preventDefault() called is marked defaulted-prevented.
    expect(event.defaultPrevented).toBe(true);
  });

  it("locks the clicked element as the Target_Element on click (Req 1.6 corollary)", () => {
    const target = document.createElement("button");
    document.body.appendChild(target);

    const onTargetLocked = vi.fn();
    const picker = createPicker({
      root: document,
      resolve: () => target,
      onTargetLocked,
    });

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    picker.onClick(event);

    expect(picker.getTarget()).toBe(target);
    expect(onTargetLocked).toHaveBeenCalledWith(target);
  });
});

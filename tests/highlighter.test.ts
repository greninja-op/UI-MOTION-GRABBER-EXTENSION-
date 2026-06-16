import { describe, it, expect, beforeEach } from "vitest";
// @ts-expect-error — Content_Script is pure unbundled Vanilla JS (no .d.ts).
import { createHighlighter, HIGHLIGHT_CLASS } from "../src/content/highlighter.js";

describe("Highlighter", () => {
  let el: HTMLElement;
  let other: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    el = document.createElement("div");
    other = document.createElement("section");
    document.body.append(el, other);
  });

  it("exposes the canonical Highlight_Class", () => {
    expect(HIGHLIGHT_CLASS).toBe("ui-motion-grabber-target-hover");
  });

  it("apply() adds the Highlight_Class via classList (Req 1.1)", () => {
    const h = createHighlighter();
    h.apply(el);
    expect(el.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
  });

  it("remove() removes the Highlight_Class via classList (Req 1.2)", () => {
    const h = createHighlighter();
    h.apply(el);
    h.remove(el);
    expect(el.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });

  it("apply/remove round-trip restores the original classList (Req 1.1, 1.2)", () => {
    el.className = "host-existing other-class";
    const before = el.className;
    const h = createHighlighter();
    h.apply(el);
    h.remove(el);
    expect(el.className).toBe(before);
  });

  it("never reads or writes the inline style attribute (Req 1.3)", () => {
    el.setAttribute("style", "color: red; transform: scale(2);");
    const before = el.getAttribute("style");
    const beforeCssText = el.style.cssText;
    const h = createHighlighter();
    h.apply(el);
    h.remove(el);
    expect(el.getAttribute("style")).toBe(before);
    expect(el.style.cssText).toBe(beforeCssText);
    expect(el.hasAttribute("class")).toBe(true);
  });

  it("highlight() moves the class from the previous element to the new one", () => {
    const h = createHighlighter();
    h.highlight(el);
    expect(el.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    expect(h.current()).toBe(el);

    h.highlight(other);
    expect(el.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
    expect(other.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    expect(h.current()).toBe(other);
  });

  it("highlight() with the same element is idempotent", () => {
    const h = createHighlighter();
    h.highlight(el);
    h.highlight(el);
    expect(el.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    // Only one instance of the class is ever present.
    expect(el.className.split(/\s+/).filter((c) => c === HIGHLIGHT_CLASS).length).toBe(1);
  });

  it("highlight(null) and clear() remove the current highlight", () => {
    const h = createHighlighter();
    h.highlight(el);
    h.highlight(null);
    expect(el.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
    expect(h.current()).toBeNull();

    h.highlight(other);
    h.clear();
    expect(other.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
    expect(h.current()).toBeNull();
  });

  it("is a no-op for nullish or classList-less inputs", () => {
    const h = createHighlighter();
    expect(() => h.apply(null)).not.toThrow();
    expect(() => h.remove(undefined)).not.toThrow();
    expect(() => h.highlight(null)).not.toThrow();
  });
});

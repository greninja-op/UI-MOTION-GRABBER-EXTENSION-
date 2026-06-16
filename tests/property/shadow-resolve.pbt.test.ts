// Feature: ui-motion-grabber, Property 4: Recursive shadow resolution returns the innermost element
//
// Validates: Requirements 1.7
//
// Property 4: Recursive shadow resolution returns the innermost element.
//   For any tree of nested open Shadow_Root instances and any point lying over
//   the deepest element, `resolveElement` SHALL return the innermost element at
//   that point rather than any intervening shadow host.
//
// Strategy:
//   jsdom's `elementFromPoint` does not perform layout/hit-testing, so we model
//   nested open shadow roots with lightweight fake nodes. Each level is a fake
//   "host" exposing an open `shadowRoot` whose `elementFromPoint` returns the
//   next-deeper node at the same point. The deepest node is a leaf with no
//   `shadowRoot`. A faithful model: the point lies over the deepest element, so
//   every level's `elementFromPoint` reports the host on the path to that leaf.
//   `resolveElement` must descend the entire chain and return the leaf, never an
//   intervening host.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
// @ts-expect-error — Content_Script is pure unbundled Vanilla JS (no .d.ts).
import { resolveElement } from "../../src/content/shadow-resolver.js";

/** A minimal stand-in for an open shadow host or leaf element. */
interface FakeNode {
  id: string;
  // Present only on shadow hosts; absent on the innermost leaf and on closed hosts.
  shadowRoot?: { elementFromPoint: (x: number, y: number) => FakeNode | null };
}

/**
 * Build a chain of `depth` nested open shadow hosts terminating in a leaf.
 *
 * Returns:
 *   - root:   the starting DocumentOrShadowRoot-like object passed to resolveElement
 *   - chain:  [host0, host1, ..., hostN-1, leaf] — the path the point lies over
 *   - leaf:   the innermost element (chain[chain.length - 1])
 *
 * Every `elementFromPoint` ignores the coordinates because, by construction, the
 * point lies over the deepest element, so the hit path is fixed.
 */
function buildNestedShadowTree(depth: number) {
  // chain[i] for i in [0, depth-1] are shadow hosts; chain[depth] is the leaf.
  const chain: FakeNode[] = [];
  for (let i = 0; i <= depth; i++) {
    chain.push({ id: `node-${i}` });
  }

  // Wire each host's open shadowRoot to report the next-deeper node at the point.
  for (let i = 0; i < depth; i++) {
    const next = chain[i + 1];
    chain[i].shadowRoot = {
      elementFromPoint: () => next,
    };
  }
  // chain[depth] (the leaf) intentionally has no shadowRoot.

  const root = {
    // The top-level document resolves the point to the outermost host (chain[0]).
    elementFromPoint: (_x: number, _y: number): FakeNode | null => chain[0],
  };

  return { root, chain, leaf: chain[depth] };
}

describe("Property 4: Recursive shadow resolution returns the innermost element (Req 1.7)", () => {
  it("returns the innermost element for any depth of nested open shadow roots", () => {
    fc.assert(
      fc.property(
        // depth 0 => no shadow roots (single element); up to 12 nested levels.
        fc.integer({ min: 0, max: 12 }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        (depth, x, y) => {
          const { root, chain, leaf } = buildNestedShadowTree(depth);

          const result = resolveElement(x, y, root as unknown as Document);

          // Must return the innermost (deepest) element.
          expect(result).toBe(leaf);

          // Must never return an intervening shadow host.
          for (let i = 0; i < chain.length - 1; i++) {
            expect(result).not.toBe(chain[i]);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("descends through every level (the result has no further open shadowRoot)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 12 }), (depth) => {
        const { root, leaf } = buildNestedShadowTree(depth);
        const result = resolveElement(0, 0, root as unknown as Document) as FakeNode | null;
        expect(result).toBe(leaf);
        // The innermost element exposes no open shadowRoot to descend into.
        expect(result?.shadowRoot).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});

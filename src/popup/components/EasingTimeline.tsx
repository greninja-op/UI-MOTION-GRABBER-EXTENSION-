/**
 * EasingTimeline — visualizes the State_Map transitions and their easing
 * curves (Req 6.5).
 *
 * For each Transition it renders the delay/duration offsets and a small SVG
 * preview of the normalized cubic-bezier easing curve, plus the
 * `cubic-bezier(x1,y1,x2,y2)` text form.
 *
 * Presentational only. Renders gracefully when the State_Map is null/partial or
 * carries zero transitions (placeholder, never crashes).
 */
import type { CubicBezier, StateMap, Transition } from "../../shared";

export interface EasingTimelineProps {
  /** The diffed State_Map. May be null before analysis completes. */
  stateMap?: StateMap | null;
}

const PREVIEW_SIZE = 48;

/** Format a CubicBezier as its canonical `cubic-bezier(x1,y1,x2,y2)` string. */
function formatBezier(easing: CubicBezier): string {
  return `cubic-bezier(${easing.x1}, ${easing.y1}, ${easing.x2}, ${easing.y2})`;
}

/**
 * Build an SVG path for a cubic-bezier easing curve inside a unit-square
 * preview. The curve runs from the bottom-left (progress 0) to the top-right
 * (progress 1); SVG y grows downward so output values are flipped.
 */
function bezierPath(easing: CubicBezier, size: number): string {
  const s = size;
  const c1x = easing.x1 * s;
  const c1y = (1 - easing.y1) * s;
  const c2x = easing.x2 * s;
  const c2y = (1 - easing.y2) * s;
  return `M 0 ${s} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${s} 0`;
}

function TransitionRow({
  transition,
}: {
  transition: Transition;
}): JSX.Element {
  return (
    <li
      data-testid="easing-transition"
      className="flex items-center gap-3 rounded border border-slate-200 p-2"
    >
      <svg
        width={PREVIEW_SIZE}
        height={PREVIEW_SIZE}
        viewBox={`0 0 ${PREVIEW_SIZE} ${PREVIEW_SIZE}`}
        className="shrink-0 rounded bg-slate-50"
        role="img"
        aria-label={`Easing curve ${formatBezier(transition.easing)}`}
      >
        <path
          d={bezierPath(transition.easing, PREVIEW_SIZE)}
          fill="none"
          stroke="#2563eb"
          strokeWidth={2}
        />
      </svg>
      <div className="flex flex-1 flex-col text-sm">
        <span className="font-medium text-slate-800">
          State {transition.fromIndex} → {transition.toIndex}
        </span>
        <span className="text-slate-600">
          delay {transition.delayOffsetMs}ms · duration{" "}
          {transition.durationOffsetMs}ms
        </span>
        <span className="font-mono text-xs text-slate-500">
          {formatBezier(transition.easing)}
        </span>
        {transition.transformMatrix ? (
          <span className="font-mono text-xs text-slate-400">
            matrix [{transition.transformMatrix.join(", ")}]
          </span>
        ) : null}
      </div>
    </li>
  );
}

export function EasingTimeline({
  stateMap,
}: EasingTimelineProps): JSX.Element {
  const transitions = stateMap?.transitions ?? [];

  return (
    <section
      data-testid="easing-timeline"
      className="flex w-full flex-col gap-2 p-2"
      aria-label="Easing timeline"
    >
      <h2 className="text-sm font-semibold text-slate-700">Easing Timeline</h2>
      {transitions.length > 0 ? (
        <ol className="flex flex-col gap-2">
          {transitions.map((transition) => (
            <TransitionRow
              key={`${transition.fromIndex}-${transition.toIndex}`}
              transition={transition}
            />
          ))}
        </ol>
      ) : (
        <p
          data-testid="easing-timeline-placeholder"
          className="rounded border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500"
        >
          No transitions captured yet.
        </p>
      )}
    </section>
  );
}

export default EasingTimeline;

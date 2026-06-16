/**
 * FrameNotice — surfaces cross-origin / inaccessible sub-frame exclusion
 * reports (FRAME_EXCLUDED) to the user (Req 9.2).
 *
 * Presentational only: the exclusion reports are supplied via props. Renders
 * gracefully (nothing) when there are no exclusions.
 */
import type { FrameExclusion } from "../../shared";

export interface FrameNoticeProps {
  /** The set of excluded sub-frames reported by the System (Req 9.2). */
  exclusions: FrameExclusion[];
}

const REASON_LABEL: Record<FrameExclusion["reason"], string> = {
  "cross-origin": "cross-origin",
  inaccessible: "inaccessible",
};

export function FrameNotice({ exclusions }: FrameNoticeProps): JSX.Element | null {
  if (exclusions.length === 0) {
    return null;
  }

  return (
    <section
      data-testid="frame-notice"
      role="note"
      className="m-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
      aria-label="Excluded sub-frames"
    >
      <p className="font-medium">
        {exclusions.length} sub-frame{exclusions.length === 1 ? "" : "s"} excluded
        from selection
      </p>
      <ul className="mt-1 flex flex-col gap-1">
        {exclusions.map((exclusion, index) => (
          <li
            key={`${exclusion.frameUrl}-${index}`}
            data-testid="frame-notice-item"
            className="break-all font-mono text-xs"
          >
            {exclusion.frameUrl || "(unknown frame)"} —{" "}
            {REASON_LABEL[exclusion.reason]}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default FrameNotice;

/**
 * JsonExportView — renders the Export_Payload as formatted JSON on export
 * request (Req 6.3).
 *
 * Presentational only: the payload and an optional "requested" flag are
 * supplied via props. Renders gracefully when the payload is null/partial —
 * it shows a placeholder and never crashes.
 */
import type { ExportPayload } from "../../shared";

export interface JsonExportViewProps {
  /** The assembled Export_Payload. May be null before analysis completes. */
  payload?: ExportPayload | null;
  /**
   * Whether export was requested. When false the view stays collapsed to a
   * prompt; the formatted JSON is shown once an export is requested (Req 6.3).
   * Defaults to true so the view renders whenever a payload is present.
   */
  requested?: boolean;
}

/** Safely serialize the payload; never throws on unexpected shapes. */
function serialize(payload: ExportPayload): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return "// Unable to serialize Export_Payload.";
  }
}

export function JsonExportView({
  payload,
  requested = true,
}: JsonExportViewProps): JSX.Element {
  return (
    <section
      data-testid="json-export-view"
      className="flex w-full flex-col gap-2 p-2"
      aria-label="JSON export"
    >
      <h2 className="text-sm font-semibold text-slate-700">JSON Export</h2>
      {requested && payload ? (
        <pre
          data-testid="json-export-content"
          className="max-h-72 overflow-auto rounded bg-slate-900 p-3 text-xs leading-relaxed text-slate-100"
        >
          <code>{serialize(payload)}</code>
        </pre>
      ) : (
        <p
          data-testid="json-export-placeholder"
          className="rounded border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500"
        >
          {payload
            ? "Request export to view the JSON payload."
            : "No export payload available yet."}
        </p>
      )}
    </section>
  );
}

export default JsonExportView;

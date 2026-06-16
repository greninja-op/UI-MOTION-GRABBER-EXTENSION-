/**
 * CodeTabs — toggles between the HTML and CSS code views (Req 6.5) and exposes
 * an asynchronous Copy to Clipboard action per tab.
 *
 * Copy behavior:
 *  - Writes the displayed code via `navigator.clipboard.writeText()` (Req 6.6).
 *  - On success, shows an inline transient "Copied" tooltip for that action
 *    (Req 6.7).
 *  - On failure, routes a User_Feedback_Message of type ERROR to the
 *    Feedback_Banner via the `onCopyError` callback (Req 6.9).
 *
 * The clipboard write is a popup user-gesture write requiring no manifest
 * permission beyond the existing activeTab / scripting / debugger set
 * (Req 6.8, 7.7).
 *
 * This component is presentational: it renders the supplied `CodeTabs` data and
 * delegates error surfacing to a callback. It renders gracefully when code is
 * missing (Req: render gracefully on partial/missing payload).
 */
import { useEffect, useRef, useState } from "react";
import type { CodeTabs as CodeTabsData, UserFeedbackMessage } from "../../shared";

type TabKey = "html" | "css";

export interface CodeTabsProps {
  /** HTML/CSS code tabs. May be null/partial before analysis completes. */
  codeTabs?: CodeTabsData | null;
  /** Surface a copy failure as an ERROR User_Feedback_Message (Req 6.9). */
  onCopyError?: (message: UserFeedbackMessage) => void;
  /** How long (ms) the inline "Copied" tooltip stays visible. */
  copiedTooltipMs?: number;
}

const TAB_LABELS: Record<TabKey, string> = {
  html: "HTML",
  css: "CSS",
};

export function CodeTabs({
  codeTabs,
  onCopyError,
  copiedTooltipMs = 1500,
}: CodeTabsProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<TabKey>("html");
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending tooltip timer on unmount to avoid setting state after
  // the component is gone.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  // Reset the transient "Copied" tooltip whenever the active tab changes so the
  // feedback always belongs to the currently visible code.
  useEffect(() => {
    setCopied(false);
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [activeTab]);

  const code = codeTabs ? codeTabs[activeTab] ?? "" : "";
  const hasCode = code.length > 0;

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        setCopied(false);
        timerRef.current = null;
      }, copiedTooltipMs);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      onCopyError?.({
        type: "ERROR",
        text: `Copy to clipboard failed for the ${TAB_LABELS[activeTab]} tab: ${reason}`,
      });
    }
  };

  return (
    <section
      data-testid="code-tabs"
      className="flex w-full flex-col gap-2 p-2"
      aria-label="Code tabs"
    >
      <div className="flex items-center justify-between">
        <div role="tablist" aria-label="Code language" className="flex gap-1">
          {(Object.keys(TAB_LABELS) as TabKey[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={activeTab === key}
              data-tab={key}
              onClick={() => setActiveTab(key)}
              className={`rounded px-3 py-1 text-sm font-medium ${
                activeTab === key
                  ? "bg-slate-800 text-white"
                  : "bg-slate-200 text-slate-700 hover:bg-slate-300"
              }`}
            >
              {TAB_LABELS[key]}
            </button>
          ))}
        </div>

        <div className="relative">
          <button
            type="button"
            aria-label={`Copy ${TAB_LABELS[activeTab]} to clipboard`}
            disabled={!hasCode}
            onClick={handleCopy}
            className="flex items-center gap-1 rounded bg-slate-100 px-2 py-1 text-sm text-slate-700 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {/* Inline clipboard glyph (no icon dependency). */}
            <span aria-hidden="true">⧉</span>
            <span>Copy</span>
          </button>
          {copied ? (
            <span
              role="status"
              data-testid="copy-success-tooltip"
              className="absolute right-0 top-full mt-1 whitespace-nowrap rounded bg-green-600 px-2 py-1 text-xs text-white shadow"
            >
              Copied!
            </span>
          ) : null}
        </div>
      </div>

      {hasCode ? (
        <pre
          data-testid="code-tabs-content"
          className="max-h-64 overflow-auto rounded bg-slate-900 p-3 text-xs leading-relaxed text-slate-100"
        >
          <code>{code}</code>
        </pre>
      ) : (
        <p
          data-testid="code-tabs-placeholder"
          className="rounded border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500"
        >
          No {TAB_LABELS[activeTab]} code captured yet.
        </p>
      )}
    </section>
  );
}

export default CodeTabs;

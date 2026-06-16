/**
 * FeedbackBanner — the dynamic banner region rendered at the top of the
 * Popup_UI (Req 12.1). It surfaces live status updates and permission /
 * operation exceptions as User_Feedback_Message entries.
 *
 * Each message carries a `type` of SUCCESS | ERROR | WARN and a `text`
 * string (Req 12.3). The banner displays:
 *  - live Recording_Session status updates (Req 12.2),
 *  - CDP attach / DOM.forcePseudoState failures as ERROR (Req 12.4),
 *  - restricted / system pages as WARN (Req 12.5),
 *  - excluded cross-origin sub-frames as WARN (Req 12.6),
 *  - clipboard-copy failures as ERROR (Req 6.9).
 *
 * This component is purely presentational: messages are supplied via props and
 * dismissal is delegated to an optional callback. Message_Channel wiring is
 * handled separately (task 14.3).
 */
import type { UserFeedbackMessage, UserFeedbackType } from "../../shared";

export interface FeedbackBannerProps {
  /** Messages to display, newest-first ordering is the caller's choice. */
  messages: UserFeedbackMessage[];
  /** Optional dismissal handler; when provided each message shows a close control. */
  onDismiss?: (index: number) => void;
}

/** Tailwind class sets per feedback type for clear visual distinction. */
const TYPE_STYLES: Record<UserFeedbackType, string> = {
  SUCCESS: "bg-green-100 text-green-900 border-green-300",
  ERROR: "bg-red-100 text-red-900 border-red-300",
  WARN: "bg-amber-100 text-amber-900 border-amber-300",
};

/** A short symbol prefix per type (text-only, no icon dependency). */
const TYPE_LABEL: Record<UserFeedbackType, string> = {
  SUCCESS: "✓",
  ERROR: "✕",
  WARN: "!",
};

export function FeedbackBanner({
  messages,
  onDismiss,
}: FeedbackBannerProps): JSX.Element {
  // The banner region is always present at the top of the interface (Req 12.1),
  // even when there are no messages, so its placement is stable.
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="feedback-banner"
      className="flex w-full flex-col gap-1 px-2 pt-2"
    >
      {messages.map((message, index) => (
        <div
          key={`${message.type}-${index}-${message.text}`}
          role={message.type === "ERROR" ? "alert" : undefined}
          data-feedback-type={message.type}
          className={`flex items-start gap-2 rounded border px-3 py-2 text-sm ${
            TYPE_STYLES[message.type]
          }`}
        >
          <span aria-hidden="true" className="font-bold leading-5">
            {TYPE_LABEL[message.type]}
          </span>
          <span className="flex-1 leading-5 break-words">{message.text}</span>
          {onDismiss ? (
            <button
              type="button"
              aria-label="Dismiss message"
              onClick={() => onDismiss(index)}
              className="ml-1 rounded px-1 leading-5 hover:bg-black/10"
            >
              ×
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export default FeedbackBanner;

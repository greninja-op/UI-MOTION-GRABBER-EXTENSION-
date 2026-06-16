/**
 * Barrel re-export for the Popup_UI presentational components.
 *
 * These components are pure/presentational: they take data and callbacks via
 * props and hold no Message_Channel wiring (that lives in task 14.3).
 */
export { CodeTabs } from "./CodeTabs";
export type { CodeTabsProps } from "./CodeTabs";

export { EasingTimeline } from "./EasingTimeline";
export type { EasingTimelineProps } from "./EasingTimeline";

export { JsonExportView } from "./JsonExportView";
export type { JsonExportViewProps } from "./JsonExportView";

export { FrameNotice } from "./FrameNotice";
export type { FrameNoticeProps } from "./FrameNotice";

export { FeedbackBanner } from "./FeedbackBanner";
export type { FeedbackBannerProps } from "./FeedbackBanner";

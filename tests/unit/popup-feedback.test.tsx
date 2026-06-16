/**
 * Unit / example tests for the Feedback_Banner and Copy to Clipboard flows of
 * the Popup_UI (task 14.2).
 *
 * Coverage:
 *  - Feedback_Banner is rendered at the top of the interface and renders the
 *    User_Feedback_Message `text` for each `type` (SUCCESS / ERROR / WARN)
 *    (Req 12.1, 12.3).
 *  - Copy to Clipboard success path: `navigator.clipboard.writeText` is called
 *    with the displayed code and inline success feedback is shown (Req 6.6, 6.7).
 *  - Copy to Clipboard failure path: a rejecting `writeText` surfaces a
 *    User_Feedback_Message of type ERROR in the Feedback_Banner (Req 6.9).
 *  - Restricted / system page path: a User_Feedback_Message of type WARN is
 *    surfaced in the Feedback_Banner (Req 12.5).
 *
 * These are example-based unit tests using @testing-library/react on Vitest's
 * jsdom environment. The clipboard API is mocked per test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import App from "../../src/popup/App";
import { FeedbackBanner } from "../../src/popup/components/FeedbackBanner";
import type { CodeTabs as CodeTabsData, UserFeedbackMessage } from "../../src/shared";

const SAMPLE_CODE: CodeTabsData = {
  html: "<button class=\"cta\">Click</button>",
  css: ".cta { transition: transform 200ms ease-in-out; }",
};

/** Install a mock `navigator.clipboard.writeText` and return the spy. */
function mockClipboard(impl: (text: string) => Promise<void>) {
  const writeText = vi.fn(impl);
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // Drop the mocked clipboard so each test installs its own surface.
  // Reflect.deleteProperty is a no-op if the property was never defined.
  Reflect.deleteProperty(globalThis.navigator as unknown as object, "clipboard");
});

describe("Feedback_Banner placement and rendering (Req 12.1, 12.3)", () => {
  it("renders the User_Feedback_Message text for each type", () => {
    const messages: UserFeedbackMessage[] = [
      { type: "SUCCESS", text: "Recording started." },
      { type: "ERROR", text: "CDP attachment failed." },
      { type: "WARN", text: "This is a restricted system page." },
    ];

    render(<FeedbackBanner messages={messages} />);

    const banner = screen.getByTestId("feedback-banner");

    // Every message's text is rendered.
    for (const message of messages) {
      expect(within(banner).getByText(message.text)).toBeInTheDocument();
    }

    // Each rendered entry is tagged with its type, one per message.
    expect(banner.querySelectorAll('[data-feedback-type="SUCCESS"]')).toHaveLength(1);
    expect(banner.querySelectorAll('[data-feedback-type="ERROR"]')).toHaveLength(1);
    expect(banner.querySelectorAll('[data-feedback-type="WARN"]')).toHaveLength(1);
  });

  it("places the Feedback_Banner at the very top of the popup interface", () => {
    const { container } = render(
      <App
        feedbackMessages={[{ type: "SUCCESS", text: "Live status update." }]}
      />,
    );

    // The popup root wraps the layout; its first child must be the banner so
    // the banner sits at the top of the interface (Req 12.1).
    const root = container.firstElementChild as HTMLElement;
    expect(root).not.toBeNull();
    const firstChild = root.firstElementChild as HTMLElement;
    expect(firstChild).toHaveAttribute("data-testid", "feedback-banner");
    expect(within(firstChild).getByText("Live status update.")).toBeInTheDocument();
  });
});

describe("Copy to Clipboard success path (Req 6.6, 6.7)", () => {
  it("writes the displayed code and shows inline success feedback", async () => {
    const writeText = mockClipboard(() => Promise.resolve());

    render(<App codeTabs={SAMPLE_CODE} />);

    // The HTML tab is active by default, so the displayed code is the HTML code.
    const copyButton = screen.getByRole("button", {
      name: /copy html to clipboard/i,
    });
    fireEvent.click(copyButton);

    // The async clipboard write resolves; flush microtasks/state updates.
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(writeText).toHaveBeenCalledWith(SAMPLE_CODE.html);

    // Inline "Copied" success tooltip is shown for this action (Req 6.7).
    await waitFor(() => {
      expect(screen.getByTestId("copy-success-tooltip")).toBeInTheDocument();
    });
  });
});

describe("Copy to Clipboard failure path (Req 6.9)", () => {
  it("surfaces an ERROR User_Feedback_Message in the Feedback_Banner", async () => {
    const writeText = mockClipboard(() =>
      Promise.reject(new Error("clipboard blocked")),
    );

    render(<App codeTabs={SAMPLE_CODE} />);

    const copyButton = screen.getByRole("button", {
      name: /copy html to clipboard/i,
    });
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });

    // The failure routes to the banner as an ERROR message (Req 6.9).
    const banner = screen.getByTestId("feedback-banner");
    await waitFor(() => {
      const errorEntry = banner.querySelector('[data-feedback-type="ERROR"]');
      expect(errorEntry).not.toBeNull();
      expect(errorEntry?.textContent ?? "").toMatch(/copy to clipboard failed/i);
    });
  });
});

describe("Restricted / system page path (Req 12.5)", () => {
  it("surfaces a WARN User_Feedback_Message in the Feedback_Banner", () => {
    const restrictedWarning: UserFeedbackMessage = {
      type: "WARN",
      text: "Restricted system page: extension operation is not available here.",
    };

    render(<App feedbackMessages={[restrictedWarning]} />);

    const banner = screen.getByTestId("feedback-banner");
    const warnEntry = banner.querySelector('[data-feedback-type="WARN"]');
    expect(warnEntry).not.toBeNull();
    expect(within(banner).getByText(restrictedWarning.text)).toBeInTheDocument();
  });
});

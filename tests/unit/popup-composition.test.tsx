/**
 * Unit tests for Popup_UI composition (Task 14.4).
 *
 * Renders the top-level {@link App} with seed props (a sample StateMap,
 * ExportPayload, codeTabs, and `exportRequested = true`) WITHOUT a chrome
 * extension context, and asserts the three primary presentational components
 * compose and render:
 *   - CodeTabs (Req 6.5)
 *   - EasingTimeline (Req 6.5)
 *   - JsonExportView, showing the serialized Export_Payload JSON (Req 6.3)
 *
 * Rendering without a chrome surface exercises the graceful-default path: the
 * Message_Channel reports `available === false`, live values are null, and the
 * prop seeds drive what is shown.
 *
 * Requirements: 6.3, 6.5
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import App from "../../src/popup/App";
import type {
  CodeTabs as CodeTabsData,
  ExportPayload,
  StateMap,
} from "../../src/shared";

afterEach(() => {
  cleanup();
});

const codeTabs: CodeTabsData = {
  html: '<div class="kinetic-box">Hello</div>',
  css: ".kinetic-box { transform: translateX(12px); opacity: 0.5; }",
};

const stateMap: StateMap = {
  sessionId: "session-compose-1",
  transitions: [
    {
      fromIndex: 0,
      toIndex: 1,
      delayOffsetMs: 100,
      durationOffsetMs: 250,
      easing: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
      transformMatrix: null,
    },
  ],
};

const exportPayload: ExportPayload = {
  codeTabs,
  figmaTokens: [
    { name: "ease/standard", value: "cubic-bezier(0.42,0,0.58,1)" },
  ],
  architecturalReport: "# Architectural Report\n\nLayout strategy: Flexbox.",
};

describe("Popup_UI composition (App)", () => {
  it("renders CodeTabs, EasingTimeline, and JsonExportView together", () => {
    render(
      <App
        codeTabs={codeTabs}
        stateMap={stateMap}
        exportPayload={exportPayload}
        exportRequested
      />,
    );

    // All three primary regions are composed into the popup.
    expect(screen.getByTestId("code-tabs")).toBeInTheDocument();
    expect(screen.getByTestId("easing-timeline")).toBeInTheDocument();
    expect(screen.getByTestId("json-export-view")).toBeInTheDocument();
  });

  it("renders the seeded HTML code in CodeTabs (Req 6.5)", () => {
    render(
      <App
        codeTabs={codeTabs}
        stateMap={stateMap}
        exportPayload={exportPayload}
        exportRequested
      />,
    );

    // HTML is the default active tab, so its code is visible.
    const content = screen.getByTestId("code-tabs-content");
    expect(content).toHaveTextContent('<div class="kinetic-box">Hello</div>');
    expect(screen.queryByTestId("code-tabs-placeholder")).not.toBeInTheDocument();
  });

  it("renders a State_Map transition in EasingTimeline (Req 6.5)", () => {
    render(
      <App
        codeTabs={codeTabs}
        stateMap={stateMap}
        exportPayload={exportPayload}
        exportRequested
      />,
    );

    // One transition was seeded, so a transition row renders (no placeholder).
    expect(screen.getByTestId("easing-transition")).toBeInTheDocument();
    expect(
      screen.queryByTestId("easing-timeline-placeholder"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("easing-timeline")).toHaveTextContent(
      "State 0 → 1",
    );
  });

  it("shows the serialized Export_Payload JSON when export is requested (Req 6.3)", () => {
    render(
      <App
        codeTabs={codeTabs}
        stateMap={stateMap}
        exportPayload={exportPayload}
        exportRequested
      />,
    );

    const jsonContent = screen.getByTestId("json-export-content");
    // The view renders exactly the pretty-printed serialization of the payload.
    const expected = JSON.stringify(exportPayload, null, 2);
    expect(jsonContent).toHaveTextContent(
      // textContent collapses; compare against a normalized form below too.
      "architecturalReport",
    );
    expect(jsonContent.textContent).toBe(expected);
    expect(
      screen.queryByTestId("json-export-placeholder"),
    ).not.toBeInTheDocument();
  });
});

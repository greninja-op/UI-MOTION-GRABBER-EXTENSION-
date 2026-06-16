# Requirements Document

## Introduction

UI Motion Grabber is a Chromium Extension built on Manifest V3 that operates as a 100% local, open-source, zero-dependency engineering tool. It allows a user to select any element on a live web page, observe and record that element's state transitions over time, parse its computed styles and active animations, and reverse-engineer how the component was built. The extension outputs clean HTML/CSS code, Figma design tokens, and an architectural breakdown report through a structured JSON data model.

Unlike DOM-snapshot scrapers that capture the web as flat and static at a single click instant, UI Motion Grabber records interaction physics across the time axis: CSS layout transitions, framework state shifts, easing and spring metrics, and visual feedback during state morphing, captured directly from a live production runtime.

The system is composed of three cooperating runtime contexts: a pure Vanilla JS content script injected into the host page, an asynchronous Manifest V3 service worker that performs state diffing and data transformation, and a React popup UI that presents code tabs, easing timelines, and JSON export. All processing occurs locally with no data backend and no network egress.

This document defines the requirements for element selection, state capture, service worker state diffing, animation parsing, the reverse-engineering engine, data export, messaging architecture, UI style isolation, iframe handling, performance guardrails, recording session lifecycle control, and user feedback surfacing.

## Glossary

- **System**: The complete UI Motion Grabber Chromium extension comprising the Content_Script, Service_Worker, and Popup_UI.
- **Content_Script**: The pure Vanilla JavaScript module (content.js) injected into host pages that performs element selection, highlighting, observation, and style extraction.
- **Service_Worker**: The asynchronous Manifest V3 background module (background.js, type module) that performs state diffing, data transformation, and CDP coordination.
- **Popup_UI**: The React + Vite + Tailwind CSS interface that displays code tabs, easing timelines, and JSON export controls.
- **Picker_Mode**: The interactive state in which the user hovers and selects elements on the live host page.
- **Target_Element**: The DOM element the user has locked for analysis.
- **Highlight_Class**: The isolated CSS class (`.ui-motion-grabber-target-hover`) applied to a hovered element to visually highlight it without modifying the element's inline style attribute.
- **Overlay_UI**: The injected on-page interface rendered by the Content_Script inside an isolated Shadow DOM container.
- **Mutation_Engine**: The MutationObserver-based subsystem that records Target_Element state transitions over time.
- **Interaction_Timeline**: The time-ordered record of captured state transitions for a Target_Element.
- **Structural_Signature**: A cached string formed from `Target_Element.className` concatenated with `Target_Element.style.cssText`, used to detect duplicate mutations.
- **State_Diffing_Engine**: The Service_Worker subsystem that analyzes the Interaction_Timeline to compute timing offsets, easing curves, and transform matrices between states.
- **State_Map**: The processed data structure produced by the State_Diffing_Engine and sent to the Popup_UI.
- **Animation_Parser**: The subsystem that extracts computed styles and active animations and normalizes easing values.
- **Reverse_Engineering_Engine**: The subsystem that classifies layout strategy, animation delivery method, and performance characteristics, and generates the architectural report.
- **Architectural_Report**: The human-readable markdown report describing how the Target_Element was built and its optimization decisions.
- **Export_Payload**: The structured JSON data model containing code tabs (HTML/CSS), Figma design token variables, and the Architectural_Report string.
- **CDP**: The Chrome DevTools Protocol, used here for `DOM.forcePseudoState`.
- **Frame_Guard**: The 16ms debounce mechanism using `performance.now()` that drops calculations for mutations occurring within 16 milliseconds of the previous mutation.
- **Shadow_Root**: An open shadow DOM root attached to a web component element.
- **Message_Channel**: The communication mechanism between runtime contexts using `chrome.runtime.sendMessage` and Chrome `Port` connections.
- **Recording_Session**: A single capture lifecycle for one Target_Element, encompassing its Interaction_Timeline, derived State_Map, and recording status (Idle, Recording, Paused, Stopped).
- **Recording_Status**: The canonical lifecycle state of a Recording_Session, one of Idle, Recording, Paused, or Stopped. This is the single authoritative status enumeration for a Recording_Session.
- **Session_Controller**: The Content_Script subsystem that implements the Recording_Session state machine, owns Recording_Status transitions, and coordinates MutationObserver attachment and disconnection across those transitions.
- **Session_Controls_State**: The Popup_UI view-model representation of Recording_Status. It enumerates the same four states (Idle, Recording, Paused, Stopped) and is derived one-to-one from the canonical Recording_Status; it introduces no additional or alternative status values and is not a separate source of truth.
- **Feedback_Banner**: The dynamic banner region rendered at the top of the Popup_UI that surfaces User_Feedback_Message entries.
- **User_Feedback_Message**: A message displayed in the Feedback_Banner, comprising a `type` of SUCCESS, ERROR, or WARN and a `text` string.

## Requirements

### Requirement 1: Element Picker and Selection Mode

**User Story:** As a UI engineer, I want to hover over and select any element on a live page, so that I can lock a specific micro-interaction for analysis without triggering site navigation.

#### Acceptance Criteria

1. WHILE Picker_Mode is active, WHEN the user hovers over a host page element, THE Content_Script SHALL apply the Highlight_Class to the hovered element.
2. WHILE Picker_Mode is active, WHEN the user moves the pointer off a previously hovered element, THE Content_Script SHALL remove the Highlight_Class from that element.
3. THE Content_Script SHALL apply and remove the Highlight_Class without modifying the inline `style` attribute of any host page element.
4. WHILE Picker_Mode is active, THE Content_Script SHALL register mouse event listeners in the capture phase with `capture: true`.
5. WHILE Picker_Mode is active, WHEN the user clicks a host page element, THE Content_Script SHALL call `stopPropagation()` and `preventDefault()` to prevent host-site link or navigation traversal.
6. WHEN the user clicks a host page element in Picker_Mode, THE Content_Script SHALL set that element as the Target_Element.
7. WHEN resolving the element under the pointer, THE Content_Script SHALL recursively traverse open Shadow_Root instances using `elementFromPoint` so that nested web component elements can be targeted.
8. WHEN Picker_Mode ends, THE Content_Script SHALL remove every event listener it attached to the host page.

### Requirement 2: State Capture Over Time

**User Story:** As a UI engineer, I want to record how an element's state changes over time, so that I can analyze its interaction transitions.

#### Acceptance Criteria

1. WHEN a Target_Element is locked, THE Mutation_Engine SHALL bind a MutationObserver to the Target_Element node.
2. THE Mutation_Engine SHALL bind the MutationObserver only to the Target_Element node and SHALL exclude the global `document` and the `body` element.
3. WHEN configuring the MutationObserver, THE Mutation_Engine SHALL restrict the `attributeFilter` to `["class", "style"]`.
4. IF an incoming mutation occurs less than 16 milliseconds after the previously processed mutation as measured by `performance.now()`, THEN THE Mutation_Engine SHALL drop the calculation for that mutation.
5. IF an incoming mutation produces a Structural_Signature equal to the cached Structural_Signature, THEN THE Mutation_Engine SHALL drop execution for that mutation.
6. WHEN a mutation is processed, THE Mutation_Engine SHALL update the cached Structural_Signature to the new combination of `Target_Element.className` and `Target_Element.style.cssText`.
7. WHEN a state transition is processed, THE Mutation_Engine SHALL append a time-stamped entry to the Interaction_Timeline.

### Requirement 3: Service Worker State Diffing and Transformation

**User Story:** As a UI engineer, I want the captured timeline analyzed into precise transition metrics, so that I can reproduce the interaction's timing and motion accurately.

#### Acceptance Criteria

1. WHEN the Service_Worker receives an Interaction_Timeline, THE State_Diffing_Engine SHALL compute the delay and duration offsets between consecutive states.
2. WHEN analyzing a transition, THE State_Diffing_Engine SHALL extract the easing curve associated with that transition.
3. WHEN a transition includes a transform, THE State_Diffing_Engine SHALL extract the transform matrix for that transition.
4. WHEN diffing completes, THE State_Diffing_Engine SHALL produce a State_Map and send the State_Map to the Popup_UI.

### Requirement 4: Animation Parsing and Normalization

**User Story:** As a UI engineer, I want the extension to extract and normalize an element's styles and active animations, so that I can read precise, copy-ready animation values.

#### Acceptance Criteria

1. WHEN analyzing a Target_Element, THE Animation_Parser SHALL extract computed styles using `window.getComputedStyle` on the Target_Element.
2. WHEN analyzing a Target_Element, THE Animation_Parser SHALL query active programmatic animations using `Target_Element.getAnimations()`.
3. WHEN an easing value is one of `ease`, `ease-in`, `ease-out`, `ease-in-out`, or `linear`, THE Animation_Parser SHALL convert that value to its explicit `cubic-bezier(x1,y1,x2,y2)` coordinates using a defined conversion map.
4. WHEN the user requests a frozen pseudo-state, THE Service_Worker SHALL issue a CDP `DOM.forcePseudoState` command to freeze the Target_Element in the requested `:hover` or `:active` pseudo-state.
5. WHILE a Target_Element is frozen in a pseudo-state, THE Animation_Parser SHALL extract computed style metrics for the Target_Element when the pointer is not over the Target_Element.

### Requirement 5: Architectural Reverse-Engineering Engine

**User Story:** As a UI engineer, I want a breakdown of how a component was built, so that I can understand its layout strategy and performance characteristics.

#### Acceptance Criteria

1. WHEN analyzing a Target_Element, THE Reverse_Engineering_Engine SHALL classify the layout strategy as Flexbox or Grid based on the Target_Element computed `display` value.
2. WHEN analyzing a Target_Element, THE Reverse_Engineering_Engine SHALL classify the animation delivery method as Web Animations API or CSS transitions.
3. WHEN auditing performance, THE Reverse_Engineering_Engine SHALL classify animated properties as composite-friendly when they are `transform` or `opacity`.
4. WHEN auditing performance, THE Reverse_Engineering_Engine SHALL classify animated properties as layout-triggering when they are `top`, `width`, or `margin`.
5. WHEN analysis completes, THE Reverse_Engineering_Engine SHALL generate an Architectural_Report in markdown that describes the layout strategy, the animation delivery method, and the performance classification of animated properties.

### Requirement 6: Data Output and Export

**User Story:** As a UI engineer, I want analysis results exported in a structured format, so that I can paste code into my project and tokens into Figma.

#### Acceptance Criteria

1. THE Service_Worker SHALL assemble analysis results into an Export_Payload that contains code tabs for HTML and CSS, Figma design token variables, and the Architectural_Report string.
2. WHEN producing Figma design token variables, THE Service_Worker SHALL output `cubic-bezier` timing values in `cubic-bezier(x1,y1,x2,y2)` format.
3. WHEN the user requests export, THE Popup_UI SHALL present the Export_Payload as structured JSON.
4. WHEN the Export_Payload is serialized to JSON and then parsed back into an Export_Payload, THE System SHALL produce an Export_Payload equivalent to the original (round-trip property).
5. THE Popup_UI SHALL display code tabs for HTML and CSS, an easing timeline, and the JSON export.
6. WHEN the user activates the Copy to Clipboard action for a displayed HTML or CSS code tab, THE Popup_UI SHALL write the displayed code to the system clipboard using the asynchronous clipboard API `navigator.clipboard.writeText`.
7. WHEN a Copy to Clipboard write completes successfully, THE Popup_UI SHALL display visual success feedback for that action.
8. THE Popup_UI SHALL perform the Copy to Clipboard write as a popup user-gesture clipboard write that requires only the existing `activeTab`, `scripting`, and `debugger` permissions, consistent with Requirement 7.7.
9. IF a Copy to Clipboard write fails, THEN THE Popup_UI SHALL display a User_Feedback_Message with type ERROR in the Feedback_Banner.

### Requirement 7: Messaging and Manifest V3 Architecture

**User Story:** As a developer maintaining the extension, I want a clean Manifest V3 architecture with defined messaging, so that the extension is compliant, local, and dependency-free.

#### Acceptance Criteria

1. THE System SHALL declare a Manifest V3 manifest with an asynchronous Service_Worker registered as the background script with `type` set to `module`.
2. THE System SHALL implement background behavior using the asynchronous Service_Worker and SHALL exclude the `getBackgroundPage` API and the `background.scripts` array.
3. THE Content_Script SHALL be implemented in pure Vanilla JavaScript with zero third-party libraries and zero bundling.
4. THE Popup_UI SHALL be implemented with React, Vite, and Tailwind CSS.
5. THE System SHALL perform state diffing and data transformation within the Service_Worker.
6. WHEN runtime contexts exchange data, THE System SHALL pass messages over the Message_Channel using `chrome.runtime.sendMessage` and Chrome `Port` connections between the Content_Script, the Service_Worker, and the Popup_UI.
7. THE System SHALL request only the `activeTab`, `scripting`, and `debugger` permissions in the manifest.
8. THE System SHALL operate entirely locally and SHALL exclude network requests to any external backend.

### Requirement 8: Overlay UI Style Isolation

**User Story:** As a UI engineer, I want the injected interface to be visually isolated, so that it neither pollutes nor is affected by the host site's styles.

#### Acceptance Criteria

1. WHEN injecting the Overlay_UI, THE Content_Script SHALL render the Overlay_UI inside a Shadow_Root container.
2. THE Content_Script SHALL apply `all: initial` reset styles to the Overlay_UI container.
3. THE Overlay_UI SHALL render with its own styles when the host page declares conflicting `!important` style rules.

### Requirement 9: Iframe and Sub-Frame Handling

**User Story:** As a UI engineer, I want to analyze elements inside iframes where permitted, so that I can capture components embedded in sub-frames.

#### Acceptance Criteria

1. WHERE a host page contains permitted sub-frames, THE System SHALL inject the Content_Script into sub-frames using `chrome.scripting.executeScript` with `allFrames` enabled.
2. IF a sub-frame is cross-origin and inaccessible, THEN THE Content_Script SHALL exclude that sub-frame from selection and report the limitation to the Popup_UI.

### Requirement 10: Performance and Resource Management

**User Story:** As a UI engineer, I want the extension to stay fast and leak-free, so that analysis never freezes or degrades the host page.

#### Acceptance Criteria

1. WHEN the Service_Worker performs compilation and data transformation for a single analysis pass, THE Service_Worker SHALL complete that pass within 8 milliseconds.
2. WHILE the Content_Script interpolates layer shifts, THE Content_Script SHALL use `requestAnimationFrame` to schedule interpolation so that the host page sustains a 60 frames-per-second paint rate.
3. WHEN Picker_Mode ends or a Target_Element is released, THE Content_Script SHALL disconnect the MutationObserver bound to the Target_Element.
4. WHEN Picker_Mode ends or a Target_Element is released, THE System SHALL release all page-attached listeners and observer references associated with that session.

### Requirement 11: Recording Session Lifecycle and Pause/Resume Control

**User Story:** As a UI engineer, I want recording to pause and resume cleanly, so that paused sessions impose no observation overhead on the host page and resumed sessions continue capturing the same element.

#### Acceptance Criteria

1. WHEN a Target_Element is locked, THE Session_Controller SHALL transition the Recording_Session Recording_Status from Idle to Recording.
2. WHILE the Recording_Status is Recording, THE Session_Controller SHALL maintain a MutationObserver bound to the Target_Element.
3. WHEN the Recording_Status transitions to Paused, THE Session_Controller SHALL disconnect the MutationObserver bound to the Target_Element to remove page processor overhead during the paused state.
4. WHEN the Recording_Status transitions from Paused to Recording, THE Session_Controller SHALL create a new MutationObserver instance bound to the cached Target_Element.
5. WHILE the Recording_Status is Paused, THE Session_Controller SHALL exclude state transitions from the Interaction_Timeline.
6. WHEN the Recording_Status transitions to Stopped, THE Session_Controller SHALL disconnect the MutationObserver, release all page-attached listeners and observer references for the session, and forward the frozen Interaction_Timeline to the Service_Worker.
7. THE Popup_UI Session_Controls_State SHALL mirror the canonical Recording_Status one-to-one and SHALL exclude any status value not present in Recording_Status.

### Requirement 12: User Feedback and Status Surfacing

**User Story:** As a UI engineer, I want live status updates and clear error feedback in the popup, so that I understand operation results and permission limitations without inspecting logs.

#### Acceptance Criteria

1. THE Popup_UI SHALL render a Feedback_Banner at the top of the interface.
2. WHEN the System produces a live status update for the active Recording_Session, THE Popup_UI SHALL display that status update as a User_Feedback_Message in the Feedback_Banner.
3. THE Popup_UI SHALL represent each User_Feedback_Message with a `type` of SUCCESS, ERROR, or WARN and a `text` string.
4. IF a CDP debugger attachment or `DOM.forcePseudoState` operation fails, THEN THE Popup_UI SHALL display a User_Feedback_Message with type ERROR in the Feedback_Banner.
5. IF a Target page is a restricted or system page that prevents extension operation, THEN THE Popup_UI SHALL display a User_Feedback_Message with type WARN in the Feedback_Banner.
6. WHEN a sub-frame is excluded from selection, THE Popup_UI SHALL display a User_Feedback_Message with type WARN in the Feedback_Banner.

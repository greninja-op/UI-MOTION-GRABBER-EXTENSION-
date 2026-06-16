# Implementation Plan: UI Motion Grabber

## Overview

This plan builds the UI Motion Grabber MV3 extension incrementally across its three runtime
contexts. It starts with the project scaffold and shared data models, then implements the
zero-dependency Content_Script capture layer (Picker, Highlighter, Mutation_Engine, Overlay_UI,
Session Controller), the Service_Worker analysis layer (State_Diffing_Engine, Animation_Parser,
CDP Coordinator, Reverse_Engineering_Engine, Export_Payload Assembler), the messaging fabric,
iframe injection, and the React Popup_UI. Each step builds on the previous one and ends by wiring
the pieces together so no code is left orphaned.

Implementation languages (from the design):
- **Content_Script (`content.js`)**: pure Vanilla JavaScript, zero dependencies, unbundled.
- **Service_Worker (`background.js`) and analysis modules**: ES modules (JavaScript/TypeScript).
- **Popup_UI**: React + Vite + Tailwind CSS (TypeScript).
- **Property-based tests**: fast-check on the Popup_UI/worker test runner (Vitest), minimum 100 iterations each.

## Tasks

- [x] 1. Set up extension project structure, manifest, and toolchain
  - [x] 1.1 Create MV3 manifest and directory scaffold
    - Create `manifest.json` with `manifest_version: 3`, a module-type `background.service_worker`, no `background.scripts`, and `permissions` limited to `activeTab`, `scripting`, `debugger`
    - Create directory layout: `src/content/`, `src/worker/`, `src/popup/`, `src/shared/`, `tests/`
    - Add a `content_scripts` / scripting registration entry placeholder
    - _Requirements: 7.1, 7.2, 7.7, 7.8_

  - [x] 1.2 Set up Popup_UI toolchain (React + Vite + Tailwind) and test runner
    - Configure Vite, React, Tailwind CSS for the popup build
    - Configure Vitest as the test runner and add fast-check as a dev dependency
    - Add npm scripts for `build` and `test` (use `--run` for single-execution test runs)
    - _Requirements: 7.4_

  - [x]* 1.3 Write smoke/static checks for manifest and toolchain
    - Assert `manifest_version: 3`, module-type `background.service_worker`, no `background.scripts`, permissions limited to `activeTab`/`scripting`/`debugger`
    - Assert React, Vite, Tailwind declared for the popup
    - Static scan asserting no `fetch`/`XMLHttpRequest`/external URLs and no `getBackgroundPage` usage
    - _Requirements: 7.1, 7.2, 7.3, 7.7, 7.8_

- [x] 2. Define shared data models and the message envelope
  - [x] 2.1 Implement shared type/shape definitions
    - Define `TimelineEntry`, `InteractionTimeline`, `Transition`, `StateMap`, `CubicBezier`, `AnimationDescriptor`, `ComputedStyleSnapshot`, `CodeTabs`, `FigmaToken`, `ExportPayload`, `RecordingStatus`, `RecordingSession`, `FrameExclusion`, `SessionControlsState` (`IDLE`, `RECORDING`, `PAUSED`, `STOPPED`), `UserFeedbackMessage` (`type: 'SUCCESS' | 'ERROR' | 'WARN'`, `text: string`)
    - Define the Message_Channel envelope `{ type, sessionId, payload }` and the message-type constants (`PICKER_START`, `TARGET_LOCKED`, `TIMELINE_CHUNK`, `STATE_MAP`, `EXPORT_PAYLOAD`, `FREEZE_PSEUDO`, `FRAME_EXCLUDED`, `SESSION_STOP`)
    - Keep all Export_Payload shapes JSON-serializable (no functions, class instances, `undefined`, or circular refs)
    - _Requirements: 6.1, 7.6_

- [x] 3. Implement Content_Script picker and highlighting (Vanilla JS, zero-dep)
  - [x] 3.1 Implement Highlighter
    - Apply/remove `Highlight_Class` (`.ui-motion-grabber-target-hover`) via `classList` only
    - Never read or write the host element's inline `style` attribute
    - _Requirements: 1.1, 1.2, 1.3_

  - [x]* 3.2 Write property test for highlight round-trip
    - **Property 1: Highlight round-trip leaves DOM unchanged**
    - **Validates: Requirements 1.1, 1.2**

  - [x]* 3.3 Write property test for inline-style invariance
    - **Property 2: Highlighting never mutates inline style**
    - **Validates: Requirements 1.3**

  - [x] 3.4 Implement Picker activation, capture-phase listeners, and click locking
    - Register `mouseover`/`mouseout`/`click` listeners with `{ capture: true }`, tracked in a teardown registry
    - On click, call `stopPropagation()` and `preventDefault()` and lock the clicked element as Target_Element
    - On hover, drive the Highlighter (apply to current, remove from previous)
    - _Requirements: 1.4, 1.5, 1.6_

  - [x] 3.5 Implement recursive Shadow_Root element resolution
    - `resolveElement(x, y)` descends through deepest open `shadowRoot` via `elementFromPoint`, returning the innermost element; guards against `null` results
    - _Requirements: 1.7_

  - [x]* 3.6 Write property test for clicked-element targeting
    - **Property 3: Clicked element becomes the Target_Element**
    - **Validates: Requirements 1.6**

  - [x]* 3.7 Write property test for recursive shadow resolution
    - **Property 4: Recursive shadow resolution returns the innermost element**
    - **Validates: Requirements 1.7**

  - [x]* 3.8 Write unit tests for capture-phase registration and click freezing
    - Spy on `addEventListener`, assert `{ capture: true }`
    - Assert `stopPropagation` and `preventDefault` invoked on click
    - _Requirements: 1.4, 1.5_

- [x] 4. Implement the Mutation_Engine with both dedup gates
  - [x] 4.1 Implement observer attach/detach and gate pipeline
    - `attach(target)` calls `observe(target, { attributes: true, attributeFilter: ["class","style"] })` bound only to the Target_Element node (never `document`/`body`)
    - `handle(records)` applies Frame_Guard (drop if `< 16ms` since last processed via `performance.now()`), then Structural_Signature dedup (`className + style.cssText`), then updates cached signature/timestamp and appends a timestamped Interaction_Timeline entry
    - `detach()` disconnects the observer
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 10.3_

  - [x]* 4.2 Write property test for Frame_Guard debounce
    - **Property 5: Frame_Guard debounce**
    - **Validates: Requirements 2.4**

  - [x]* 4.3 Write property test for Structural_Signature dedup/update/append
    - **Property 6: Structural_Signature dedup, update, and append**
    - **Validates: Requirements 2.5, 2.6, 2.7**

  - [x]* 4.4 Write property test for observer binding scope
    - **Property 7: Observer bound only to the Target_Element**
    - **Validates: Requirements 2.2**

  - [x]* 4.5 Write unit test for observer wiring
    - Assert `observe` called with the target node and `{ attributes: true, attributeFilter: ["class","style"] }`
    - _Requirements: 2.1, 2.3_

- [x] 5. Implement the isolated Overlay_UI host in the Content_Script
  - [x] 5.1 Implement Shadow_Root container with `all: initial` reset and rAF interpolation
    - Create a container, attach an open `shadowRoot`, inject a root stylesheet beginning with `all: initial`
    - Schedule interpolated layer shifts via `requestAnimationFrame`
    - Fall back to a fresh top-level container with its own shadow root if attachment fails
    - _Requirements: 8.1, 8.2, 8.3, 10.2_

  - [x]* 5.2 Write property test for overlay isolation against host styles
    - **Property 19: Overlay isolation against host styles**
    - **Validates: Requirements 8.3**

  - [x]* 5.3 Write unit tests for overlay setup and rAF interpolation
    - Assert a shadow root is attached and the root stylesheet starts with `all: initial`
    - Spy on `requestAnimationFrame`, assert interpolation is scheduled through it
    - _Requirements: 8.1, 8.2, 10.2_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement the Service_Worker State_Diffing_Engine
  - [x] 7.1 Implement `diff(timeline)` producing the State_Map
    - Compute delay/duration offsets between consecutive entries; produce exactly `max(0, N-1)` transitions
    - Extract the easing curve per transition (normalized CubicBezier); extract transform matrix when a transform is present, else `null`
    - Empty/single-entry timelines yield zero transitions
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 7.5_

  - [x]* 7.2 Write property test for diff offsets and transition count
    - **Property 8: Diff offsets and transition count**
    - **Validates: Requirements 3.1, 3.4**

  - [x]* 7.3 Write property test for normalized easing presence
    - **Property 9: Every transition carries a valid normalized easing**
    - **Validates: Requirements 3.2**

  - [x]* 7.4 Write property test for transform-matrix presence
    - **Property 10: Transform matrix present iff a transform is present**
    - **Validates: Requirements 3.3**

- [x] 8. Implement the Animation_Parser and CDP Coordinator
  - [x] 8.1 Implement computed-style/animation extraction and easing normalization
    - `parseComputed(target)` via `window.getComputedStyle`; `parseAnimations(target)` via `target.getAnimations()`
    - `normalizeEasing(value)` maps `{linear, ease, ease-in, ease-out, ease-in-out}` to the fixed cubic-bezier table; unknown values fall back to `linear` and are flagged, never throwing
    - _Requirements: 4.1, 4.2, 4.3_

  - [x] 8.2 Implement CDP Coordinator for pseudo-state freezing
    - Attach the debugger to the active tab and issue `DOM.forcePseudoState` for `:hover`/`:active`
    - While frozen, extract computed metrics even when the pointer is not over the element; on attach/command failure, surface an error and continue with live styles
    - _Requirements: 4.4, 4.5_

  - [x]* 8.3 Write property test for keyword easing normalization
    - **Property 11: Keyword easing normalization correctness**
    - **Validates: Requirements 4.3**

  - [x]* 8.4 Write unit/integration tests for extraction and CDP freeze
    - Mock `getComputedStyle`/`getAnimations()` and assert they are consumed
    - Mock `chrome.debugger`, assert `DOM.forcePseudoState` issued for `:hover`/`:active` and metrics read while frozen without pointer hover
    - _Requirements: 4.1, 4.2, 4.4, 4.5_

- [x] 9. Implement the Reverse_Engineering_Engine
  - [x] 9.1 Implement classifiers and report generation
    - `classifyLayout(computed)`: Flexbox for `flex`/`inline-flex`, Grid for `grid`/`inline-grid`, else Other
    - `classifyDelivery(animations)`: WAAPI when programmatic animations present, else CSS transitions
    - `classifyProperty(prop)`: composite-friendly for `transform`/`opacity`, layout-triggering for `top`/`width`/`margin`
    - `generateReport(...)`: markdown containing layout strategy, delivery method, and per-property performance classification
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x]* 9.2 Write property test for layout classification
    - **Property 12: Layout classification from computed display**
    - **Validates: Requirements 5.1**

  - [x]* 9.3 Write property test for delivery classification
    - **Property 13: Animation delivery classification**
    - **Validates: Requirements 5.2**

  - [x]* 9.4 Write property test for property performance classification
    - **Property 14: Animated-property performance classification**
    - **Validates: Requirements 5.3, 5.4**

  - [x]* 9.5 Write property test for report content
    - **Property 15: Architectural_Report contains the derived facts**
    - **Validates: Requirements 5.5**

- [x] 10. Implement the Export_Payload Assembler
  - [x] 10.1 Assemble code tabs, Figma tokens, and report into the Export_Payload
    - Combine HTML/CSS code tabs, Figma design token array, and the markdown Architectural_Report
    - Emit Figma timing tokens in `cubic-bezier(x1,y1,x2,y2)` string form
    - Keep the assembly pass within the 8ms budget; on overrun return a well-formed (possibly partial) payload and report the overrun
    - _Requirements: 6.1, 6.2, 10.1_

  - [x]* 10.2 Write property test for Export_Payload structural completeness
    - **Property 16: Export_Payload structural completeness**
    - **Validates: Requirements 6.1**

  - [x]* 10.3 Write property test for Figma timing token format/round-trip
    - **Property 17: Figma timing token cubic-bezier format and round-trip**
    - **Validates: Requirements 6.2**

  - [x]* 10.4 Write property test for Export_Payload JSON round-trip
    - **Property 18: Export_Payload JSON round-trip equivalence**
    - **Validates: Requirements 6.4**

  - [x]* 10.5 Write performance test for the 8ms analysis pass
    - Benchmark a representative pass and assert wall-clock completion under 8ms
    - _Requirements: 10.1_

- [x] 11. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Implement messaging fabric and Session Controller wiring
  - [x] 12.1 Implement the Message_Channel client in the Content_Script
    - Use `chrome.runtime.sendMessage` for one-shot commands and a Chrome `Port` for streaming timeline/state chunks
    - _Requirements: 7.6_

  - [x] 12.2 Implement the Session Controller state machine and teardown
    - Implement Idle → Recording → Paused → Stopped transitions; while Paused the observer is disconnected (see next bullet) so no entries are appended
    - When Recording_Status shifts to PAUSED, the content script must call `MutationObserver.disconnect()` immediately to eliminate page processor overhead; when shifted back to RECORDING, the script must instantly create a new observer instance bound to the cached Target_Element
    - On Stop/picker-end, invoke `Mutation_Engine.detach()`, `Picker.deactivate()`, release all listener/observer references (finally-style cleanup), then send the frozen Interaction_Timeline to the Service_Worker
    - _Requirements: 1.8, 10.3, 10.4, 11.3, 11.4, 11.5, 11.6_

  - [x]* 12.3 Write property test for pause/resume observer lifecycle
    - **Property 22: Pause disconnects the observer; resume rebinds a fresh observer**
    - **Validates: Requirements 11.3, 11.4, 11.5**
    - Assert that while Recording_Status is Paused the MutationObserver is disconnected and zero entries are appended to the Interaction_Timeline across interleaved mutations
    - Assert each Paused→Recording transition binds a NEW MutationObserver instance (distinct from any prior instance) bound to the cached Target_Element node

  - [x]* 12.4 Write property test for Session_Controls_State mapping
    - **Property 23: Session_Controls_State mirrors Recording_Status one-to-one**
    - **Validates: Requirements 11.7**
    - Assert the `RecordingStatus` → `SessionControlsState` mapping is total (defined for every canonical status), injective (distinct statuses map to distinct controls states), and never escapes the four canonical states (`IDLE`, `RECORDING`, `PAUSED`, `STOPPED`)

  - [x] 12.5 Wire the Service_Worker message handlers to the analysis pipeline
    - On receiving a timeline, run State_Diffing_Engine → Animation_Parser → Reverse_Engineering_Engine → Export_Payload Assembler, then send `STATE_MAP` and `EXPORT_PAYLOAD` to the Popup_UI
    - _Requirements: 3.4, 7.5, 7.6_

  - [x]* 12.6 Write property test for teardown leaving zero retained resources
    - **Property 21: Teardown leaves zero retained resources**
    - **Validates: Requirements 1.8, 10.3, 10.4**

  - [x]* 12.7 Write integration test for messaging
    - Mock `chrome.runtime`, assert `sendMessage` and `Port` connections carry messages between contexts
    - _Requirements: 7.6_

- [x] 13. Implement iframe / sub-frame injection and exclusion
  - [x] 13.1 Implement all-frames injection and cross-origin exclusion reporting
    - Inject the Content_Script with `chrome.scripting.executeScript` using `allFrames: true`
    - Catch `SecurityError`/access exceptions, exclude inaccessible frames from selection, and emit a `FRAME_EXCLUDED` report per excluded frame
    - _Requirements: 9.1, 9.2_

  - [x]* 13.2 Write property test for cross-origin frame exclusion/reporting
    - **Property 20: Cross-origin sub-frames excluded and reported**
    - **Validates: Requirements 9.2**

  - [x]* 13.3 Write integration test for iframe injection
    - Mock `chrome.scripting.executeScript`, assert it is called with `allFrames: true`
    - _Requirements: 9.1_

- [x] 14. Implement the Popup_UI (React + Vite + Tailwind)
  - [x] 14.1 Implement CodeTabs, EasingTimeline, JsonExportView, FrameNotice, and FeedbackBanner
    - `CodeTabs` toggles HTML/CSS views and includes integrated asynchronous 'Copy to Clipboard' utility icons calling `navigator.clipboard.writeText()` with instant visual success tooltips; `EasingTimeline` visualizes State_Map transitions/easing; `JsonExportView` renders the Export_Payload as formatted JSON on export request; `FrameNotice` surfaces `FRAME_EXCLUDED` reports
    - Add a `FeedbackBanner` component that displays live status updates and permission exceptions (e.g., CDP attachment failures or restricted system pages) dynamically at the top of the interface
    - Render gracefully on partial/missing State_Map or Export_Payload (placeholders, never crash)
    - _Requirements: 6.3, 6.5, 9.2_

  - [x]* 14.2 Write unit/example tests for Feedback_Banner and Copy to Clipboard flows
    - Assert Feedback_Banner is placed at the top of the interface and renders the `User_Feedback_Message` `text` for each `type` (SUCCESS/ERROR/WARN) (Req 12.1, 12.3)
    - Copy to Clipboard success path: mock `navigator.clipboard.writeText`, assert it is called with the displayed code and that inline success feedback is shown for that action (Req 6.6, 6.7)
    - Copy to Clipboard failure path: make `navigator.clipboard.writeText` reject, assert a `User_Feedback_Message` of type `ERROR` is surfaced in the Feedback_Banner (Req 6.9)
    - Restricted/system page path: assert a `User_Feedback_Message` of type `WARN` is surfaced in the Feedback_Banner (Req 12.5)
    - _Requirements: 6.6, 6.7, 6.9, 12.1, 12.3, 12.5_

  - [x] 14.3 Wire the Popup_UI to the Message_Channel and command issuance
    - Subscribe to `STATE_MAP`/`EXPORT_PAYLOAD`/`FRAME_EXCLUDED`; issue start/pause/stop/freeze/export commands to the Service_Worker
    - _Requirements: 6.3, 7.6_

  - [x]* 14.4 Write unit tests for popup composition
    - Assert CodeTabs, EasingTimeline, and JsonExportView render and the JSON view shows the serialized payload
    - _Requirements: 6.3, 6.5_

- [x] 15. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. They are test sub-tasks (property, unit, integration, performance).
- Each task references specific granular requirements for traceability.
- Property tests use fast-check at a minimum of 100 iterations and are tagged with the format `// Feature: ui-motion-grabber, Property {number}: {property_text}`.
- Property sub-tasks are placed immediately after the implementation they validate so errors are caught early.
- Checkpoints provide incremental validation across the three runtime contexts.
- The Content_Script must remain pure Vanilla JS, zero-dependency, and unbundled; heavy transformation lives only in the Service_Worker.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1"] },
    { "id": 2, "tasks": ["3.1", "4.1", "5.1", "7.1", "8.1", "9.1"] },
    { "id": 3, "tasks": ["3.4", "3.5", "8.2", "10.1"] },
    { "id": 4, "tasks": ["3.2", "3.3", "3.6", "3.7", "3.8", "4.2", "4.3", "4.4", "4.5", "5.2", "5.3", "7.2", "7.3", "7.4", "8.3", "8.4", "9.2", "9.3", "9.4", "9.5", "10.2", "10.3", "10.4", "10.5"] },
    { "id": 5, "tasks": ["12.1", "12.2", "13.1"] },
    { "id": 6, "tasks": ["12.3", "12.4", "12.5", "12.6", "12.7", "13.2", "13.3"] },
    { "id": 7, "tasks": ["14.1"] },
    { "id": 8, "tasks": ["14.2", "14.3", "14.4"] }
  ]
}
```

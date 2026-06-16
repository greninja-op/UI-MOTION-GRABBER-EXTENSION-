# UI MOTION GRABBER: CODE GENERATION STEERING LAWS

## [PROJECT CONTEXT]

- **Project Name:** UI Motion Grabber
- **Target Spec:** Chromium Extension Manifest V3
- **Core Architecture:** 100% local, open-source, zero-dependency engineering tool that reverse-engineers live website micro-interactions, states, and animation curves, outputting clean HTML/CSS code, Figma design tokens, and architectural breakdowns.

## [CRITICAL INJECTED CORE RULES (content.js)]

1. **ZERO DEPENDENCIES:** Write only pure Vanilla JS inside injected content layers. No npm/bundling requirements.
2. **HIGHLIGHTING HOOKS:** Implement target highlighting overlays during picker-mode without changing the element's inline `style` attributes. Use isolated class listing (e.g., `.kinetic-hover-node`).
3. **COMPONENT INTERCEPTION:** Capture mouse events via capture-phase listeners (`capture: true`) using `stopPropagation()` and `preventDefault()` to freeze host-site link traversal on click.

## [MUTATION OBSERVER GUARD MATRIX]

1. **ISOLATION:** Never assign a MutationObserver to the global `document` or `body`. Bind it strictly to the locked element node.
2. **FILTERING:** Use a strict `attributeFilter` restricted to `["class", "style"]` to completely ignore analytics or text updates.
3. **16MS DEBOUNCE LOOP:** Check timestamps via `performance.now()`. If mutations occur within < 16ms of each other, drop calculation loops to prevent infinite rendering cycles and browser tab freezes.
4. **STRUCTURAL SIGNATURES:** Store a combined string of `target.className + target.style.cssText`. If an incoming mutation matches the cached string signature, drop execution immediately.

## [ARCHITECTURAL REVERSE-ENGINEERING ENGINE]

1. **STRATEGY ANALYSIS:** Analyze target elements to detect layout structures (e.g., Flexbox vs Grid) and animation delivery (e.g., Web Animations API vs Pure CSS transitions).
2. **PERFORMANCE AUDITING:** Inspect computed properties to identify performance triggers. Specifically check if layout shifts modify composite properties (`transform`, `opacity`) or heavy layout geometry properties (`top`, `width`, `margin`).
3. **EDUCATION BREAKDOWN GENERATION:** Package these findings into a concise, readable text report explaining to the user exactly "how the component was made" and the optimization decisions behind its layout structure.

## [ANIMATION PARSING MECHANICS]

1. **DYNAMIC STYLES:** Extract styling variables via `window.getComputedStyle(targetElement)`.
2. **JS ANIMATION OVERLAY:** Check running programmatic frames by querying the Web Animations API directly: `element.getAnimations()`.
3. **INTERACTION FREEZING:** Utilize Chrome DevTools Protocol structures (`DOM.forcePseudoState`) when requested to freeze elements in fixed pseudo-states (`:hover`, `:active`) during panel tracking.
4. **NORMALIZATION:** Convert shorthand text values (e.g., `ease-in-out`) to explicit `cubic-bezier(x1, y1, x2, y2)` formats automatically inside data transmission wrappers.

## [DATA FORMAT REQUIREMENT]

All exported payloads must align cleanly to a structured JSON data model containing code tabs, Figma variables, and the architectural report string. Maintain synchronous background line messaging using `chrome.runtime.sendMessage`.

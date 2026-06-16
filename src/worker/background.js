// UI Motion Grabber — Service_Worker (background.js)
// Manifest V3 background, registered with `type: "module"`.
// Excludes the `getBackgroundPage` API and any `background.scripts` array.
//
// This is the Service_Worker entry point. It installs the Message_Channel
// handlers that wire the analysis pipeline to the rest of the extension:
//
//   On a Recording_Session's frozen Interaction_Timeline (streamed as
//   TIMELINE_CHUNK over a Port and finalized by a SESSION_STOP command from the
//   Content_Script), the worker runs:
//
//     State_Diffing_Engine -> Animation_Parser -> Reverse_Engineering_Engine
//     -> Export_Payload Assembler
//
//   then sends STATE_MAP and EXPORT_PAYLOAD envelopes to the Popup_UI over
//   `chrome.runtime.sendMessage` (Req 3.4, 7.5, 7.6).
//
// All orchestration and routing logic lives in the testable ES modules
// `analysis-pipeline.ts` and `service-worker.ts`; this entry only binds them to
// the ambient `chrome` messaging surface.

import { installServiceWorker } from "./service-worker.ts";

// Install the message handlers against the ambient `chrome` runtime. Guarded so
// the module can still be imported in non-extension contexts without throwing.
if (typeof chrome !== "undefined" && chrome.runtime) {
  installServiceWorker();
}

export { installServiceWorker };

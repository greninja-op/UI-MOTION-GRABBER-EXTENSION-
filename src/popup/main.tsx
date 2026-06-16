/**
 * Popup_UI React entry point.
 *
 * Mounts the App into the `#root` element declared in index.html. The popup is
 * the only bundled runtime context (React + Vite + Tailwind). Message_Channel
 * subscription and command issuance are wired in task 14.3; this entry only
 * renders the presentational composition.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

const container = document.getElementById("root");

if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

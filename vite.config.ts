/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Vite build configuration for the React + Tailwind Popup_UI.
//
// The Popup_UI is the only bundled runtime context in UI Motion Grabber. The
// Content_Script (content.js) stays pure, unbundled Vanilla JS and is therefore
// intentionally excluded from this build (Requirement 7.3). The Service_Worker
// is a module-type background script handled outside the popup bundle.
//
// The popup entry HTML lives at src/popup/index.html (created by the project
// scaffold task). This config wires React + Tailwind for that entry and points
// Vitest at the test suite.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "src/popup/index.html"),
      },
    },
  },
  test: {
    // jsdom gives React component tests and DOM-oriented property tests a DOM.
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}", "tests/**/*.{test,spec}.{ts,tsx}"],
  },
});

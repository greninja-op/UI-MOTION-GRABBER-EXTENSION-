/** @type {import('tailwindcss').Config} */
export default {
  // Scan the Popup_UI sources for Tailwind class usage. The Content_Script and
  // Service_Worker do not use Tailwind, so they are deliberately not scanned.
  content: ["./src/popup/**/*.{ts,tsx,html}"],
  theme: {
    extend: {},
  },
  plugins: [],
};

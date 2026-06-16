// Packaging build for the UI Motion Grabber MV3 extension.
//
// Produces a loadable `dist/` directory:
//   - dist/content.js     bundled Content_Script (IIFE, no ES imports — classic
//                         content scripts cannot use module imports)
//   - dist/background.js  bundled Service_Worker (ESM module worker)
//   - dist/popup.js       bundled Popup_UI (React, IIFE)
//   - dist/popup.css      Tailwind-compiled popup styles
//   - dist/popup.html     popup entry referencing popup.css + popup.js
//   - dist/manifest.json  manifest rewritten to point at the built files
//
// Run with: node scripts/build-extension.mjs   (or: npm run build:ext)

import esbuild from "esbuild";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const TARGET = ["chrome116"];

/** Drop `.css` imports from JS bundles (CSS is compiled separately by Tailwind). */
const ignoreCssPlugin = {
  name: "ignore-css",
  setup(build) {
    build.onResolve({ filter: /\.css$/ }, (args) => ({
      path: args.path,
      namespace: "ignore-css",
    }));
    build.onLoad({ filter: /.*/, namespace: "ignore-css" }, () => ({
      contents: "",
      loader: "js",
    }));
  },
};

async function run() {
  // 1. Clean output.
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  // 2. Bundle the Content_Script as a classic IIFE (no module imports survive).
  await esbuild.build({
    entryPoints: [join(root, "src/content/content.js")],
    outfile: join(dist, "content.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: TARGET,
    legalComments: "none",
  });

  // 3. Bundle the Service_Worker as an ESM module worker.
  await esbuild.build({
    entryPoints: [join(root, "src/worker/background.js")],
    outfile: join(dist, "background.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: TARGET,
    legalComments: "none",
  });

  // 4. Bundle the Popup_UI (React) as an IIFE; CSS imports are dropped here and
  //    compiled separately by Tailwind in step 5.
  await esbuild.build({
    entryPoints: [join(root, "src/popup/main.tsx")],
    outfile: join(dist, "popup.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: TARGET,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [ignoreCssPlugin],
    legalComments: "none",
  });

  // 5. Compile Tailwind CSS for the popup.
  const tailwindBin =
    process.platform === "win32"
      ? "node_modules\\.bin\\tailwindcss.cmd"
      : "node_modules/.bin/tailwindcss";
  execSync(
    `"${tailwindBin}" -i ./src/popup/index.css -o ./dist/popup.css --minify`,
    { cwd: root, stdio: "inherit", shell: true },
  );

  // 6. Emit the popup HTML entry pointing at the built assets.
  const popupHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>UI Motion Grabber</title>
    <link rel="stylesheet" href="popup.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="popup.js"></script>
  </body>
</html>
`;
  writeFileSync(join(dist, "popup.html"), popupHtml, "utf8");

  // 7. Rewrite the manifest to point at the built files.
  const manifest = JSON.parse(
    readFileSync(join(root, "manifest.json"), "utf8"),
  );
  manifest.background.service_worker = "background.js";
  manifest.action.default_popup = "popup.html";
  manifest.content_scripts = manifest.content_scripts.map((cs) => ({
    ...cs,
    js: ["content.js"],
  }));
  writeFileSync(
    join(dist, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );

  console.log("Extension packaged into dist/ — load it unpacked in Chrome.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

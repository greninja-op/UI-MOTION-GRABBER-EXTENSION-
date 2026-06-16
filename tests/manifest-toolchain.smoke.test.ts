// Smoke / static checks for the MV3 manifest and the Popup_UI toolchain.
//
// These are intentionally NOT property-based tests. They read the on-disk
// manifest.json, package.json, and build configs and assert the project is
// wired the way the spec mandates, then statically scan the injected runtime
// source (Content_Script + Service_Worker) for forbidden network/legacy APIs.
//
// Validates: Requirements 7.1, 7.2, 7.3, 7.7, 7.8

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Vitest runs with the project root as cwd, so config/manifest files resolve
// relative to it.
const root = process.cwd();
const read = (relPath: string): string =>
  readFileSync(resolve(root, relPath), "utf8");
const readJson = (relPath: string): Record<string, unknown> =>
  JSON.parse(read(relPath)) as Record<string, unknown>;

// Strip line (`//...`) and block (`/* ... */`) comments so the static scan
// flags only real code usage, not documentation that names a forbidden API in
// order to declare it excluded.
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("MV3 manifest configuration (Req 7.1, 7.2, 7.7)", () => {
  const manifest = readJson("manifest.json");

  it("declares Manifest V3 (Req 7.1)", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("registers a module-type background service worker (Req 7.1)", () => {
    const background = manifest.background as Record<string, unknown>;
    expect(background).toBeTypeOf("object");
    expect(typeof background.service_worker).toBe("string");
    expect(background.service_worker as string).toMatch(/\.js$/);
    expect(background.type).toBe("module");
  });

  it("excludes the legacy background.scripts array (Req 7.2)", () => {
    const background = manifest.background as Record<string, unknown>;
    expect(background).not.toHaveProperty("scripts");
  });

  it("requests only activeTab, scripting, and debugger permissions (Req 7.7)", () => {
    const permissions = manifest.permissions as string[];
    expect(Array.isArray(permissions)).toBe(true);
    expect([...permissions].sort()).toEqual(
      ["activeTab", "debugger", "scripting"],
    );
  });
});

describe("Popup_UI toolchain: React + Vite + Tailwind (Req 7.4)", () => {
  const pkg = readJson("package.json");
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
  const allDeps = { ...deps, ...devDeps };

  it("declares React for the popup", () => {
    expect(allDeps).toHaveProperty("react");
    expect(allDeps).toHaveProperty("react-dom");
  });

  it("declares Vite (and the React plugin) for the popup build", () => {
    expect(allDeps).toHaveProperty("vite");
    expect(allDeps).toHaveProperty("@vitejs/plugin-react");
  });

  it("declares Tailwind CSS for the popup", () => {
    expect(allDeps).toHaveProperty("tailwindcss");
  });

  it("wires the Vite build to React and the popup entry HTML", () => {
    const viteConfig = read("vite.config.ts");
    expect(viteConfig).toContain("@vitejs/plugin-react");
    expect(viteConfig).toContain("src/popup/index.html");
  });

  it("points the Tailwind content scan at the popup sources", () => {
    const tailwindConfig = read("tailwind.config.js");
    expect(tailwindConfig).toContain("./src/popup/");
  });
});

describe("Static scan of injected runtime source (Req 7.3, 7.8, 7.2)", () => {
  // The Content_Script and Service_Worker are the only contexts that could
  // perform network egress or touch legacy background APIs.
  const sources: Array<{ label: string; path: string }> = [
    { label: "Content_Script", path: "src/content/content.js" },
    { label: "Service_Worker", path: "src/worker/background.js" },
  ];

  for (const { label, path } of sources) {
    const source = stripComments(read(path));

    it(`${label} performs no fetch() network calls (Req 7.8)`, () => {
      expect(source).not.toMatch(/\bfetch\s*\(/);
    });

    it(`${label} uses no XMLHttpRequest (Req 7.8)`, () => {
      expect(source).not.toMatch(/\bXMLHttpRequest\b/);
    });

    it(`${label} contains no external http(s) URLs (Req 7.8)`, () => {
      expect(source).not.toMatch(/https?:\/\//);
    });

    it(`${label} never uses the legacy getBackgroundPage API (Req 7.2)`, () => {
      expect(source).not.toMatch(/\bgetBackgroundPage\b/);
    });
  }
});

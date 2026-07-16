import { resolve } from "node:path";

import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// `externalizeDepsPlugin` externalizes everything in package.json `dependencies`
// and bundles everything in `devDependencies`. That split is deliberate and
// load-bearing:
//
//   dependencies     → @julusian/midi ONLY. It is an N-API CoreMIDI binding that
//                      locates its prebuilt binary at runtime relative to its own
//                      package directory (via pkg-prebuilds). Bundling it breaks
//                      that lookup — and only in the packaged app, never in dev.
//                      electron-builder ships `dependencies` into the asar, and
//                      electron-builder.yml unpacks this one so the .node file
//                      exists on a real filesystem path.
//   devDependencies  → everything else, including @tonejs/midi (pure JS MIDI
//                      *parsing*, no native code) and the whole renderer stack.
//                      These get bundled into out/ and are not shipped as
//                      node_modules.
//
// Re-check this after any dependency bump. See CLAUDE.md → Conventions.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
        // This package is `"type": "module"`, so a `.js` preload would be
        // treated as ESM — which Electron refuses to load as a preload script.
        // Emit CommonJS with an explicit `.cjs` extension instead. The path here
        // must stay in sync with `webPreferences.preload` in src/main/index.ts.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer"),
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
  },
});

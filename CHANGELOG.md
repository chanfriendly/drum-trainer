# Changelog

Technical record of what was done, decided, and discovered. Why, not just what.
Most recent first.

---

### 2026-07-16: Scaffold — Electron skeleton, MIDI service, storage services

**Built.** `electron-vite` + `electron-builder` scaffold; main-process
bootstrap with the load-bearing ordering (privileged scheme at module scope →
forced dark → protocol + IPC handlers → window); `song-audio://` protocol;
MIDI, library, results, and chart services; the `contextBridge` preload; and a
throwaway smoke-test renderer that enumerates MIDI devices. Type-check clean;
all three bundles build.

**Verified, and how.**

- *The native addon loads under Electron 43* — probed headlessly
  (`npx electron probe.cjs`), printed `PROBE_OK`. This confirms the N-API
  prebuild is ABI-compatible with Electron and settles that no
  `electron-rebuild` step is needed.
- *The externalization split works* — `out/main/index.js` contains a bare
  `import { Input } from "@julusian/midi"` (externalized, resolved at runtime)
  while `@tonejs/midi` is bundled inline. This is the exact split the
  `dependencies` vs `devDependencies` layout is designed to produce.
- *NOT verified:* device enumeration against real hardware. The probe reported
  `PROBE_PORTS 0` — no e-kit is connected. The addon loading and the addon
  finding a real kit are different claims; only the first is established.

**Preload must be CommonJS.** The package is `"type": "module"`, so a `.js`
preload is treated as ESM, which Electron refuses to load as a preload script.
The preload build is pinned to `format: "cjs"` with `entryFileNames:
"[name].cjs"`, and `webPreferences.preload` points at `index.cjs`. These two
must stay in sync; a mismatch produces a window with no `window.drumTrainer`
and no obvious error.

**Range support is required for the audio protocol, and was not free.** Glaze's
`protocol.createFileResponse({root})` handled byte ranges and path containment;
Electron has no equivalent. Both are now implemented explicitly in
`src/main/protocol/song-audio.ts`. Without a 206 + `Content-Range` response the
`<audio>` element cannot seek — gameplay would play from 0:00 and silently fail
to scrub, which is a hard bug to attribute back to a protocol handler.

**Bug found in the reference implementation, fixed in the port.** The Glaze
`midi-service` commented that "Input has no explicit destroy" and let its
enumeration probe fall to GC. `@julusian/midi` 3.6.1 does expose `destroy()` —
so every `listDevices()` call leaked a CoreMIDI client until GC ran, and the
Settings screen enumerates on every open. The port destroys the probe (and the
open port) explicitly. Worth re-checking whether the old comment was ever true
of an earlier version, but it is not true of the pinned one.

**Other deltas from the reference.** `app.getPath` is synchronous in Electron,
so the cached-promise indirection around the songs root is gone. `DrumType` was
declared twice in the Glaze tree (renderer and results-service); it is unified
in `src/shared/types.ts` so the two cannot drift. Import now parses the MIDI
*before* copying any audio and rolls back the song directory on failure — the
original could leave a partial `songs/<id>/` behind on a mid-import error.
Chart parsing and difficulty are split into `services/chart.ts` so they can be
tested without Electron.

---

### 2026-07-16: Project initialized — Glaze → standalone Electron

**What this is.** A rebuild of Drum Trainer, previously built on the Glaze
macOS app framework, as a self-contained Electron app that packages to a
launchable `.dmg`. The prior build lives at
`~/Library/Application Support/app.glaze.macos.main/apps/drum-trainer-local-2qhmrebi/.glaze-sources`
(~4,300 lines) and is the reference implementation, not a dependency.

**Motivation.** The Glaze build only runs inside the Glaze host app. The goal is
a normal macOS application: double-clickable, installable from a `.dmg`,
independent of any host runtime.

**What ports cleanly vs. what has to be replaced.** The domain logic is
framework-agnostic and transfers nearly intact: the MIDI service, library and
results services, the `@tonejs/midi` chart parser, the difficulty calculation,
the canvas gameplay loop, and the tuned scoring formulas. What Glaze supplied
and this repo must now own explicitly:

| Glaze provided | Replacement |
| --- | --- |
| `@glaze/core/backend` (window bootstrap, `logger`, async `app.getPath`) | Plain Electron `app`/`BrowserWindow`/`nativeTheme`; a local logger; **synchronous** `app.getPath` |
| `@glaze/core/ipc` (JSON-RPC transport, `ipcMain.broadcast`) | `ipcMain.handle` + `webContents.send`, exposed through a `contextBridge` preload |
| `@glaze/core/components` (design system) | Local Tailwind components in `renderer/components/ui/` |
| `@glaze/core/build` + `glaze.config.ts` (`externalizePackage`) | `electron.vite.config.ts` `externalizeDepsPlugin` + electron-builder `asarUnpack` |
| `protocol.createFileResponse` | Electron `protocol.handle` + `net.fetch(pathToFileURL(...))` |

**Decisions made at bootstrap** (user-confirmed):

- *Port the logic, hand-roll the UI in Tailwind* — rather than rebuilding from
  the spec or adopting shadcn/ui. The gameplay canvas is already
  component-free, and ~2,000 lines of tuned, working view logic is not worth
  re-deriving. Rejected a fresh rebuild because the risk sits in timing and
  MIDI, which a rebuild does not de-risk and does re-expose. Rejected shadcn/ui
  as dependency weight for an app with five screens.
- *Unsigned `.dmg`* — no Apple Developer account in play, and this is a
  personal-use app. Gatekeeper is handled with a one-time quarantine removal.
  Notarization is the upgrade path if the app is ever handed to another person.
- *Own git repo in `drums/`* — `~/Documents` is itself a git repo, so the
  project was `git init`'d as a nested, self-contained repo rather than
  committed into the Documents history. Relevant if the project is ever
  published.

**Toolchain chosen.** electron-vite (renderer HMR + main/preload builds in one
config) plus electron-builder (`.dmg` target). Rejected Electron Forge —
electron-vite has the more direct story for externalizing a native addon, which
is the single riskiest part of this build. Kept from the Glaze stack: React 19,
TanStack Router (switched to hash history, since `file://` has no server to
resolve real paths), TanStack Query, Tailwind v4, `@tonejs/midi`,
`@julusian/midi`.

**Discovered while inspecting.** `@julusian/midi` ships **N-API** prebuilds
(`prebuilds/midi-darwin-arm64`), so the binary is ABI-stable across Node and
Electron — no `electron-rebuild` step is needed. The requirement is purely that
the package is externalized and unpacked from the asar so `pkg-prebuilds` can
find the binary relative to its own package directory at runtime.

**Carried forward from the Glaze build's known gaps.** That build's
`NEXT-STEPS.md` recorded that forced-dark appearance and full gameplay with a
real kit were validated by code review rather than a cold launch, because the
dev session never cold-restarted. Those remain unverified and are seeded into
`PROGRESS.md` rather than assumed working.

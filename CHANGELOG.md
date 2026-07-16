# Changelog

Technical record of what was done, decided, and discovered. Why, not just what.
Most recent first.

---

### 2026-07-16: Practice Groove — a test song with known ground truth

**Problem.** Every real audio+MIDI pair has unknown alignment, so a failure is
ambiguous: is the code wrong, or do the files simply not line up? With only the
Queen pair (which is known NOT to align) there was no way to answer that. Asked
to find a good example song, the right move was to generate one rather than hunt
for a licensed pair — matched pairs of commercial music barely exist, since the
audio is a recording and the MIDI is someone's transcription.

**What.** `assets/practice-groove/` — a 316-note, 61.2s, 100bpm chart, plus
audio **rendered from that same note list**, sample-accurate. True alignment is
therefore known: offset 0, tempoScale 1. This is the project's oracle. Original
content, so it is committed, unlike the Queen pair.

**It paid for itself immediately.** Estimator vs. known truth: **-6.3ms error,
scale 1.00000, confidence 4.78** (the Queen pair scores 2.06). The 6.3ms
residual is sub-frame quantization — a frame is 11.6ms. Without the `FRAME_LEAD`
correction the same test reads ~-35ms; no self-consistent test could have caught
that, because the bias applies equally to every candidate alignment.

**Deliberate properties, each earned:**

- *All six lanes* (kick 60, snare 50, hat 128, ride 56, tom 17, crash 5). The
  Queen chart only uses kick/snare/hat and could never surface a tom/crash/ride
  bug. Round-trips through the real parser at 100% mapped, difficulty Hard.
- *Structure, not a loop* — section changes, a 16th tom fill, a near-silent
  break. A uniform loop is inherently ambiguous to align (see the bar-ambiguity
  finding); this gives the estimator something unique to lock onto.
- *FLAC, not mp3.* mp3/AAC carry ~13-26ms of encoder delay — the same order as
  the ±25ms Perfect window, and precisely the class of silent systematic bias
  that FRAME_LEAD already cost real time. Lossless keeps the ground truth true.
  1.9MB, small enough to commit.
- *Deterministic* — the synth is seeded, so regeneration is byte-identical.
- *No soundfont/fluidsynth* (neither installed): the kit is synthesised from
  sine sweeps and filtered noise in numpy. Sharp transients are what onset
  detection and a drummer's ear need; fidelity is beside the point.

**Test-only ffmpeg.** Decoded PCM is regenerable, so it's gitignored;
`npm run test:fixtures` rebuilds it. The app needs nothing installed — it
decodes with Web Audio.

18 alignment tests pass, now including two against known truth.

---

### 2026-07-16: Per-song chart↔audio alignment (spec change)

**The spec was wrong, and real data proved it.** BUILD-PROMPT models a song as
"an audio file + MIDI file pair" with a single global latency offset for
hardware lag. That assumes the two files share a time base. They don't, unless
both come from the same master — and a MIDI transcription paired with a
commercial recording never does.

**Measured on the first real pair** (Another One Bites the Dust, user-supplied
mp3 + MIDI):

- The MIDI is a rigid **110.000 bpm** grid, single tempo event, no changes.
- The recording runs at **~109.68 bpm** and is not perfectly steady.
- The chart therefore walks ~3ms further out of sync per second — **~600ms**
  across the song.
- With a constant offset tuned to the intro, **7 of 11 twenty-second windows
  fall outside the ±100ms edge window: ~64% of the song auto-Misses**, no matter
  how well the player drums.

The failure mode is what makes this worth a spec change: it doesn't look like a
bad file, it looks like *broken judging*. It would have sent a future session
debugging the scoring code, which would have been correct all along.

**Change.** `SongMeta` gains `alignment: {offsetMs, tempoScale, source,
confidence}`, persisted per song, applied as
`audioTime = chartTime * tempoScale + offsetMs/1000`. New IPC:
`songs:setAlignment`. `settings.latencyOffsetMs` is untouched and keeps its
original meaning — hardware/IPC lag, global. **The two are deliberately
separate**: merging them would make calibrating the kit corrupt every song.

**The estimator lives in the renderer** (`renderer/lib/alignment.ts`), because
Web Audio's `decodeAudioData` decodes mp3/m4a/flac with no native dependency.
Doing it in main would mean shipping an audio decoder or depending on ffmpeg,
which cannot be assumed present in a packaged app. Import therefore writes
`source: "none"` and the renderer fills alignment in later.

**Two findings from building it, both counter-intuitive:**

1. *A ~35ms systematic bias, found by a synthetic test.* An FFT frame starting
   at sample `f*HOP` is centered half a window later, and flux compares frame
   i+1 to i, so the envelope's time base LEADS true onsets by exactly
   `1 + N_FFT/(2*HOP)` = 3 frames. Measured: -3.13 frames for a click at t=1.0s.
   Uncorrected this biases every estimated offset by more than the ±25ms Perfect
   window. Fixed via `FRAME_LEAD`; pinned by a regression test.

2. *`offsetMs` is fundamentally ambiguous by whole bars.* A groove looks
   identical shifted one bar, so the correlator cannot distinguish them. An
   independent numpy implementation found offset +3.383s/scale 0.99711 while the
   TypeScript found +8.704s/scale 0.99780 — different optima, both confident.
   **`tempoScale` is well-determined** (drift is punished across the whole song);
   the bar is not. So auto-align must be a *suggestion* the player confirms by
   ear, with a ±1 bar nudge — never a silent auto-apply. Attempting to
   disambiguate with musical landmarks (a silent break, a dense fill) does NOT
   work with the current metric: `score()` is the mean envelope strength at note
   positions, and a beat-shifted chart still lands most notes on real hits, so a
   few landmark notes barely move the average. Changing the metric to penalise
   *unmatched audio onsets* is the upgrade path.

**Tests.** 16 passing in `tests/alignment.test.ts`, including two against the
real song (skipped unless the local fixture exists — the song is copyrighted and
not committed). The real-song tests assert only what two independent
implementations agree on: tempo mismatch and confidence, never the exact offset.

**Still open:** nothing applies the alignment yet — gameplay doesn't exist. The
estimate is also not yet run anywhere; the renderer needs to call it and offer
the confirm/nudge UI.

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

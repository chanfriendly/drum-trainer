# Drum Trainer

A Rock Band-style rhythm trainer for electronic drum kits, as a native macOS app.
It plays a song's audio while scrolling that song's MIDI drum chart down six
vertical lanes, listens to a real e-kit over CoreMIDI, and scores hit timing in
real time.

**What it is not:** it does not generate charts from audio (the MIDI file is the
only source of notes), it has no light mode, and it is not a general MIDI editor
or a DAW. It is a single-user, local-only practice tool.

Deeper context: `PROGRESS.md` (current state — read first), `CHANGELOG.md`
(what was decided and why), `scripts/eval/README.md` (drum-transcription
measurements and the plan for generating charts from audio).

## Quick reference

```bash
npm install              # first run only
npm run dev              # electron-vite dev — hot reload for renderer, restart for main
npm run type-check       # tsc --noEmit across main, preload, renderer
npm run test             # vitest (pure functions only — see Principles)
npm run test:fixtures    # decode test audio to PCM (needs ffmpeg; test-only)
npm run build            # type-check + compile main/preload/renderer to out/
npm run dist:mac         # build + package an unsigned .dmg into release/
```

`assets/practice-groove/` is the test song: audio rendered from its own chart,
so its true alignment is known (offset 0, scale 1). It is the project's ORACLE —
use it whenever you need to tell "the code is wrong" apart from "that file pair
doesn't line up". Read its README before changing it.

**But it is an optimistic upper bound.** Synthetic isolated hits, no bleed, no
artifacts. A transcriber scoring 51% on it scored 8.7% on real separated drums.
Never report a result measured only on practice-groove as if it generalises;
check a real recording too. See `scripts/eval/README.md`.

There is no lint script yet — ESLint is not set up. Don't advertise commands
that don't run; add it and this line changes.

The packaged `.dmg` is unsigned. First launch on any machine needs
`xattr -d com.apple.quarantine "/Applications/Drum Trainer.app"` or a
right-click → Open. That is expected, not a bug.

## Session orientation

Every session, in this order:

1. **Read `PROGRESS.md` first.** It is the current-state document. Everything
   else in this file is stable background; PROGRESS.md is what changed.
2. **Run `npm run type-check` and `npm run test`.** 74 tests cover the pure
   logic — alignment, judging, calibration, chart shape — which is genuinely
   most of the maths. What they cannot cover is feel (see Principles: the oracle
   is hardware). Both must be clean before you start and before you stop.
3. **Pick the top unchecked item in "What's next"** unless the user says
   otherwise. If the top item is blocked, say so rather than silently skipping
   to item two.
4. **Before stopping:** update `PROGRESS.md` (status, done, next, and anything
   that failed), add a `CHANGELOG.md` entry if you decided or discovered
   something a future session would otherwise re-derive, and leave the tree
   type-clean.

## Principles

**The oracle is a real e-kit and the user's ears — not a test suite.**
Timing, latency, and judgment feel cannot be verified by assertion. A test can
prove `judge(-30ms) === "early"`; it cannot prove that a Perfect *feels* like a
Perfect when a human hits a pad. So: pure functions (chart parsing, difficulty,
accuracy/score math, judgment bucketing) get real tests and must be provably
correct; everything touching CoreMIDI, audio sync, or canvas timing gets
validated by cold-launching the app with hardware connected. Never report
timing work as "done" on the strength of a type check. Say what you verified
and what you didn't.

**The audio element is the only clock.** All judging happens in the renderer by
comparing `audioEl.currentTime` (read at the instant a note-on arrives, minus
`latencyOffsetMs`) against chart note times. The backend's `performance.now()`
timestamp travels with the event for diagnostics but is **never** compared to
audio time — the two clocks have no shared origin. Every source of lag (IPC
hop, CoreMIDI buffering, kit-internal delay, audio output latency) is absorbed
by the single calibration offset. When latency looks wrong, fix the offset or
the renderer's clock read. Do not "correct" backend timestamps; that
double-counts the error and desyncs calibration from gameplay.

**Cold-launch to verify anything the main process owns.** Dev-mode reload does
not re-run main-process code reliably. Forced dark theme, protocol
registration, MIDI device open/close, and menu wiring can all look right in the
source and be wrong in the shipped app. If a change touches `src/main/`,
verify it against `npm run build && npm run dist:mac` or at minimum a fresh
`npm run dev`, not a hot reload.

**Verify, don't guess — the failure modes here are silent.** An unmapped MIDI
note, a mis-registered protocol scheme, and a chart parsed from the wrong track
all fail quietly: the app runs, the screen renders, and the scoring is simply
wrong. When you are unsure whether a note is arriving, log it and look. When
unsure whether the chart is right, print the first ten notes and compare
against the MIDI file. Guessing costs a full hardware-validation cycle to
discover.

**Keep work small and reversible.** Commit at each working screen or service,
not at the end of a rebuild. The gameplay loop, judging, and calibration are
mutually entangled — if all three change in one commit and timing feels off,
there is nothing to bisect. One concern per commit; the tree launches at every
commit.

**Document for the next session, not for posterity.** `PROGRESS.md` answers
"what do I do right now"; `CHANGELOG.md` answers "why is it like this".
Neither is a narrative of what you did. A decision reversed later belongs in
the changelog with its reason; a task finished belongs in PROGRESS.md as a
checkbox with a date. If it will not change a future action, do not write it.

**Manage context: logs go to files, not stdout.** Electron main-process output
plus Vite plus the renderer console will flood a session. Route diagnostic
output to `logs/` and read it with `grep`/`tail` rather than streaming
everything back. Never paste a full MIDI event stream into the transcript —
summarize it (count, range, unmapped notes) instead.

## Architecture

Standard Electron three-process split. No framework SDK — everything the Glaze
build got for free is now explicit and lives in this repo.

```
src/
  main/                     # Node — no DOM, no React
    index.ts                # bootstrap: handlers + protocol BEFORE window, dark theme, menu, quit cleanup
    ipc/                    # ipcMain.handle registrations, thin validation, delegate to services
    services/
      midi-service.ts       # CoreMIDI via @julusian/midi — list/open/close, note-on listener
      library-service.ts    # import (copy audio + parse MIDI + difficulty), list, get, delete
      results-service.ts    # per-song history JSON, newest first
    protocol/
      song-audio.ts         # song-audio:// — streams audio from userData, Range-capable
  preload/
    index.ts                # contextBridge: the ONLY main↔renderer surface
  renderer/
    lib/                    # drums.ts (labels/colors/default mapping), settings.ts, types.ts
    components/ui/          # local Tailwind components (replaces the Glaze design system)
    views/                  # library, gameplay, results, settings, calibration
    router.tsx              # MEMORY history — no URL bar exists, so a URL is pure overhead
```

**Bootstrap order is load-bearing.** `protocol.registerSchemesAsPrivileged`
must run at module scope (before `app.whenReady`), `protocol.handle` and the
IPC handlers must run before the first `BrowserWindow` is created, and
`nativeTheme.themeSource = "dark"` must be set before the window exists or the
first paint flashes light.

**IPC surface** (keep in sync with `src/preload/index.ts`):

| Channel | Direction | Shape |
| --- | --- | --- |
| `midi:listDevices` | invoke | → `{index, name}[]` |
| `midi:openDevice` | invoke | `(index)` → `{ok, index}` |
| `midi:closeDevice` | invoke | → `{ok}` |
| `midi:getOpenDevice` | invoke | → `number \| null` |
| `midi:note` | broadcast | → `{note, velocity, status, timestamp}` |
| `songs:import` | invoke | `({audioPath, midiPath, name?})` → `SongMeta` |
| `songs:list` | invoke | → `SongMeta[]` |
| `songs:get` | invoke | `(id)` → `SongWithChart` |
| `songs:delete` | invoke | `(id)` → `{ok}` |
| `songs:setAlignment` | invoke | `({id, alignment})` → `SongMeta` |
| `dialog:pickAudio` / `dialog:pickMidi` | invoke | → `string \| null` |
| `results:list` | invoke | `(songId)` → `SongResult[]` |
| `results:save` | invoke | `(input)` → `SongResult` |
| `nav:goto` | broadcast | → path string (menu → route) |

Audio is **not** on this list deliberately — it is served over
`song-audio://audio?id=<id>&file=<name>`. Audio bytes never cross IPC.

**Storage.** Main process, under `app.getPath("userData")`:
`songs/<id>/` holds the copied audio file, `song.json` (metadata +
`chart: {time, midiNote, velocity}[]`), and `results.json` (`SongResult[]`,
newest first). Renderer, in `localStorage` under `drumTrainer.settings`:
`{midiMapping, hitWindows: {perfectMs, goodMs, edgeMs}, latencyOffsetMs,
selectedDeviceIndex}`.

## Conventions

**Charts store raw General MIDI note numbers; lanes are assigned at judge
time.** A chart note is `{time, midiNote, velocity}` — never a lane. The
renderer buckets notes into the six lanes through the user-editable mapping, so
remapping a drum never requires re-importing a song. **Unmapped notes are
excluded from totals entirely** — they are not misses. Scoring an unmapped note
as a miss would punish the player for the app's ignorance of their kit.

**The scoring formulas are tuned values, not incidental code.** Do not
"simplify" them.

- Accuracy = `(perfect·1 + good·0.6 + (early + late)·0.3) / totalNotes × 100`
- Score = base (Perfect 100 / Good 60 / Early|Late 30) × `(1 + combo/25)`

**There are TWO different time corrections. Never merge them.**

- `settings.latencyOffsetMs` — GLOBAL, one value for the whole app, from
  calibration. It models *hardware/IPC lag*: your kit, CoreMIDI, the audio
  output path.
- `song.alignment` (`{offsetMs, tempoScale}`) — PER SONG. It models *the file
  pair*: where the chart sits in the recording and whether the MIDI's tempo
  matches it. Needed because a MIDI transcription and a commercial recording
  have no shared master. Measured on the first real pair: the MIDI is a rigid
  110.000bpm grid, the recording is ~109.68bpm, and the chart drifts ~600ms
  apart over the song — enough to make ~64% of it auto-Miss on a constant
  offset alone.

Merging them would make calibrating your kit corrupt every song's alignment.

**Auto-alignment is a suggestion, not an answer.** `offsetMs` is ambiguous by
whole bars — a groove looks the same shifted a bar, so the correlator cannot
tell. `tempoScale` is reliable; the bar is not. Always let the player confirm
by ear and nudge ±1 bar. High confidence means "locked onto the groove", not
"found the right bar".

**`@julusian/midi` must stay externalized** in `electron.vite.config.ts` and
listed in electron-builder's `files`/`asarUnpack`. It resolves its prebuilt
binary at runtime relative to its own package directory; bundling it breaks
that lookup. Re-check this after any dependency bump — the failure only shows
up in the packaged app, not in dev. MIDI *parsing* is separate and uses pure-JS
`@tonejs/midi`; no native code there.

**Gameplay is a raw `<canvas>` on `requestAnimationFrame`.** Do not rebuild the
lanes out of layout components. Every other screen uses the component set in
`renderer/components/ui/`.

**Dark is forced in both processes.** `nativeTheme.themeSource = "dark"` in
main, `.dark` class on the root in the renderer, opaque `#0a0a0f` background.
Not vibrancy — translucent vibrancy washes out to gray. The absence of a theme
toggle is a decision, not a gap.

**`app.getPath` is synchronous in Electron.** The Glaze sources `await` it;
that was a Glaze API difference. Drop the `await` when porting or the path
becomes a Promise in a string position and fails at runtime, not compile time.

## Critical rules

1. **Never compare backend MIDI timestamps to `audioEl.currentTime`.** They
   have no shared origin; latency belongs in the calibration offset.
2. **Never generate chart notes from audio.** The MIDI file is the only source.
   A fallback that "helpfully" infers notes makes every score meaningless.
3. **Never score an unmapped MIDI note as a miss.** Exclude it from totals.
4. **Never bundle `@julusian/midi`.** It breaks only in the packaged app, which
   is the most expensive place to find it.
5. **Never claim timing or MIDI behavior works without a cold launch and real
   hardware.** Type-clean is not verified. Say which one you did.
6. **Never leave `PROGRESS.md` stale at the end of a session.** A stale
   current-state doc is worse than none — the next session trusts it.

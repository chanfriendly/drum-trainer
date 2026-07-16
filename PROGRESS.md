# Progress

> Read this before doing anything else. Update it before you stop.
> Last updated: 2026-07-16

## Current status

**The app builds, packages to a `.dmg`, launches, and talks to CoreMIDI.** The
whole backend is ported (MIDI, library, results, chart parsing, `song-audio://`
protocol) and the preload IPC surface is complete. The renderer is still just a
throwaway MIDI smoke-test screen — none of the five real screens exist yet.

The big risk is retired: the packaged app enumerates MIDI devices from inside
`app.asar.unpacked` without error. That was verified by launching the actual
`.dmg` build, not by inspection.

The reference implementation — the prior Glaze build — is at
`~/Library/Application Support/app.glaze.macos.main/apps/drum-trainer-local-2qhmrebi/.glaze-sources`.
Read it, don't copy it blindly: every `@glaze/core` import needs a real Electron
replacement, and two of its comments were already found to be wrong (see
"Failed approaches").

Next work is the Library screen — the first real UI, and the thing that makes
import → list testable.

## What's done

- [x] 2026-07-16 — Reviewed `BUILD-PROMPT.md` and the full Glaze source tree
      (~4,300 lines); mapped what ports vs. what needs replacing
- [x] 2026-07-16 — Confirmed toolchain: Node 22.14, Electron 43, electron-vite
      5, electron-builder 26; `@julusian/midi` 3.6.1 ships N-API prebuilds
      (no rebuild step needed)
- [x] 2026-07-16 — Decisions locked: port logic + hand-rolled Tailwind UI;
      unsigned `.dmg`; own git repo in `drums/`
- [x] 2026-07-16 — `git init` in `drums/` (nested inside the `~/Documents` repo)
- [x] 2026-07-16 — Wrote `CLAUDE.md`, `CHANGELOG.md`, `PROGRESS.md`
- [x] 2026-07-16 — Scaffolded electron-vite + electron-builder; type-check
      clean; main/preload/renderer all build
- [x] 2026-07-16 — Ported backend: `midi-service`, `library-service`,
      `results-service`, `chart.ts`, `song-audio://` protocol (with hand-rolled
      Range support), native file dialogs, file-backed logger
- [x] 2026-07-16 — Ported the preload `contextBridge` IPC surface (full table
      in `CLAUDE.md`)
- [x] 2026-07-16 — **Native addon risk retired.** Probed the addon under
      Electron 43 headlessly (`PROBE_OK`); confirmed `out/main/index.js` keeps
      `@julusian/midi` external while bundling `@tonejs/midi`; built the
      unsigned `.dmg` (115 MB); confirmed the `darwin-arm64` prebuild lands in
      `app.asar.unpacked`; **launched the packaged app** and saw the renderer
      call `midi:listDevices` through IPC into the addon with no error
- [x] 2026-07-16 — Verified in the packaged app: dark theme from first paint (no
      light flash), window renders, clean quit with `before-quit` MIDI cleanup
      firing. Closes three of the Glaze build's unverified items.

## What's next

Prioritized. Top item is immediately actionable.

1. **Port the Library screen** — `renderer/views/library-view.tsx` plus the
   first real components in `renderer/components/ui/`, replacing the smoke-test
   `App.tsx`. Add the router (TanStack, **hash history** — `file://` has no
   server to resolve real paths) and the `nav:goto` subscription that the
   Settings menu item already sends. Goal: import → list → delete end-to-end.
2. **Get a test song.** Blocks everything below — see "What's blocked".
3. **Port the Gameplay canvas** — audio over `song-audio://`, scrolling lanes,
   judging against `audioEl.currentTime`.
4. **Port Results, Settings, Calibration.**
5. **Write the pure-function tests** — `chart.ts` (parsing, difficulty) is
   already split out to be testable without Electron; add accuracy/score math
   and judgment bucketing once gameplay lands. Vitest is installed, no tests
   written yet.
6. **Add an app icon** — electron-builder warns "default Electron icon is used".
   `app-icon.icns`/`.png` exist in the Glaze sources; drop them in `build/`.
7. **Set up ESLint** — there is deliberately no `lint` script right now rather
   than a broken one. Flat config + typescript-eslint when it's worth the time.
8. **Hardware validation pass** — the carried-over checklist in "Notes for next
   session".

## What's blocked

- **Real MIDI enumeration and all judgment "feel" work** is blocked on input
  hardware. The packaged app returns an *empty* device list because no e-kit is
  connected — the addon is proven to load, but enumerating a real device is not
  proven. **Cheap unblock (no kit required):** the IAC Driver is a virtual MIDI
  cable inside macOS — Audio MIDI Setup → Window → Show MIDI Studio (⌘2) →
  double-click IAC Driver → tick "Device is online". It creates the *port*;
  something must still *send* into it, e.g. Logic Pro playing a drum track out
  to "IAC Bus 1". That yields a device to enumerate and real note-ons to judge
  with no hardware attached, which makes the gameplay port verifiable — worth
  doing *before* that port. Not yet enabled: it changes how every audio app on
  the machine sees MIDI, so it's the user's call. Judgment *feel* still needs
  the real kit.
- **Test song: MIDI in hand, AUDIO STILL MISSING.** Import needs a pair, and
  there is no chart-from-audio path by design, so gameplay cannot be exercised
  until the audio arrives. Asked the user for an mp3 on 2026-07-16.
  - MIDI: `~/Downloads/Another-One-Bites-The-Dust-2.mid`. **Deliberately not
    committed** — copyrighted, and this repo may go open source; a Queen MIDI in
    the history would need a history rewrite to remove. Tests use a synthetic
    fixture instead.
  - Verified 2026-07-16 by running it through the real parse logic: 212.5s,
    drum track correctly picked (ch 9, percussion, 1380 notes) out of 5 tracks,
    6.50 nps → **Hard**, 94.6% mapped.
  - Note **39 (Hand Clap) × 75 is unmapped** by the default GM mapping →
    correctly ignored, not missed. Good "Learn"-flow test case once Settings
    exists.
  - The chart only uses kick / snare / closed hi-hat — **it exercises 3 of the 6
    lanes**. It will not shake out tom/crash/ride bugs. Get a second song with
    cymbals and toms before trusting the gameplay canvas.
- **Notarization** is deliberately out of scope; revisit only if the app is
  ever distributed to another person.

## Failed approaches

Seeded from the prior build so the dead ends are not re-walked. The first two
were confirmed against the pinned dependencies during the port; the rest are
inherited claims:

- **Translucent vibrancy for the window background** — washes out to gray in
  light mode. The fix was an opaque `#0a0a0f` plus forced dark in *both*
  processes. Do not reintroduce vibrancy.
- **Bundling `@julusian/midi`** — it locates its prebuilt binary at runtime
  relative to its own package directory (via `pkg-prebuilds`), so an inlined
  copy cannot find it. Must be externalized and asar-unpacked.
- **Building gameplay lanes from layout components** — abandoned in favor of a
  raw `<canvas>` on `requestAnimationFrame`. Per-frame note movement through a
  component tree is the wrong tool.
- **Trusting hot reload for main-process changes** — the Glaze dev session did
  not cold-restart on rebuild, which is exactly why the items below are still
  unverified.

**Two Glaze comments proved wrong during the port — don't trust them if you
read the reference sources:**

- *"Input has no explicit destroy"* (`midi-service`) — false for
  `@julusian/midi` 3.6.1, which exposes `destroy()`. The Glaze probe leaked a
  CoreMIDI client per `listDevices()` call. The port destroys it explicitly.
- *`await app.getPath(...)`* — `app.getPath` is synchronous in Electron.
  Awaiting a non-promise silently works, which is why it survived; the port
  drops the `await` and the cached-promise indirection built around it.

## Notes for next session

**Carried-over validation checklist** (from the Glaze build's `NEXT-STEPS.md` —
never verified there against a real launch. Items confirmed in THIS build are
marked; the rest are open):

- ~~Cold-launch and confirm dark theme applies from first paint~~ — **done
  2026-07-16**, verified against the packaged `.dmg`, no light flash
- Full song with a real e-kit: every pad produces a note-on; calibration yields
  a sane offset; judgments feel right *by ear*
- More than one MIDI device connected — picker lists all; switching works
- Unplug/replug the kit while running — no crash, no silent stop
- MIDI with notes outside the default GM mapping — ignored cleanly, mappable
  via "Learn" without re-import
- Mismatched pair (MIDI longer than audio) — chart outlasting audio must not
  break gameplay
- Corrupt/non-MIDI and corrupt/unsupported audio — clear error, not a crash
- Delete a song — `songs/<id>/` and its results are actually removed
- Empty library state looks intentional
- Pause/resume and window blur mid-gameplay
- Hand-check combo/score against the documented formulas
- Canvas at 900×640 through full-screen — lanes scale, don't clip
- Hit-window and latency changes take effect without a restart
- Mapping persists across restarts (`localStorage: drumTrainer.settings`)

**Nice-to-haves, only if asked:** keyboard fallback for testing without a kit
(would meaningfully unblock solo development — worth raising with the user);
export a song's results history.

**Housekeeping:** `drums/` is a git repo nested inside the `~/Documents` git
repo. Consider adding `Documents/GitHub/drums/` to the parent's `.gitignore` so
it does not get swept into an unrelated commit.

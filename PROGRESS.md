# Progress

> Read this before doing anything else. Update it before you stop.
> Last updated: 2026-07-16

## Current status

**The Library screen works end-to-end in the real app: import → list → delete.**
The whole backend is ported (MIDI, library, results, chart parsing,
`song-audio://` protocol), the preload IPC surface is complete, and the app
packages to a launchable `.dmg`.

Of the five screens, Library is real. Gameplay, Results, Settings, and
Calibration are placeholders that state what's missing
(`renderer/views/placeholders.tsx`) — a half-built app should never be
mistakable for a broken one.

Two risks retired, both by measurement rather than inspection:
- The packaged app enumerates MIDI devices from inside `app.asar.unpacked`
  without error, verified by launching the actual `.dmg`. `IAC Driver Bus 1`
  now enumerates (the user enabled it 2026-07-16), so real device detection
  works — receiving note-ons from it is still untested.
- **The chart/audio alignment problem is found and solved in principle**
  (estimator + storage + tests), though nothing calls it yet. Read the
  CHANGELOG entry before touching timing — the spec's one-global-offset model
  is wrong for real file pairs and would have made ~64% of the first test song
  auto-Miss while looking like a judging bug.

The reference implementation — the prior Glaze build — is at
`~/Library/Application Support/app.glaze.macos.main/apps/drum-trainer-local-2qhmrebi/.glaze-sources`.
Read it, don't copy it blindly: every `@glaze/core` import needs a real Electron
replacement, and two of its comments were already found to be wrong (see
"Failed approaches").

Next work is wiring the alignment estimator into the renderer (it exists and is
tested, but nothing calls it), then the gameplay canvas.

**Untested surface worth knowing:** the `song-audio://` protocol has never
served a byte to a real <audio> element. Its Range handling is hand-rolled and
seeking depends on it. Gameplay is where that gets exercised.

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
- [x] 2026-07-16 — Built `assets/practice-groove/`, the ORACLE test song (audio
      rendered from its own chart; true alignment known). Estimator recovers it
      to -6.3ms / scale 1.00000 / confidence 4.78.
- [x] 2026-07-16 — Alignment estimator + per-song storage + 18 tests. NOT yet
      called by any UI.
- [x] 2026-07-16 — **Library screen done and verified in the running app**:
      local Tailwind UI primitives (`components/ui.tsx`), TanStack router with
      memory history, root layout with the `nav:goto` bridge. Drove the real app:
      empty state → Import (native pickers, correct extension filters) → toast →
      song row (name/difficulty/duration/notes/best, plus a "Not synced" badge)
      → delete confirm + cancel → Settings nav → ⌘, menu bridge. Confirmed
      `songs/<id>/` on disk holds audio.flac + song.json with all 316 notes.

## What's next

Prioritized. Top item is immediately actionable.

1. **Wire up alignment in the renderer.** The estimator and storage exist and
   are tested; nothing calls them yet. Needs: fetch `song-audio://` → Web Audio
   `decodeAudioData` → `OfflineAudioContext` resample to 22050 mono →
   `onsetEnvelope` → `estimateAlignment` → `songs.setAlignment`. Then a Sync UI
   showing confidence with a **±1 bar nudge** and an audible preview, because
   auto-align cannot pick the right bar on its own (see CHANGELOG).
2. **Port the Gameplay canvas** — audio over `song-audio://`, scrolling lanes,
   judging against `audioEl.currentTime`. Must apply `song.alignment` when
   building the playable chart, and should warn when `alignment.source ===
   "none"` rather than judging a drifting chart silently.
3. **Port Results, Settings, Calibration.** All three are placeholder screens
   right now (`renderer/views/placeholders.tsx`) that say what's missing.
4. **More pure-function tests** — 18 alignment tests exist. `chart.ts`
   (parsing, difficulty) is split out to be testable without Electron but has no
   tests yet; add accuracy/score math and judgment bucketing once gameplay lands.
5. **Add an app icon** — electron-builder warns "default Electron icon is used".
   `app-icon.icns`/`.png` exist in the Glaze sources; drop them in `build/`.
6. **Set up ESLint** — there is deliberately no `lint` script right now rather
   than a broken one. Flat config + typescript-eslint when it's worth the time.
7. **Hardware validation pass** — the carried-over checklist in "Notes for next
   session".

## What's blocked

- **Judgment "feel"** still needs the real e-kit and the user's ears; no test
  can establish it. NOT blocked any more: device enumeration (IAC Driver Bus 1
  is online as of 2026-07-16). Something must still *send* into the IAC bus for
  note-ons — e.g. Logic Pro playing a drum track out to "IAC Bus 1".
- **Notarization** is deliberately out of scope; revisit only if the app is
  ever distributed to another person.

## Test songs

Two, and they serve opposite purposes. Use both.

### Practice Groove — the ORACLE (committed, `assets/practice-groove/`)

Generated by this repo: the audio is rendered FROM the chart, so the true
alignment is known (offset 0, scale 1, sample-accurate). It is the only case
where "is the code right?" is answerable, because with any real pair a failure
could equally be the files. Uses **all six lanes** and has real structure
(fills, a break). Original content, so it is committed. See its README.

Estimator against it: **-6.3ms / scale 1.00000 / confidence 4.78** — recovers
truth well inside the ±25ms Perfect window. Without `FRAME_LEAD` it reads -35ms,
which is how that bug was caught.

### Another One Bites the Dust — the REAL-WORLD case (not committed)

  - MIDI: `~/Downloads/Another-One-Bites-The-Dust-2.mid`
  - Audio: `~/Downloads/Queen - Another One Bites the Dust (Official Video).mp3`
    (2.9MB, 222.8s)
  - **Neither is committed** — copyrighted, and this repo may go open source; a
    Queen MIDI/mp3 in the history would need a history rewrite to remove. The
    test fixtures under `tests/fixtures/` are gitignored and derived from these;
    regenerate with the ffmpeg command in `tests/alignment.test.ts`.
  - **This pair does NOT align** (MIDI 110.000bpm vs recording ~109.68bpm,
    ~600ms drift). It is a *good* test case precisely because of that — it is
    the case the alignment feature exists for — but do not treat "notes don't
    line up" as a gameplay bug when using it.
  - Verified 2026-07-16 by running it through the real parse logic: 212.5s,
    drum track correctly picked (ch 9, percussion, 1380 notes) out of 5 tracks,
    6.50 nps → **Hard**, 94.6% mapped.
  - Note **39 (Hand Clap) × 75 is unmapped** by the default GM mapping →
    correctly ignored, not missed. Good "Learn"-flow test case once Settings
    exists.
  - The chart only uses kick / snare / closed hi-hat — **it exercises 3 of the 6
    lanes**. It will not shake out tom/crash/ride bugs. Get a second song with
    cymbals and toms before trusting the gameplay canvas.

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

# Progress

> Read this before doing anything else. Update it before you stop.
> Last updated: 2026-07-18

## Current status

**The app is finished, published, and has been played on a real kit.** That last
part is the one thing no amount of local testing could establish, and it is now
done: the user played a song through with their e-kit and it worked.

- Repo: **https://github.com/chanfriendly/drum-trainer** (public, MIT).
- All five spec'd screens exist, plus **Sync**, which the spec did not anticipate
  but the problem demanded. No placeholders.
- 74 tests. Type-clean. Packages to an installable `.dmg` with an icon.
- Measured end-to-end MIDI jitter: **±4ms**, comfortably inside the ±25ms Perfect
  window. The plumbing is precise enough to judge drumming.

**The active workstream is no longer the app — it is getting playable songs into
it.** A song needs a real drum MIDI, and free drum MIDI/sheet music is scarce
enough that it is the practical limit on what can be played. See
`scripts/eval/README.md` for the measurements and the plan.

### Read this before touching timing or imports

Three findings cost real debugging time and are easy to re-derive the hard way:

1. **A chart and a recording rarely share a clock.** The spec's single global
   offset is wrong for real file pairs. Per-song `alignment` (offset + tempo
   scale) exists for this; `settings.latencyOffsetMs` is HARDWARE lag and is a
   different thing. Never merge them.
2. **Audio-to-MIDI services export chords, not drums.** Fadr and friends
   transcribe *pitch*, so their `.mid` files contain chords/bass/vocals and no
   drum track at all. Three of the first five real imports were chord exports.
   Import now rejects them; the detector is `looksHarmonic` in `chart.ts`.
3. **A tight stdev around a non-zero mean is a systematic bug, not noise.** This
   caught a ~35ms FFT framing bias (`FRAME_LEAD`) that would have made every song
   judge early. Read the spread, not the average.

**Still not verified, and not verifiable without the kit:** whether the Sync
preview's clicks sound aligned to a human ear, and whether the synthesised
practice-groove kit is pleasant to drum against.

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
- [x] 2026-07-17 — **Settings + Results done and verified in the running app.**
      Settings: device picker, live input monitor, mapping with Learn, hit
      windows, latency offset. Learn captured note 39 (Hand Clap) onto Snare via
      the harness and persisted across a remount. Results: real saved run renders
      correctly (3,004 / 7.2% / 20x / 316) with per-drum bars.
- [x] 2026-07-17 — **Calibration done + README written. No placeholders left.**
      Verified in the app with a machine tapper: ±4ms consistency, "Tight and
      consistent", save path confirmed. Median (not mean) + MAD spread, settling
      taps discarded, scattered runs refused rather than fabricating an offset.
      53 tests (65 as of the candidate-ranking work).
- [x] 2026-07-17 — **Transcription eval harness** (`scripts/eval/`). Findings:
      timing is NOT the bottleneck (±25ms F1 51.3% vs ±50ms 51.6% on the oracle —
      a 0.3pt gap); classification is (ride 3.5%, snare 0%). On the real mix it
      hallucinates 663 cymbal notes that don't exist in the chart. It also caught
      a FRAME_LEAD bug in itself, then a sign error in the fix. See its README.
- [x] 2026-07-17 — **`scripts/midi-sim.mjs` committed** — plays the part of an
      e-kit over the IAC bus (`burst`/`note`/`chart`/`devices`). `npm run midi-sim`.
- [x] 2026-07-16 — **Gameplay done and verified with REAL MIDI**: canvas lanes,
      scrolling notes, judging against the audio clock, pause/resume, results
      saved. Drove it via an IAC-bus sender standing in for an e-kit — score hit
      3,004 live; saved result accounting exact (9+14+8+10+275 = 316 = total),
      accuracy 7.22% matching a hand-check of the spec formula. Seeking to 58s
      exercised Range/206 for the first time.
- [x] 2026-07-16 — **Sync screen done and verified in the running app**:
      Auto-align → preview (clicks on charted kick/snare) → ±1 bar nudge → save.
      Against the oracle song it returns confidence 4.70 / offset -0.006s /
      tempo 100.000%, matching the vitest oracle via a completely different path.
      Fixed `song-audio://` CORS on the way (see CHANGELOG) — the protocol had
      never actually served a byte before this.
- [x] 2026-07-16 — **Library screen done and verified in the running app**:
      local Tailwind UI primitives (`components/ui.tsx`), TanStack router with
      memory history, root layout with the `nav:goto` bridge. Drove the real app:
      empty state → Import (native pickers, correct extension filters) → toast →
      song row (name/difficulty/duration/notes/best, plus a "Not synced" badge)
      → delete confirm + cancel → Settings nav → ⌘, menu bridge. Confirmed
      `songs/<id>/` on disk holds audio.flac + song.json with all 316 notes.
- [x] 2026-07-17 — **Played on a real kit.** The user connected their e-kit and
      played a song successfully. The core premise is validated.
- [x] 2026-07-18 — **Published**: github.com/chanfriendly/drum-trainer, public,
      MIT, 17 commits. No copyrighted media in the repo or its history.
- [x] 2026-07-18 — **Diagnosed the "bad transcription" report**: three of five
      imported songs were Fadr CHORD exports, not drum charts. Import now
      rejects them (`looksHarmonic`), verified against the real files.
- [x] 2026-07-18 — **Measured transcription on real separated drums**: 8.7% F1,
      and aligning to a drum stem beats the full mix 3.04 vs 0.65 lock. See
      `scripts/eval/README.md`.
- [x] 2026-07-18 — Fixed the MIDI-device toast flood at two layers (toast dedupe
      + don't open a device that isn't listed). This was the unplugged-kit case.


## What's next

Prioritised. The top item is the real project now.

1. **Reliable drum MIDI from isolated audio.** This is the bottleneck on playable
   songs, and the measurements are already done — read `scripts/eval/README.md`
   first. Short version: onset *timing* is solved (99.3% within ±25ms on clean
   audio); instrument *classification* is not (8.7% F1 on real separated drums,
   calling nearly everything a cymbal). The plan is to stop classifying: split a
   drum stem into per-instrument stems (kick/snare/toms/hats/cymbals), then run
   onset detection on each. Needs PyTorch + model weights, so it is an offline
   script that emits a `.mid`, not app code — the app's "MIDI only, never infer
   from audio" rule stays.
2. **Let Sync align against a drum stem.** Measured: aligning to an isolated stem
   locked at **3.04** vs **0.65** on the full mix for the same song, recovering
   the same tempo scale. Cheap, high value, and the user already generates stems.
   Roughly: an optional "use a separate audio file for analysis" input on Sync.
3. **README screenshots.** Deferred deliberately — the library contained junk
   chord-file songs that would have been baked into the images. It is clean now,
   so this is unblocked. Capture with `screencapture -x` (silent, full-res, no
   recording indicator) and crop the bottom status bar, which shows the user's
   account email.
4. **More pure-function tests.** `chart.ts` parsing/difficulty still has none;
   `chartShape`/`looksHarmonic` now do.
5. **Set up ESLint.** Deliberately absent rather than broken; there is no `lint`
   script on purpose.
6. **Hardware validation pass** — the checklist under "Notes for next session".

## What's blocked

- **Playable songs.** The real constraint. A song needs a genuine drum MIDI, and
  free drum MIDI/sheet music is scarce. This is what the transcription
  workstream exists to solve; until it lands, the library grows only as fast as
  charts can be found by hand.
- **Judgment "feel"** needs the kit and the user's ears; no test can establish
  it. Largely unblocked now that the kit works, but the Sync preview's clicks
  and the practice-groove kit sound are still unjudged.
- **Notarization** remains out of scope. The `.dmg` is unsigned; first launch
  needs a right-click → Open.

## Test songs

The library is clean as of 2026-07-18 (the chord-file imports were deleted).

### Practice Groove — the ORACLE (committed, `assets/practice-groove/`)

Generated by this repo: the audio is rendered FROM the chart, so the true
alignment is known (offset 0, scale 1, sample-accurate). It is the only case
where "is the code right?" is answerable, because with any real pair a failure
could equally be the files. Uses all six lanes. Original content, so committed.

Estimator against it: **-6.3ms / scale 1.00000 / confidence 4.78**. Without
`FRAME_LEAD` it reads -35ms, which is how that bug was caught.

**It is an optimistic upper bound.** Synthetic isolated hits; no bleed, no
artifacts. A transcriber scoring 51% here scored 8.7% on real separated drums.
Never treat a result on this song as representative of real audio.

### Taylor Swift — Red (real drum chart, in the user's library)

1,944 notes, genuine drum chart, 123bpm. The only real-world ground truth
available, and the one used for the transcription measurement. A Fadr drum stem
for it exists in the user's Downloads.

### Copyrighted material is NOT committed

No third-party audio or MIDI is in the repo or its history — deliberately, and
verified before publishing. Test fixtures under `tests/fixtures/` are gitignored
and regenerable with `npm run test:fixtures`.

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

### Handing this to a fresh conversation

Read `CLAUDE.md` (how to work here), then this file. The two other docs carrying
hard-won reasoning are `CHANGELOG.md` (why things are the way they are) and
`scripts/eval/README.md` (the transcription measurements and plan).

```bash
npm run dev            # run it
npm run test           # 74 tests
npm run midi-sim burst # play the part of an e-kit over the IAC bus
npm run dist:mac       # installable .dmg
```

`npm run midi-sim` is how most of the app gets exercised without hardware. It
cannot test timing *feel* — only a kit and ears can.

### Carried-over hardware checklist

Confirmed items are struck through; the rest still need the kit:

- ~~Cold-launch: dark theme from first paint~~ — verified on the `.dmg`
- ~~Notes outside the default GM mapping ignored, mappable via Learn~~ — done
  (note 39 Hand Clap → Snare)
- ~~Mapping persists across restarts~~ — done
- ~~Unplug/replug the kit — no crash, no silent stop~~ — the failure mode (a
  toast flood) was found and fixed 2026-07-18; a real unplug is worth one check
- Full song with the kit: every pad produces a note-on; judgments feel right
  *by ear* — **partially done**, the user played a song successfully
- More than one MIDI device connected — picker lists all; switching works
- Mismatched pair (MIDI longer than audio) — chart outlasting audio must not
  break gameplay
- Corrupt/unsupported audio — clear error, not a crash
- Pause/resume and window blur mid-gameplay
- Canvas at 900x640 through full-screen — lanes scale, don't clip
- Hit-window and latency changes take effect without a restart

### Small things noticed but not done

- `CLAUDE.md` and this file reference the old Glaze sources by absolute path
  under the user's home directory. Harmless, but meaningless to anyone else now
  that the repo is public.
- `.mp4` audio is not supported. It was raised and then explicitly dropped — do
  not add it without asking.

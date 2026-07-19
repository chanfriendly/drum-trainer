# Progress

> Read this before doing anything else. Update it before you stop.
> Last updated: 2026-07-19

## Current status

**The app is finished, published, and has been played on a real kit.** That last
part is the one thing no amount of local testing could establish, and it is now
done: the user played a song through with their e-kit and it worked.

- Repo: **https://github.com/chanfriendly/drum-trainer** (public, MIT).
  Pushed and up to date as of 2026-07-19 (32 commits). No third-party audio or
  MIDI in the repo or its history — re-verified before this push.
- All five spec'd screens exist, plus **Sync**, which the spec did not anticipate
  but the problem demanded. No placeholders.
- 93 tests. Type-clean. Packages to an installable `.dmg` with an icon.
- Measured end-to-end MIDI jitter: **±4ms**, comfortably inside the ±25ms Perfect
  window. The plumbing is precise enough to judge drumming.

**The active workstream is no longer the app — it is getting playable songs into
it.** See `scripts/eval/README.md` for the measurements and
`scripts/transcribe/README.md` for the pipeline.

### The workflow, end to end (as of 2026-07-19: functioning, and in-app)

**Have a MIDI?** Library → Import Song (audio + `.mid`) → Sync → play.

**Only have audio?** Library → **"Audio only…"** does the whole thing:

```
song audio →  demucs isolates the drums
           →  ADTOF transcribes the MIX (not the stem — measured)
           →  notes gated by the stem, crash threshold 0.55
           →  imports, attaches the stem as Sync's analysis audio
           →  lands on Sync, marked chartSource:"transcribed"
```

~1 minute a song. Needs the Python toolchain (`scripts/transcribe/README.md`);
without it `songs:canTranscribe` returns false and the button is absent.
The CLI equivalent is `scripts/transcribe/chart_from_audio.py`.

Every step has been exercised on real songs. What still varies is **chart
quality**, not the plumbing: ADTOF nails some songs and collapses on others.
Alignment, which was the broken link, now lands within 8ms of established truth
on all three known-truth pairs.

**Generated songs are marked** `chartSource: "transcribed"` and badged
**Generated** in the library. CLAUDE.md critical rule 2 draws the line: charting
from audio *implicitly* (as a fallback for a missing MIDI) is still forbidden;
doing it because the player asked, and saying so, is not.

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
- [x] 2026-07-18 — **Transcription workstream: solved to first order, by
      measurement instead of construction.** Ran pretrained ADTOF (CRNN trained
      on rhythm-game charts) through the eval harness before building the
      separation pipeline: **66.4% F1 @±25ms on the real TS stem vs 8.7%
      baseline** (kick 88.5% / snare 78.8% / 94.3% of matches inside the
      Perfect window). Deliverable: `scripts/transcribe/adtof_transcribe.py`
      (+ `.venv-adt`, Python 3.11). Charted both stem-only songs (Kate Bush,
      Olivia Rodrigo) → `~/Downloads/adtof-charts/`, verified importable
      percussion MIDI. Separation pipeline demoted to fallback. See
      `scripts/transcribe/README.md` and CHANGELOG.
- [x] 2026-07-18 — **Sync can analyse a drum stem.** Optional per-song
      `analysis.<ext>` copied into the song dir, new `songs:setAnalysisAudio`
      IPC, stem row + ±1 beat nudges on Sync. Verified END TO END in the
      running dev app over CDP: attach → file lands on disk → estimator decodes
      the stem → identical tempoScale (0.98400) from stem and mix → UI renders.
      The same probe found the scorer problem now at "What's next" #2, and that
      Red's saved alignment was never ear-confirmed. Playback untouched by
      design. NOT verified: none of this changes timing feel; no kit involved.
- [x] 2026-07-18 — `chart-parse.test.ts`: parseChart/difficultyFor/
      notesPerSecond covered through real MIDI byte round-trips (83 tests
      total). Found en route: a velocity-0 note-on is a note-off and
      @tonejs/midi drops it before parseChart — asserted as behavior.
- [x] 2026-07-18 — The Red song now has its Fadr stem attached as analysis
      audio (left in place — it is the real configuration for the kit session).
- [x] 2026-07-19 — **Sync preview made audible** (it started before the first
      CHARTED note but clicks only on kick/snare — a 7.6s silent gap on Red —
      and a 0.25-gain sine was masked by a limited master). Nudges now scaled
      into audio time. Both fixes verified against real data, not just types.
- [x] 2026-07-19 — **Red's true offset established as −1501ms** by symbolic
      matching against ADTOF's transcription (96.4% vs 87.4% at the previously
      saved value), and **drop dead's as 0** (confirmed by a third
      implementation at +0.007s / lock 2.94). Both stored as `manual`.
- [x] 2026-07-19 — **Unmapped notes are now visible and mappable.** Red was
      missing 670 Tambourine (54) notes — 34% of the chart, replacing the hat
      pattern in choruses — and Learn could never reach them because no e-kit
      sends that note. Settings now lists unmapped notes found in the library
      with GM names and counts, and assigns them to a lane in one click.
      Verified in the built app against the real library (89 tests).
- [x] 2026-07-19 — **Lane kit icons** (`lib/drum-icons.ts`), drawn as canvas
      vector art rather than PNGs so they take the lane colour and stay sharp at
      any width. Verified with notes falling through them.
- [x] 2026-07-19 — **Chart generation is in the app** ("Audio only…"). Pipeline
      script + `transcription-service.ts` (spawns the external venv, streams
      progress), `chartSource` provenance with a **Generated** badge, stem
      attached at import. Verified through the running app: `canTranscribe`
      true, real transcription 25s, imported with `chartSource:"transcribed"`
      and `analysis.wav`. CLAUDE.md critical rule 2 now states the
      explicit-vs-implicit line rather than being quietly reinterpreted.
      Chose demucs over automating Logic (no scripting API; Logic's splitter is
      demucs-derived anyway) — measured equivalent, 1,131 vs 1,133 notes.
      **NOT verified:** the native file-picker step of that flow, and no
      generated chart has been played on the kit yet.
- [x] 2026-07-19 — **Gate bug that would have ruined sparse songs**: checking
      only the onset's 100ms window deleted 200 of practice-groove's 262 notes
      (RMS flattens a transient; dense songs hide it). Now spans the decay, and
      abandons gating outright if it would drop >40% of the chart.
- [x] 2026-07-19 — **Transcribe the MIX, align the STEM.** The "give the model
      the cleanest input" intuition was backwards: ADTOF trained on full mixes,
      and separation strips quiet hi-hats before it sees them. On Red vs its
      human chart at a pinned alignment: **F1 66.4% → 70.3%, hi-hat recall
      34% → 52%** (cost: crash precision 45% → 23%). Alignment still wants the
      stem (lock 3.04 vs 0.65) — opposite inputs, both measured. Regenerated
      charts in `~/Downloads/adtof-charts/` as `(drums, from mix)`. Closed two
      paths cheaply: only ONE checkpoint ships despite ~60 registered names,
      and full-mix input does not rescue Hounds of Love (still 67% toms).
      n=1 for the quantitative claim — Red is the only human-charted pair.
- [x] 2026-07-19 — **Alignment estimator fixed — the workflow's broken link.**
      The known-truth oracle diagnosed it in one run: the truth scored HIGHER
      than the winner (f1 0.705 vs 0.664) but was never in the candidate list,
      because candidates are whole-beat shifts of an anchor whose sub-beat
      phase was 3.9 beats out. Anchor on a fine sweep of the whole span (a
      local search around the seed is NOT enough — it broke a working case).
      Also fixed an edge-of-plateau bias worth a constant ~30ms. All three
      known-truth pairs now land within 8ms. 93 tests.
- [x] 2026-07-19 — **Gameplay canvas was drawing in device pixels** — the
      backing store was DPR-scaled but the context never was, so every
      hand-tuned constant was half-size on Retina (11px labels → 5.5 CSS px).
      Presented as a design complaint, was a scaling bug. Lane labels also
      moved to coloured chips under the hit line. Verified by screenshot.
- [x] 2026-07-19 — Verified the **Fadr drum stem is sample-aligned with the
      full mix** (cross-correlation: 0.00ms lag, sharp peak, identical length).
      This was load-bearing: gameplay plays the mix while Sync now analyses the
      stem, so a shifted stem would have silently corrupted every stem-derived
      alignment — and both the offset and the ADTOF transcription read that
      same stem, so a shared error would have looked like agreement.


## What's next

Prioritised. The top item is the real project now.

1. **Drive "Audio only…" by hand once, then play the result.** The flow is
   verified through IPC but the native file-picker step is not, and no generated
   chart has been played on a kit. Pick a song you have only audio for; expect
   ~1 minute. Then judge the hi-hats — see below.
2. **Play the v2 charts and judge the hi-hats.** `~/Downloads/adtof-charts/`
   now holds `(drums, v2 gated)` files — mix-transcribed, stem-gated, crash
   threshold 0.55. These fix the two things heard on the first mix chart:
   phantom kicks in the intro (first note 11.4s → 43.1s on drop dead) and
   over-triggered crashes (89 → 47). Import **drop dead v2** with the full-mix
   FLAC as audio, attach the drum stem in Sync, play. Remaining question is
   unchanged: are the hi-hats "sparse but fair" or "broken"? Do not judge on
   Hounds of Love — still 67% toms, a known-bad case.
3. **Collapse simultaneous same-lane notes in gameplay.** Mapping Red's
   tambourine to hi-hat creates 29 timestamps carrying two notes in one lane,
   and a lane can only be struck once at an instant — so one of each pair is a
   guaranteed miss. ~1% of that song, but it is a general case (any two chart
   notes that map to the same lane at the same time) and gameplay does not
   handle it. Cheap: dedupe by (lane, time) when building the judge list.
4. **README screenshots.** Deferred deliberately — the library contained junk
   chord-file songs that would have been baked into the images. It is clean now,
   so this is unblocked. Capture with `screencapture -x` (silent, full-res, no
   recording indicator) and crop the bottom status bar, which shows the user's
   account email.
5. **Set up ESLint.** Deliberately absent rather than broken; there is no `lint`
   script on purpose.
6. **Hardware validation pass** — the checklist under "Notes for next session".

## What's blocked

- **Playable songs.** Largely unblocked as of 2026-07-18: any song Fadr can
  produce a drum stem for can now be charted by
  `scripts/transcribe/adtof_transcribe.py` (measured 66.4% F1). What remains
  unproven is whether such a chart *feels* playable on the kit — that is now
  the top "What's next" item.
- **Judgment "feel"** needs the kit and the user's ears; no test can establish
  it. Largely unblocked now that the kit works, and the Sync preview's clicks
  are now confirmed audible (2026-07-19).

  **But the ear has a measured limit, learned 2026-07-19: it cannot settle
  bar/beat ambiguity on dense material.** At an offset a full beat wrong, 87.7%
  of Red's clicks still land on a real drum, and the wrong alignment was
  reported as sounding aligned — correctly, because that is what is audible.
  Where symbolic ground truth exists, decide with it and use the ear to
  confirm. The ear remains the only oracle for *feel*.
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

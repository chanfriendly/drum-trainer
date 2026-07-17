# Drum Trainer

A Rock Band-style rhythm trainer for electronic drum kits, as a native macOS app.
It plays a song while scrolling that song's drum chart down six lanes, listens to
your kit over CoreMIDI, and scores your timing in real time.

---

## Getting started

### What you need

| | |
| --- | --- |
| **An electronic kit** | Connected over USB. Nothing else — no Logic, no DAW, no extra drivers. |
| **A song's audio** | `.mp3`, `.m4a`, `.wav`, `.aac`, `.ogg`, or `.flac` |
| **That song's drum chart** | A `.mid` file |

**A song is an audio file + a MIDI file.** The MIDI is the only source of notes —
the app never guesses a chart from audio, because a guessed chart makes every
score meaningless. ([We measured how bad guessing is](scripts/eval/README.md):
even on clean isolated drums the best free-standing attempt gets ~51% of notes
right, and on a real record it invents hundreds of cymbals that aren't there.)

**Where the MIDI comes from is up to you:**

- a `.mid` file you already have or found online, or
- **digital sheet music exported to MIDI** — MuseScore, Guitar Pro (`.gp5`/`.gpx`),
  Sibelius, and MusicXML all export MIDI directly. This is often the easiest
  route, because tabs exist for songs with no standalone `.mid`. Export, then
  import the MIDI. There's nothing special to do in the app.

Scanned or paper sheet music won't work — reading it needs optical music
recognition, which is weakest exactly on drum notation.

### First run

The app is unsigned, so macOS will refuse it the first time. Right-click the app
→ **Open**, or:

```bash
xattr -d com.apple.quarantine "/Applications/Drum Trainer.app"
```

### 1. Point it at your kit

**Settings** (⌘,) → pick your kit under **MIDI input**.

Then **hit every pad** and watch the **Input monitor**. This is the whole
diagnostic:

- Each hit shows `note N → Lane`. Good — that pad is understood.
- Nothing appears at all → the app isn't receiving. Check the cable and the
  selected device. Don't touch the mapping; it isn't the mapping.
- A hit shows **"unmapped"** → press **Learn** on the lane it belongs to, then
  hit that pad again. Your kit's note now belongs to that lane.

Unmapped notes are *ignored* during play — never counted as misses. You're never
punished for the app not knowing your kit.

### 2. Calibrate (once)

**Settings → Calibrate by tapping.** Tap any pad on every click for ~10 seconds.

Watch the **consistency** number more than the offset. Under ±20ms is tight.
If it says the taps were too inconsistent, run it again — an offset built from
scattered taps is worse than no offset.

This measures you as much as your gear (everyone taps slightly early against a
metronome), which is the point: it's calibrating *your* playing, not the kit's
spec sheet. Redo it if someone else sits down.

### 3. Import a song

**Library → Import Song** → pick the audio, then the MIDI.

### 4. Sync it — don't skip this

A song imports as **"Not synced"**. Click it.

**Why this exists:** your MIDI and your recording almost never share a clock.
A MIDI transcription is a rigid grid; a real recording drifts. On our test pair,
the MIDI is a flat 110.000 bpm while the record sags to ~109.68 — the chart walks
**600ms** out of sync by the end, enough that **64% of the song would auto-miss**
no matter how well you play. Sync fixes both the starting point and the drift.

1. **Auto-align** — a first guess.
2. **Preview** — plays 12s with a click on every charted kick and snare.
   - Clicks land *on* the drums → aligned. Save.
   - Clicks sit consistently *between* the drums → **±1 bar** and preview again.
3. **Save alignment.**

**The bar nudge is not optional polish.** Auto-align genuinely cannot tell which
bar is right — every bar of a groove looks identical to it. High confidence means
"found the groove", not "found the right bar". Your ears are the only thing that
can settle it.

### 5. Play

**Library → Play.** Notes fall toward the hit line; hit the matching pad as they
cross it. Results save automatically.

### If it feels wrong

| Symptom | Likely cause |
| --- | --- |
| Everything reads Early or Late, consistently | Latency offset. Re-calibrate, or nudge it in Settings. |
| Notes don't match what you hear at all | The song isn't synced, or is synced a bar off. |
| Fine at first, drifts off later | Tempo mismatch — re-run Sync; auto-align sets the tempo scale. |
| A pad does nothing | Unmapped. Settings → Input monitor → Learn. |
| Everything misses regardless | No MIDI device selected, or the wrong one. |

The rule of thumb: **consistent** error is settings, **growing** error is sync.

---

## Development

```bash
npm install
npm run dev          # run it
npm run test         # 53 tests — the pure logic (alignment, judging, calibration)
npm run type-check
npm run dist:mac     # unsigned .dmg into release/
```

- `npm run midi-sim burst` — plays the part of a kit over the IAC bus, so most of
  the app can be exercised with no hardware. Setup and limits:
  [`scripts/midi-sim.mjs`](scripts/midi-sim.mjs).
- `assets/practice-groove/` — the test song. Its audio is rendered *from its own
  chart*, so its true alignment is known exactly. It's the project's oracle; see
  [its README](assets/practice-groove/README.md).
- `scripts/eval/` — transcription evaluation harness and findings.

Read [`CLAUDE.md`](CLAUDE.md) before changing anything, and
[`PROGRESS.md`](PROGRESS.md) for current state. The short version: **the oracle
is a real kit and your ears** — the type checker and the tests cover the maths,
but nothing except playing it can tell you a Perfect feels like a Perfect.

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

- a `.mid` file you already have or found online,
- **digital sheet music exported to MIDI** — MuseScore, Guitar Pro (`.gp5`/`.gpx`),
  Sibelius, and MusicXML all export MIDI directly. This is often the easiest
  route, because tabs exist for songs with no standalone `.mid`. Export, then
  import the MIDI. There's nothing special to do in the app.
- **or generate one from the recording** with
  [`scripts/transcribe/`](scripts/transcribe/README.md) — an offline script that
  runs a pretrained drum-transcription model and writes a `.mid` you import
  normally. It gets roughly **72% of notes right** on a real song, with kick and
  snare around 90%; hi-hats and cymbals are weaker, and some songs come out
  unusable. Read its limits before relying on it.

Scanned or paper sheet music won't work — reading it needs optical music
recognition, which is weakest exactly on drum notation.

A hand-made chart beats a transcribed one every time. The script exists because
free drum MIDI is scarce, not because it is as good.

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

**Got an isolated drum stem?** (Fadr, Demucs, or a stems download.) Attach it
with **Use a drum stem…** before Auto-align. The estimator then has only drums
to match against instead of the whole band — measured on a real song, it locked
**4.7× more strongly** and found an offset half a second better. Playback still
uses the real audio; the stem is only ever analysed.

1. **Auto-align.** It analyses the audio and shows a **ranked list of candidate
   alignments** — the estimate plus the beat- and bar-shifted alternatives, each
   with a fit score. It tells you which case you're in:
   - **"One clear winner"** — the top option fits clearly better. Still preview it.
   - **"Too close to call"** — several fit almost equally well. This is the
     honest answer, not a failure; your ear decides.
2. **Preview** — plays 12s with a click on every charted kick and snare.
   - Clicks land *on* the drums → aligned. Save.
   - Clicks sit consistently *between* them → pick a different candidate from the
     list (or nudge ±1 bar / ±10ms) and preview again.
3. **Save alignment.**

**Why you're asked at all.** Auto-align places the chart to within a few
milliseconds — far better than an ear. What it *cannot* do is tell which **beat**
of a repeating groove is the right one, because every bar looks alike to it. So
the milliseconds are the machine's job and the beat is yours, and that's the only
question the preview is really asking. A high fit score means "found the groove",
not "found the right beat".

**If it warns the recording "doesn't hold one tempo",** that song breathes —
parts of it drift further than a Perfect window even at the best fit. Expect the
middle to judge Early/Late. Fixing it properly means conforming the MIDI to the
recording in a DAW (Logic's Smart Tempo) and re-importing.

### 5. Play

**Library → Play.** Notes fall toward the hit line; hit the matching pad as they
cross it. Results save automatically.

### If it feels wrong

| Symptom | Likely cause |
| --- | --- |
| Everything reads Early or Late, consistently | Latency offset. Re-calibrate, or nudge it in Settings. |
| Notes don't match what you hear at all | The song isn't synced, or is synced a bar off. |
| Fine at first, drifts off later | Tempo mismatch — re-run Sync; auto-align sets the tempo scale, and warns if the recording won't hold one. |
| A pad does nothing | Unmapped. Settings → Input monitor → Learn. |
| Everything misses regardless | No MIDI device selected, or the wrong one. |

The rule of thumb: **consistent** error is settings, **growing** error is sync.

---

## Known issues

Real limits, measured rather than guessed. None of these are secretly fixed.

### Charts generated by `scripts/transcribe/`

The transcription model is the weakest link in the whole system, and how weak
depends on the song.

- **Some songs come out unusable.** Kate Bush's *Hounds of Love* transcribes as
  **67% toms with zero hi-hats and zero cymbals** — the model collapses on
  productions far outside its training material (1985 Fairlight and gated
  drums). Feeding it the full mix instead of a stem does not rescue it. You will
  hear this within a few bars; there is no fix but a hand-made chart.
- **Hi-hats are under-charted.** ~52% recall at best. Busy hat parts come out
  thinner than the record.
- **One cymbal class.** Crash, ride, splash and open hats all become "crash".
  There is no ride/crash distinction to be had from this model.
- **Cymbals over-trigger on a full mix**, because guitars and vocals put energy
  where cymbals live. `--threshold crash=0.55` roughly halves the false ones;
  the default is already tuned this way in the docs, but it was tuned on **one
  song**, so treat it as a starting point.
- **Phantom notes in intros and breakdowns.** Transcribing a full mix invents
  drums where there are none — one test song charted its first note 19 seconds
  before the drums actually enter. Pass `--gate-with <drum stem>` to drop them.

### Alignment

- **Auto-align cannot pick the bar, by design.** Every bar of a groove looks
  alike to it, so it reports "too close to call" and asks you. That is the
  honest answer, not a failure.
- **Your ear can't settle it either, on dense material.** Measured: at an offset
  a full beat wrong, **87% of preview clicks still land on a real drum**. If the
  candidates sound equally good, they may genuinely be indistinguishable by ear —
  prefer a song section with a distinctive fill.
- **Songs that don't hold one tempo.** The correction is a straight line
  (offset + tempo scale), so a recording that breathes will drift within the
  song even at the best fit. The app warns when it detects this. The real fix is
  conforming the MIDI in a DAW.

### Playing

- **Notes your kit can't send are invisible** — correctly excluded from scoring
  rather than counted as misses, but a chart can put a third of itself on a drum
  you don't have. Real example: a chart with **670 tambourine notes**, which
  replaced the hi-hat pattern in every chorus. Settings lists unmapped notes
  found in your library so you can assign them to a lane.
- **Two notes mapped to one lane at the same instant can only be hit once**, so
  one of them always misses. Rare, but it happens after mapping an extra
  instrument onto an existing lane.
- **No ride/crash distinction on many charts**, following from the cymbal limit
  above.

### Packaging

- **The `.dmg` is unsigned**, so first launch needs right-click → Open (see
  [First run](#first-run)). Not a bug, and not going to change without an Apple
  developer account.
- **`.mp4` audio is not supported.** Use the formats listed at the top.
- **macOS only.** Nothing here is portable to Windows or Linux as written —
  it's CoreMIDI end to end.

---

## Development

```bash
npm install
npm run dev          # run it
npm run test         # 93 tests — the pure logic (alignment, judging, calibration)
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
- `scripts/transcribe/` — the offline audio→`.mid` script, its setup, and the
  measurements behind every number in [Known issues](#known-issues).

Read [`CLAUDE.md`](CLAUDE.md) before changing anything, and
[`PROGRESS.md`](PROGRESS.md) for current state. The short version: **the oracle
is a real kit and your ears** — the type checker and the tests cover the maths,
but nothing except playing it can tell you a Perfect feels like a Perfect.

---

## License

MIT — see [LICENSE](LICENSE).

`assets/practice-groove/` is original content generated by this repo's scripts
and is covered by the same license. No third-party music is included: the app
takes audio and MIDI you supply yourself, and none is committed here.

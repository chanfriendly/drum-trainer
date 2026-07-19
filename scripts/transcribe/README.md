# Drum transcription — audio in, `.mid` out

Turns an isolated drum stem into a drum MIDI the app can import. This is an
**offline tool**: the app itself never infers notes from audio (that rule is
untouched); this script produces the `.mid` file that the normal import flow
consumes.

```bash
# one-time setup (Python 3.11 — 3.12+ breaks the ADT ecosystem's pins)
/opt/homebrew/bin/python3.11 -m venv .venv-adt
.venv-adt/bin/pip install "git+https://github.com/MZehren/ADTOF" tf_keras

# the recommended invocation: transcribe the MIX, gate with the STEM
.venv-adt/bin/python scripts/transcribe/adtof_transcribe.py "Song.flac" out/ \
    --gate-with "Drums - Song.mp3" \
    --threshold crash=0.55
# → out/Song.flac.mid                   import this into the app
# → out/….candidate.json                feed this to the eval harness
# → out/….txt                           raw (time, class) pairs
```

Both flags fix a measured failure and both are worth passing by default:
`--gate-with` drops notes where the drum stem is silent (a full mix invents
drums in intros), and `--threshold crash=0.55` roughly halves cymbal false
positives. Details in **Known limits** below.

`chart_from_audio.py` wraps all of this — separation, transcription, gating,
crash threshold — into one call and is what the app shells out to. Use it
rather than driving `adtof_transcribe.py` directly unless you're experimenting.

## Testing the pipeline

```bash
npm run test:transcribe        # or: .venv-adt/bin/python scripts/transcribe/test_pipeline.py
```

Runs the whole pipeline on the committed oracle song and on a set of degenerate
inputs (missing / corrupt / empty / silent / mono). It asserts **plumbing**,
not accuracy: that a good song yields an importable channel-10 chart whose notes
are all in the model's vocabulary, and that every bad input fails with a
one-line human message instead of a crash or a misleading one. It needs the
venv and takes ~30s, so it is deliberately NOT part of `npm run test` (which is
pure and instant). Run it after any dependency bump or edit to these scripts —
the pipeline has no other regression net. (It runs `--no-separate` for speed and
determinism, so the demucs step itself is exercised by hand, not here.)

Transcription *accuracy* is a different question, measured in `scripts/eval/`
against a human-charted song, and is bottlenecked on having such songs.

Model weights ship inside the pip package (~10MB checkpoint) — no separate
download, no GPU needed. A 3½-minute song transcribes in well under a minute on
the MacBook's CPU; the Jetson is not required for this.

## Why ADTOF, and not the separation pipeline

The eval README's original plan was: split the drum stem into per-instrument
stems, run onset detection on each, skip classification entirely. Before
building that, the cheaper experiment was to measure an existing pretrained
model through the harness — and it cleared the bar the plan was aiming at:

**ADTOF** (Zehren et al.) is a CRNN trained on crowdsourced *rhythm-game drum
charts* — the exact artifact this app consumes. Its output vocabulary is the
rhythm-game 5-class reduction: kick, snare, tom, hi-hat, cymbal. Measured
2026-07-18 (details in `scripts/eval/README.md`):

| audio | baseline floor | ADTOF |
| --- | --- | --- |
| Taylor Swift – Red, real Fadr drum stem, ±25ms | 8.7% F1 | **66.4% F1** |
| practice-groove (synthetic oracle), ±25ms | 51.3% F1 | 55.4% F1 |

On the real stem: kick 88.5%, snare 78.8%, and 94.3% of matched notes inside
the ±25ms Perfect window. The separation-first plan also risked quietly
re-importing classification as thresholding (separated stems bleed, and the
"99.3% onset timing" number was measured on clean audio); it remains the
fallback if hi-hat recall needs rescuing, not the default.

## Feed it the FULL MIX, not the drum stem

This reverses the original guidance here, on measurement. ADTOF was trained on
full mixes, and separation *removes* quiet hi-hats before the model ever sees
them. Measured on Red against its real human chart, both at the same
established alignment:

| | drum stem | **full mix** |
| --- | --- | --- |
| Overall F1 @±25ms | 66.4% | **70.3%** |
| hi-hat F1 | 47.4% (recall 34%) | **61.5%** (recall **52%**) |
| kick F1 | 88.5% | 89.5% |
| snare F1 | 78.8% | 80.4% |
| crash precision | 45.2% | **23.2%** ← worse |
| inside ±25ms | 94.3% | 96.1% |

The gain is almost entirely **hi-hat recall**, which was the pipeline's main
weakness — 101 more real hats found. The cost is cymbal precision: in a mix,
guitar and vocal high-frequency energy reads as crashes (95 predicted, 29
exist). That trade is worth taking, because missing hats make a chart feel
empty while a few extra crashes are merely wrong notes in one lane.

**Still align against the drum stem.** Transcription and alignment want
different inputs, and both are measured: the stem locks 3.04 vs the mix's 0.65
because nothing but drums produces onsets there. So: transcribe the mix, attach
the stem in Sync.

## Known limits — read before trusting a chart

- **A full mix invents drums where there are none.** On a stem, silence means
  no notes; on a mix, bass and vocals sit in the kick band and the model charts
  them. Measured on *drop dead*: the first charted note landed at **11.4s when
  the drums do not enter until 30s** — audible as phantom kicks over the intro.
  `--gate-with <drum stem>` drops notes where the stem is silent; on that song
  it moved the first note to 43.1s and removed 27 notes overall, costing 7
  hi-hats.
- **Cymbals over-trigger on a mix.** The default cymbal threshold (0.30) is
  tuned for stems. Swept against Red's human chart:

  | `--threshold crash=` | crash precision | crash F1 | overall F1 |
  | --- | --- | --- | --- |
  | 0.30 (default) | 23.2% | 35.5% | 70.3% |
  | 0.40 | 36.2% | 48.3% | 71.3% |
  | **0.55** | **54.1%** | **60.6%** | **71.8%** |
  | 0.70 | 50.0% | 6.5% ← collapses | 71.3% |

  0.55 is a real optimum, not a point on a slope — at 0.70 crash recall falls
  off a cliff to 3.4% and real crashes vanish. **Tuned on one song**, so treat
  it as a good default rather than a constant of nature.
- **One cymbal class.** Everything cymbal-ish becomes note 49 (crash). No
  crash/ride distinction, no open/closed hat.
- **Toms over-trigger** (precision ~23%).
- **~10ms early bias**, tight spread. Constant, so the app's per-song Sync
  alignment absorbs it — do not add a correction here on top.
- **Some songs collapse entirely, and full-mix input does not rescue them.**
  Kate Bush's *Hounds of Love* transcribes as **67% toms with zero hi-hats and
  zero cymbals** from the mix (62% from the stem) — a 1985 Fairlight/gated
  production far outside ADTOF's rock-game training domain. Listen before
  trusting a chart; a collapsed one is obvious within a few bars.
- **Only one checkpoint ships.** The package registers ~60 model names but
  contains weights for exactly one (`Frame_RNN_adtofAll_0`). "Try a different
  model" is not a local option — it needs weights from the ADTOF repo.

## Gotchas encoded in the script

- `TF_USE_LEGACY_KERAS=True` is set inside the script (ADTOF's checkpoint is
  Keras 2; Keras 3 can't build it). `tf_keras` must be installed.
- ADTOF discovers input with `glob`, so Fadr's `[fadr.com] …` paths match
  nothing and produce **no output and no error**. The script detects glob
  metacharacters and stages the file to a clean temp path first.

Always measure a new chart source against the harness (`--candidate`) before
believing it — see `scripts/eval/README.md`.

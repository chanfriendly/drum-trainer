# Drum transcription — audio in, `.mid` out

Turns an isolated drum stem into a drum MIDI the app can import. This is an
**offline tool**: the app itself never infers notes from audio (that rule is
untouched); this script produces the `.mid` file that the normal import flow
consumes.

```bash
# one-time setup (Python 3.11 — 3.12+ breaks the ADT ecosystem's pins)
/opt/homebrew/bin/python3.11 -m venv .venv-adt
.venv-adt/bin/pip install "git+https://github.com/MZehren/ADTOF" tf_keras

# transcribe a drum stem
.venv-adt/bin/python scripts/transcribe/adtof_transcribe.py "Drums - Song.mp3" out/
# → out/Drums - Song.mp3.mid            import this into the app
# → out/….candidate.json                feed this to the eval harness
# → out/….txt                           raw (time, class) pairs
```

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

## Known limits — read before trusting a chart

- **Hi-hats are under-charted.** Recall ~34% on the real stem (precision ~77%):
  roughly two of three charted hats are missing, but the hats it writes are
  real. For practice this degrades gracefully — missing notes beat hallucinated
  ones.
- **One cymbal class.** Everything cymbal-ish becomes note 49 (crash). No
  crash/ride distinction, no open/closed hat.
- **Toms over-trigger** (precision ~21% on the real stem).
- **~10ms early bias**, tight spread. Constant, so the app's per-song Sync
  alignment absorbs it — do not add a correction here on top.
- **Feed it isolated drum stems**, not full mixes. All measurements are on
  stems; that is the supported input.

## Gotchas encoded in the script

- `TF_USE_LEGACY_KERAS=True` is set inside the script (ADTOF's checkpoint is
  Keras 2; Keras 3 can't build it). `tf_keras` must be installed.
- ADTOF discovers input with `glob`, so Fadr's `[fadr.com] …` paths match
  nothing and produce **no output and no error**. The script detects glob
  metacharacters and stages the file to a clean temp path first.

Always measure a new chart source against the harness (`--candidate`) before
believing it — see `scripts/eval/README.md`.

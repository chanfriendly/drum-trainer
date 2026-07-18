# Transcription evaluation harness

Answers one question: **how good would audio transcription have to get before it
could replace a MIDI chart?** The app charts from MIDI and never from audio —
that rule doesn't change. This measures what the alternative would cost.

```bash
# reference notes from a MIDI file
node scripts/eval/dump-notes.mjs assets/practice-groove/practice-groove.mid /tmp/ref.json

# evaluate the built-in baseline transcriber against it
python3 scripts/eval/transcribe_eval.py \
  --audio assets/practice-groove/practice-groove.flac \
  --reference /tmp/ref.json --plot /tmp/timing.png

# evaluate someone else's transcription instead
python3 scripts/eval/transcribe_eval.py --audio a.mp3 --reference ref.json \
  --candidate their-output.json          # [{"time": 1.23, "drum": "snare"}, …]

# a real recording, whose alignment is only estimated
python3 scripts/eval/transcribe_eval.py --audio song.mp3 --reference ref.json \
  --offset-ms 3383 --tempo-scale 0.99711 --confounded
```

Needs `numpy`, `scipy`, `ffmpeg` (test-only — the app itself needs none of them).

**The harness is the durable part.** The bundled transcriber is a deliberate
floor: spectral flux onsets + band-energy classification, no downloads, no
PyTorch. A real ADT model swaps in behind `--candidate`; the floor is what it
has to beat, and by how much.

## What can and cannot be measured

**Practice Groove is the only clean evaluation.** Its alignment is known exactly
(offset 0, scale 1), so a miss is a transcription failure and nothing else. It's
also an *optimistic upper bound*: synthetic, isolated drums, nothing masking
anything. A transcriber that can't do well here has no chance on a record.

**A real recording cannot be cleanly evaluated.** Its true alignment is unknown
(auto-align is ambiguous by whole bars), so a low score may be misalignment
rather than mis-transcription — and the number can't tell you which. Pass
`--confounded` and read it qualitatively.

## Findings (2026-07-17, baseline transcriber)

### It caught a bug in itself, twice

First run: mean timing error **−31.7ms with a stdev of 4.8ms**. A bias that
constant is never transcription error — it's framing. Same trap as `FRAME_LEAD`
in `src/renderer/lib/alignment.ts`: an STFT frame starting at `p*HOP` is centered
half a window later, so onsets are reported ~29ms early. Then the correction went
in with the **wrong sign**, doubling the error to −60ms and collapsing F1 to
~0 — which is how the sign got caught. Corrected: mean **−2.9ms**, stdev 3.8ms.

Worth internalising: *a tight stdev around a non-zero mean is a systematic bug,
not noise.* The number to look at is the spread, not the average.

### Timing is not the bottleneck — classification is

Practice Groove, after the fix:

| tolerance | total F1 |
| --- | --- |
| ±25ms (the app's Perfect window) | **51.3%** |
| ±50ms (research standard) | **51.6%** |

The gap is **0.3 points**, and 99.3% of matched onsets land inside ±25ms. Once
framing is right, onset timing on clean audio is a solved problem. Everything
lost is lost to naming the drum, not placing it.

Per lane, the failures are lopsided:

| lane | F1 @±25ms | note |
| --- | --- | --- |
| kick | 80.0% | the easy case — owns a frequency band |
| crash | 72.7% | only 5 in the chart; small sample |
| hihat | 64.2% | |
| ride | **3.5%** | 1 of 56. Called a hi-hat 40 times. |
| snare | **0%** | the floor's rules never fire on this kit |
| tom | **0%** | called a snare 10 times |

`ride → hihat ×40` is the predicted cymbal confusion, arriving exactly as
expected.

### On a real mix it falls apart, and in an informative way

Queen (confounded — read qualitatively): **17.8% F1 @±25ms, 28.6% @±50ms**.

The interesting part isn't the low score, it's *what* it invents. The chart
contains **zero** crashes, rides and toms. The baseline reported **402 crashes,
248 rides, 13 toms** — 663 notes hallucinated out of nothing. In a full mix,
guitar, bass and vocals put energy in the same bands the classifier reads as
cymbals. Isolated drums never told us that; the real record did in one run.

Also note timing stdev jumps from 3.8ms → **25.2ms**, and the ±25/±50 gap
reopens (17.8 → 28.6). Some of that is genuine onset ambiguity in a dense mix,
some is the confounded alignment. The harness cannot separate them — that's the
honest limit of a confounded evaluation.

### Conclusion

Audio transcription is nowhere near replacing a MIDI chart, and the reason is
specific: **not timing — classification, especially cymbals, and catastrophic
false positives once other instruments are in the mix.** Source separation
(Demucs) before transcription would attack exactly the failure the Queen run
exposes. That's the experiment this harness now makes cheap to run.

## Findings on REAL audio (2026-07-18) — these supersede the synthetic ones

The numbers above are from **synthetic** isolated drums. On real audio they do
not hold, and the gap is the single most important thing in this document.

Measured on **Taylor Swift – Red**: a genuine 1,944-note drum chart (ground
truth) against a **Fadr-separated isolated drum stem**.

```bash
python3 scripts/eval/transcribe_eval.py \
  --audio "Drums - Taylor Swift - Red (Lyrics).mp3" \
  --reference ts-ref.json --auto-align
```

### 1. Isolated stems are a large win — for ALIGNMENT

| Aligned against | Lock | Offset | Tempo scale |
| --- | --- | --- | --- |
| Full mix | **0.65** (weak) | −1.969s | 0.984 |
| Isolated drum stem | **3.04** (confident) | −1.501s | 0.984 |

Same tempo recovered, **4.7× the lock strength**, and the offsets differ by half
a second — the full-mix answer was drifting on non-drum onsets. Letting Sync
analyse a drum stem instead of the mix is cheap and clearly worth doing.

(`--auto-align` was added for this: it finds offset/tempo itself rather than
trusting a stored value, and reports the lock so a weak result announces itself.)

### 2. The baseline transcriber is not viable — and fails in one specific way

| | ±25ms | ±50ms |
| --- | --- | --- |
| Overall F1 | **8.7%** | 14.4% |

Against 51% on the synthetic oracle. The confusion matrix says why:

- kick → **crash ×122**, ride ×50, *kick ×12*
- snare → crash ×85, ride ×29, **snare ×1**
- predicted **393 crashes** where 29 exist; **168 rides where there are none**

It calls almost everything a cymbal. Real drum audio — ringing cymbals, overhead
bleed, mp3 and separation artifacts — has high-frequency energy everywhere, so a
`high-frequency ⇒ cymbal` rule fires on nearly every onset. The synthetic oracle
had clean isolated hits and never exposed this.

Timing held up far better than classification, as always: 60% of matches inside
±25ms, mean error +13ms.

**Conclusion: hand-tuned band-energy classification is structurally wrong, not
under-tuned.** Do not try to fix it by moving thresholds.

## The plan: stop classifying, separate instead

Classification is the broken half; onset detection is the solved half. So remove
the need to classify:

```
song → drum stem (Fadr/Demucs — already works)
     → per-instrument stems (kick / snare / toms / hats / cymbals)
     → onset detection on EACH stem   ← the part measured at 99.3% within ±25ms
     → .mid
```

Each lane becomes its own onset-detection problem, which is the thing that
already works. Demucs-derived models exist for drum sub-separation.

**Constraints that shape this:**

- It needs PyTorch and model weights (GBs), so it is an **offline script**, not
  app code. It emits a `.mid` the user imports normally — the app's "MIDI only,
  never infer from audio" rule is not being relaxed.
- The user has a Jetson Orin, which is a better host than the laptop.
- **Expect kick and snare to get good; cymbal articulation (crash vs ride vs open
  hat) to stay hard.** Consider shipping graceful degradation: a 3-lane chart
  (kick / snare / everything-else) that is 85% right is better practice material
  than a 6-lane chart that is 40% right.

**Measure before believing.** This harness exists for exactly that, and it has
now twice contradicted an assumption that felt safe. Run any new pipeline
against BOTH practice-groove (clean, known truth) and the Taylor Swift stem
(real, ground truth), and report both — the gap between them is the finding.

## Where sheet music fits

Digital scores (MusicXML, Guitar Pro, MuseScore) export to MIDI directly, so
they're a **source of MIDI, not a new input type** — useful because tabs exist
for songs with no standalone `.mid`, and needing zero app code. Scanned/paper
notation needs OMR, which is weakest exactly on percussion (x noteheads, stem
direction for hands vs feet).

Either way, sheet music **does not solve alignment**: it's in musical time
(bar 34, beat 2) and has no idea the recording sags to 109.68bpm. It lands you
where you already are — correct notes, unknown alignment — and still needs Sync.

The two sources fail in opposite directions, which is what makes them
complementary:

| | notes (what) | times (when) |
| --- | --- | --- |
| sheet music / MIDI | human-accurate | musical time only |
| audio transcription | weak, esp. cymbals | correct by construction |

Take the notes from the symbolic source and the times from the audio, and that's
**score-to-audio alignment** — a far more mature problem than drum
transcription. The concrete upgrade is DTW instead of the current linear
`offset + tempoScale`: a nonlinear time map handles rubato and drift natively,
and would eat the ~82ms bow the linear model leaves in the middle of the Queen
pair (its tempo isn't merely different, it isn't constant). Banded DTW over
~17k onset frames is fast in numpy. Worth doing regardless of where the notes
come from.

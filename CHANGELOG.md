# Changelog

Technical record of what was done, decided, and discovered. Why, not just what.
Most recent first.

---

### 2026-07-19: pipeline regression net + robustness on bad inputs

The transcription pipeline had zero automated coverage — a dependency bump or a
script edit could break it and only surface a hardware session later.
`scripts/transcribe/test_pipeline.py` (`npm run test:transcribe`) is the
tripwire: it runs the whole pipeline on the committed oracle and on degenerate
inputs, asserting **plumbing, not accuracy** (accuracy lives in `scripts/eval/`
and is bottlenecked on ground truth). 18 checks. Not in `npm run test` — it
needs the venv and takes ~30s.

The robustness pass found two honest-error problems, both fixed in
`chart_from_audio.py`:

- **Corrupt/empty audio** raised a `madmom` decode error deep in the model, and
  the pipeline forwarded the raw traceback — which the app's error toast shows
  the user verbatim. Now: "Could not read X as audio. It may be corrupt, empty,
  or an unsupported format."
- **Too-short or silent audio** produced no notes, reported as "transcription
  produced no .mid" — reads as a bug when the truth is "nothing to chart." Now:
  "No drums were detected in X. It may be too short, nearly silent, or contain
  no drum part."

Verified the app path: the transcription service takes the script's last stderr
line, and for both cases that line is now the clean sentence. Mono audio works
(261 notes); missing file already errored cleanly. The demucs separation step
runs `--no-separate` in the test for speed and determinism, so it's exercised by
hand rather than here — the wrapper around it already degrades to ungated on
failure.

**Confirmed while here:** judging never reads velocity, so ADTOF's flat
velocity-100 output needs no correction.

### 2026-07-19: kit icons in the lanes

Each lane now carries a line-art icon of its drum, up the lane where the eye
already is while tracking falling notes — the point is learning which lane is
which *without* looking away, which a label at the bottom edge cannot do.

**Vector, not PNG**, and the reasons are practical rather than aesthetic: the
icon takes the lane's own colour, sits at whatever alpha keeps notes legible,
and stays sharp at any lane width on any display. Raster assets would need a
set per colour and per scale and would add binaries to the repo. Cost is about
a dozen path operations each per frame, nothing beside the note loop.

Shapes are built to differ **in silhouette**, because at 13% opacity behind
moving notes that is all you get: crash is tilted where ride is flat, and the
tom is a narrower, deeper drum than the snare rather than a smaller copy of it.
The hi-hat needed a second pass — at realistic spacing its two cymbals merged
into one blurred shape at watermark opacity, so they are thinner and further
apart than a real closed hi-hat.

Verified in the running app with notes actually falling through the icons, not
on an empty lane: notes remain the brightest thing by a wide margin.

### 2026-07-19 (last): chart generation in the app

**"Audio only…" in the Library**: pick a song's audio, and the app separates the
drums, transcribes them, imports the result and lands on Sync — about a minute.
`scripts/transcribe/chart_from_audio.py` is the pipeline (it encodes the three
measured rules: transcribe the mix, gate with a stem, crash=0.55);
`transcription-service.ts` spawns it and streams stage lines to the window that
asked.

**This narrows critical rule 2 rather than breaking it, and CLAUDE.md now says
so explicitly.** The rule forbids *implicitly* inventing notes — a fallback for
a missing MIDI, where a meaningless score is indistinguishable from a real one.
Transcription here is never a fallback (a failed MIDI import stays failed), is
always asked for, and every generated song is stored `chartSource:
"transcribed"` and badged **Generated** wherever it appears. The app still
charts from a `.mid`; this only produces one.

**Demucs instead of driving Logic Pro.** The suggestion on the table was to
automate Logic's Stem Splitter. Logic has no scripting API for it, so that means
GUI automation — breaks on every Logic update, needs the app frontmost, cannot
run headless. Logic's splitter is Demucs-derived anyway, so the library gets
equivalent stems and is scriptable. Measured equivalent on drop dead: demucs
gating produced 1,131 notes against the Fadr stem's 1,133, and its stricter
separation put the first note at 58.5s, matching the original stem exactly.

**The toolchain is external, not bundled** — the venv is ~1.9GB against a 115MB
app. `findToolchain()` locates it, `songs:canTranscribe` reports presence, and
the button does not exist on a machine without it. Absence produces setup
instructions, never a stack trace.

**A bug this found, which would have quietly ruined sparse songs.** The first
gate checked only the 100ms window containing a note's onset. A 100ms RMS
average flattens a transient, and a hit landing late in its window barely
registers — so on practice-groove it deleted **200 of 262 notes**. Dense songs
hide this completely, because neighbouring hits keep every window loud, which is
why drop dead looked fine. Two fixes: check the window spanning a hit's decay
(−50ms to +150ms) rather than a single slot, and **abandon gating entirely if it
would remove more than 40% of the chart** — a stem that disagrees that violently
is the wrong file or a failed separation, and deleting most of a song is far
worse than the phantom notes gating exists to remove. Verified both ways: the
sparse song keeps all 262 with a warning, the dense song still gates 1202 → 1140.

### 2026-07-19 (late): the full mix's two costs, both fixed

Playing a mix-transcribed chart surfaced exactly the two failures the Red
measurements predicted, in the order of how audible they are.

**"Phantom kick drums at the beginning."** On a stem, silence yields no notes;
on a mix, bass and vocals sit in the kick band and the model charts them.
Measured on *drop dead*: first charted note at **11.44s, drums do not enter
until 30.0s** — 12 phantom kicks over an intro with nothing else to play, which
is why it was the first thing noticed. New `--gate-with <drum stem>` drops notes
where the stem is silent (threshold relative to the stem's own 90th-percentile
RMS, so it travels between songs). First note moved to 43.1s, 27 notes dropped,
7 hi-hats lost. The `.mid` is rewritten after gating — `predictFolder`'s copy is
the ungated one, and shipping that would have made the fix invisible.

**"Parts where it drops a consistent crash cymbal."** The cymbal threshold is
tuned for stems. Swept against Red's human chart:

| `crash=` | crash precision | crash F1 | overall F1 |
| --- | --- | --- | --- |
| 0.30 (default) | 23.2% | 35.5% | 70.3% |
| 0.40 | 36.2% | 48.3% | 71.3% |
| **0.55** | **54.1%** | **60.6%** | **71.8%** |
| 0.70 | 50.0% | 6.5% | 71.3% |

0.55 is a genuine optimum rather than a point on a slope — 0.70 collapses crash
recall to 3.4%, so the cliff is close and nobody should push past it. Exposed as
`--threshold CLASS=VALUE` (the model's per-class thresholds were already in
hparams). **Tuned on one song**; recorded as a default, not a law.

Recommended invocation is now: transcribe the mix, `--gate-with` the stem,
`--threshold crash=0.55`.

**README rewritten** with a **Known issues** section covering all of it —
transcription quality, the alignment ambiguity (including that 87% of preview
clicks still land when a full beat wrong, so the ear cannot always settle it),
unmapped notes, same-lane collisions, and packaging. Stale test count fixed
(65 → 93) and the transcription pipeline documented as a third source of charts.

### 2026-07-19 (night): transcribe the mix, align the stem

**The intuition was backwards, and one harness run showed it.** The reasoning
had been "separation artifacts confuse the model, so give it the cleanest
input". In fact ADTOF was trained on full mixes, and separation *removes* quiet
hi-hats before the model ever sees them. Red against its real human chart, both
sides pinned to the same established alignment so alignment is not a confound:

| | drum stem | full mix |
| --- | --- | --- |
| Overall F1 @±25ms | 66.4% | **70.3%** |
| hi-hat F1 / recall | 47.4% / 34.3% | **61.5% / 51.7%** |
| crash precision | 45.2% | 23.2% |
| inside ±25ms | 94.3% | 96.1% |

101 more real hi-hats — the pipeline's single biggest weakness, and the thing
the user actually noticed missing. The cost is cymbal precision (95 crashes
predicted where 29 exist) because guitar and vocals put energy in the same
band. Worth taking: a chart missing a third of its hats feels empty, extra
crashes are wrong notes in one lane.

**Transcription and alignment want OPPOSITE inputs, and both are measured.**
Stem alignment locks 3.04 vs the mix's 0.65; mix transcription beats stem
transcription. So the workflow is: transcribe the mix, attach the stem in Sync.
`scripts/transcribe/README.md` said the opposite and has been corrected.

**Two paths closed cheaply.** Full-mix input does NOT rescue *Hounds of Love*
(67% toms / zero hats / zero cymbals from the mix, 62% from the stem), so that
collapse is a training-domain problem, not a separation artifact. And the pip
package registers ~60 model names while shipping weights for exactly one
(`Frame_RNN_adtofAll_0`) — "try another checkpoint" is not a local option.

**Caveat recorded, not buried: n=1.** Red is the only pair with a human
ground-truth chart, so the quantitative claim rests on one song. The other two
were transcribed both ways and their class distributions barely moved.

**Fixed:** `adtof_transcribe.py` accepted a folder in its `--help` but
`predictFolder` hands the directory to the decoder and dies with
`IsADirectoryError` — after the model has loaded, which is the slowest possible
way to find out. It now iterates files itself.

### 2026-07-19 (evening): the estimator's real bug, and a canvas that never scaled

**The alignment estimator's problem was candidate GENERATION, not the metric.**
The known-truth oracle (an ADTOF chart against the audio it was transcribed
from) made this diagnosable in one run: on drop dead the truth scored f1
**0.705** against the winning candidate's **0.664** — so the metric ranked it
correctly and would have picked it — but it was never in the list. The nearest
candidate sat 206ms away.

Cause: candidates are whole-BEAT shifts of an anchor, so the anchor's sub-beat
phase is inherited by all of them. The seed sat 1844ms out, which is 3.9 beats
— not a whole number — so no enumeration could ever reach the truth, and the
per-candidate ±40ms retune could not cross the gap.

**The first fix was wrong in an instructive way.** A local phase search anchored
to the seed moved to a higher-scoring phase *inside its own window* and broke
Hounds of Love, which had been correct at 3ms, sending it to 1648ms. The best
phase is not necessarily near the seed. Sweeping the whole span the candidates
cover is what works.

**Second bug found while testing the first: an edge-of-plateau bias.**
`scoreSymmetric` matches within ±30ms, so on clean audio the score SATURATES —
a whole ~60ms band scores identically and `argmax` returned whichever edge it
scanned first. On synthetic click tracks that showed as a dead-constant ~30ms
error, independent of note count and of the true offset. *A tight error around
a non-zero mean is a systematic bug, not noise* — the third time that reading
has paid out here. Taking the centre of the winning plateau: 30ms → 6-9ms.

Measured against all three real songs with established truth:

| song | truth | before | after |
| --- | --- | --- | --- |
| drop dead | 0ms | 1844ms | **4ms**, confident |
| Hounds of Love | 0ms | 3ms | **8ms**, confident |
| Red (vs stem) | −1501ms | ranked 16th of 17 | **−1506ms** |

**The gameplay canvas was drawing in device pixels.** The backing store is sized
`clientWidth * dpr` for sharpness, but the context was never scaled, so every
hand-tuned constant was half-size on a Retina display: 11px lane labels rendered
at 5.5 CSS px, notes at 5px, the hit line as a hairline. Sizes derived from W/H
(lane width, hit-line position) scaled correctly all along, which is exactly why
it hid — it presented as "the labels are too small", a design complaint, rather
than as a scaling bug. Fixed by `ctx.setTransform(dpr, …)` and drawing in CSS
pixels throughout. Labels also moved from the bottom edge to a coloured chip
just under the hit line, where the player is already looking.

### 2026-07-19 (later): 670 invisible notes — unmapped notes were unreachable by design

**The user played Red and reported "a section missing hi-hats". They were right,
and it was not the chart's fault.** Red carries **670 Tambourine (54) notes —
34% of its 1,944** — and 54 is not in `DEFAULT_MIDI_MAPPING`, so every one was
dropped. In the section they noticed (140–160s) the chart has 114 tambourine
notes against 18 hi-hats: the tambourine *replaces* the hat pattern rather than
doubling it (only 4.3% of tambourine hits share a timestamp with a hat). So a
third of the song was invisible, and the player correctly read that as a hole.

Excluding unmapped notes remains right — scoring them as misses would punish the
player for the app's ignorance of their kit (critical rule 3). **Doing it
silently was the bug.**

**The deeper problem: those notes were unreachable.** Learn maps whatever pad
you HIT. No e-kit sends a tambourine note, so there was no path — through any
UI — to assign note 54 to a lane. The mapping editor quietly assumed every
chart note is one your kit can produce. Charts with tambourine, cowbell,
claps or shakers break that assumption, and the more of a chart sits on such
notes the more invisible it becomes.

**Fix:** `findUnmappedNotes()` (pure, tested) scans every chart in the library
against the current mapping, and Settings grows a section listing each unmapped
note with its GM name, how many notes carry it, and which songs — with six lane
buttons to assign it. Verified by driving the built app: the section showed
"54 / Tambourine / 670 notes / Taylor Swift - Red", clicking Hi-Hat persisted
`54: "hihat"`, and the section then disappeared — the list empties as it is
acted on, so the warning cannot decay into noise.

**Known consequence, not yet handled:** the 29 timestamps where tambourine and
hi-hat coincide now put two notes in one lane at the same instant, which can
only be hit once. ~1% of the song, so not urgent, but "two chart notes mapping
to the same lane at the same time" is a general case gameplay does not collapse.

### 2026-07-19: Red's true offset settled; a free oracle for the estimator; the ear test has a limit

**Red's correct offset is −1501ms, and it is now established without any audio
envelope.** Matched the human 1,944-note chart against ADTOF's independent
transcription of the drum stem — two note lists, no correlation, no envelope,
fully independent provenance:

| offset | chart↔transcription agreement |
| --- | --- |
| **−1501ms** | **96.4%** |
| −1969ms (the mix estimate) | 87.7% |
| −3418ms (what was saved) | 87.4% |

Sharp peak: ±10ms around −1501 stays at ~96%. This supersedes the earlier
hedged claim; the renderer's estimator had it in the candidate list all along
and ranked it near last.

**Why the ear could not settle it — a real limit on this project's oracle.**
At an offset a whole beat wrong, **87.7% of clicks still land on a real drum**,
because kick/snare in dense pop sit on a regular grid. The user reported the
wrong alignment as sounding aligned, and that was a correct report of what is
audible. *The ear is authoritative for feel but NOT for bar/beat ambiguity on
dense material.* Where symbolic ground truth exists, prefer it and use the ear
to confirm, not to decide.

**A free oracle arrived, unplanned.** An ADTOF chart played against the stem it
was transcribed FROM has known-exact alignment (offset 0, scale 1) — the same
property practice-groove was built for, but on real audio. Two such pairs now
exist, and they disagree in a diagnostic way:

| pair | estimator said | truth | verdict |
| --- | --- | --- | --- |
| Hounds of Love | 0.003s / 100.010% / 80%, "one clear winner" | 0 / 1 | **correct** |
| drop dead | 1.844s / 100.010% / 68%, "too close to call" | 0 / 1 | **wrong by 1.844s** |

So the estimator is not uniformly broken — it nails one and misses the other.
The salient difference: **drop dead has 58s of near-silence before the drums
enter** (measured: RMS 0.0003 until second 58, chart's first note 58.520s),
which would skew a standardized envelope's mean and stdev. That is the first
hypothesis to test, and the tempo scale was right in both cases — it is
specifically offset ranking that fails.

**The ADTOF charts themselves fail in the opposite direction from each other**,
which is the more useful finding for the transcription workstream:

- **drop dead**: plausible distribution (kick 30%, hihat 33%, snare 25%,
  cymbal 6%, tom 6%). Transcription looks sane; alignment is what broke.
- **Hounds of Love**: **62% toms (575 of 923), zero hi-hats, zero cymbals.**
  Not credible for any pop record. ADTOF collapsed the kit. The user heard this
  as "doesn't sound right" while the alignment was provably perfect — the ear
  was right, and it was diagnosing transcription, not sync.

Both are consistent with the measured weakness: ADTOF under-charts hats
(34% recall) and this is what that looks like at its worst, on a 1985
Fairlight/gated-drum production well outside its rock-game training domain.

**Confirmed in play, then corrected.** The user played drop dead and reported
fills arriving "seconds later" — the 1.844s error, felt rather than measured.
A third implementation (the Python harness's `--auto-align`, a different
scoring metric from the renderer's) independently returned **+0.007s, scale
1.00000, lock 2.94 confident**, agreeing with the by-construction truth. Both
songs' stored alignments were then set to their measured values —
drop dead `0 / 1.0`, Red `−1501ms / 0.984`, both `source: "manual"` because
they came from outside the estimator.

**Fixed:** bar/beat nudges are now scaled into audio time (`× tempoScale`).
They were sized from `song.bpm` in chart seconds while `offsetMs` shifts along
the audio. On Red the error compounds: four beat-nudges landed 34ms off the
correct offset and *no* combination of buttons could reach it. Scaled, four
beat-nudges land within 3ms.

### 2026-07-18 (night): Sync-against-stem shipped; the estimator has a ranking problem

**Feature.** A song can carry an optional isolated drum stem
(`analysis.<ext>` in its folder, `analysisAudioFile` in song.json, attached
via `songs:setAnalysisAudio`). Sync's estimator decodes it instead of the
playback audio; playback and gameplay never touch it. Rationale measured
2026-07-18: stem lock 3.04 vs mix 0.65 in the Python harness. The stem is
COPIED in, like import audio — a song must survive its Downloads folder being
cleaned. Analysis decodes are deliberately uncached: a replaced stem reuses
the same file name, so any stable cache key would serve the old bytes.

**Verified by driving the real dev app over CDP** (attach → disk → decode →
estimate → UI), not just types. The probe compared full-mix vs stem analysis
on Red and found something bigger than the feature:

**The renderer's candidate ranking scores the truth 16th of 17.** Three
independent measurements corroborate Red's offset at ≈−1501ms (Python stem
lock 3.04; ADTOF's independent transcription agreeing with the chart to 94.3%
within ±25ms at that offset; identical tempoScale from every path). The
renderer's `analyzeAlignment` has that offset in its candidate list (−1482ms,
"+8 beats") but scores it f1 0.585 while every beat-shifted WRONG candidate
scores ~0.62 — a flat, inverted landscape where the Python z-score metric
separates 3.04 vs 0.65. The saved alignment (−1969ms, `source: "auto"`, never
ear-confirmed) is therefore probably one beat off. Not chased tonight: the
scoring is tuned code entangled with Sync UX, and the ear-check that settles
which offset is right happens at the kit tomorrow anyway. Full notes in
PROGRESS → What's next #2.

**Consequence shipped tonight:** ±1 beat nudge buttons on Sync. The observed
ambiguity is beat-shaped, and the prior controls (±1 bar, ±10ms) made a
one-beat correction cost 48 clicks.

**Also:** `chart-parse.test.ts` closes the chart.ts coverage gap through real
MIDI byte round-trips. MIDI fact asserted en route: a velocity-0 note-on is
the note-off idiom, so it can never become a chart note.

### 2026-07-18 (later): Pretrained ADTOF replaces the separation plan

**Decision: measure existing pretrained models before building the separation
pipeline.** The prior plan (drum stem → per-instrument stems → per-stem onset
detection) was reasoned but had two problems: it was days of work, and it
leaned on the "99.3% onset timing" number, which was measured on *clean* audio
— separated stems bleed, so per-stem onset detection quietly re-imports
classification as thresholding. The harness's `--candidate` interface existed
precisely to test a real model first. An hour of setup answered the question.

**ADTOF is the answer, and by a wide margin.** It is a CRNN trained on
crowdsourced *rhythm-game drum charts* — the exact artifact this app consumes,
with the rhythm-game 5-lane vocabulary. On the real Taylor Swift Fadr stem:
**66.4% F1 @±25ms vs the baseline's 8.7%** (kick 88.5%, snare 78.8%, 94.3% of
matches inside the Perfect window). Weaknesses: hi-hat recall 34% (but
precision 77% — under-charts, doesn't hallucinate), toms over-trigger, single
cymbal class. Full numbers in `scripts/eval/README.md`; usage and limits in
`scripts/transcribe/README.md`. Separation is demoted to a fallback that must
now beat 66.4%.

**Deliverable**: `scripts/transcribe/adtof_transcribe.py` + `.venv-adt`
(Python 3.11 — the ADT ecosystem breaks on 3.12+). Charted the two stem-only
songs the user had no MIDI for (Kate Bush – Hounds of Love, 923 notes;
Olivia Rodrigo – drop dead, 1,071 notes) → `~/Downloads/adtof-charts/`, both
verified channel-9 percussion that `parseChart`/`looksHarmonic` will accept.

**Two silent failure modes found and encoded in the script:**

- ADTOF's checkpoint is Keras 2; under Keras 3 it dies on
  `keras.optimizers.legacy`. Fix: `tf_keras` + `TF_USE_LEGACY_KERAS=True`,
  set inside the script before TF imports.
- ADTOF discovers input via `glob`, so Fadr's `[fadr.com] …` paths (brackets =
  glob character class) match nothing — **no output, no error**. The script
  stages such paths to a clean temp dir. This one cost a debugging cycle and
  would have cost the user more.

**Interpretation note for future measurements**: the synthetic oracle flipped
from optimistic (for hand-tuned DSP: 51% → 8.7% real) to mildly pessimistic
(for a learned model: 55% synthetic vs 66% real — the rendered kit is
out-of-domain for a model trained on records). practice-groove still catches
"the code is wrong", but its score no longer predicts real-audio quality in
either direction. Report both songs, always.

### 2026-07-18: Played on a real kit; chord-file imports; the transcription verdict

**The premise is validated.** The user connected their e-kit and played a song
through successfully. Everything before this was inference from a MIDI simulator;
this is the first time the app did the thing it exists to do.

**Published**: github.com/chanfriendly/drum-trainer, public, MIT. Verified before
pushing that no third-party audio or MIDI is in the repo *or its history* — only
practice-groove, which we generate.

**The "Fadr transcribes drums badly" report was a misdiagnosis, and the truth was
worse.** Fadr never attempted drum transcription. Its MIDI export is *pitch*
transcription — chords, bass, vocals — because pitch is what it detects; drums
are unpitched, so no drum track is produced at all. Parsing the files:

| Fadr output | notes | percussion? | what it is |
| --- | --- | --- | --- |
| `midi.mid` | 294 | no | chords (A♭/D♭/E♭ triads) |
| `midi-bass.mid` | 277 | no | bass |
| `midi-other.mid` | 580 | no | other pitched |
| `midi-vocals.mid` | 396 | no | vocals |

**Three of the five songs in the user's library were chord exports imported as
drum charts.** Every event was exactly three simultaneous notes, 1.7–2.5s apart.
The symptom was never "wrong notes" — it was gameplay feeling broken and Sync
reporting near-zero confidence (0.05–0.08), which reads as an app bug. The
estimator had been correct the whole time: a chord progression genuinely does not
align to drum hits. Import now rejects harmonic files (`looksHarmonic` in
`chart.ts`), requiring three signals to agree so a genuine chart is never blocked.

**The transcription measurement, on real separated audio.** Ground truth: the
user's real 1,944-note Taylor Swift drum chart. Audio: a Fadr-isolated drum stem.

1. *Isolated stems are a big win for ALIGNMENT.* Lock **3.04** against the stem
   vs **0.65** against the full mix, same tempo scale recovered. Added
   `--auto-align` to the harness to measure this.
2. *The baseline transcriber is dead.* **8.7% F1** — against 51% on the synthetic
   oracle. It predicted 393 crashes where 29 exist and 168 rides where there are
   none: real drum audio has high-frequency energy everywhere (ringing cymbals,
   bleed, separation artifacts), so a `high-frequency ⇒ cymbal` rule fires on
   nearly every onset. The harness's own "optimistic upper bound" warning came
   true, hard.

Conclusion: band-energy classification is *structurally* wrong. The plan is to
stop classifying — split a drum stem into per-instrument stems and run onset
detection on each, since onset timing is the part already measured at 99.3%
within ±25ms. Written up in `scripts/eval/README.md`.

**Toast flood fixed properly.** A MIDI device that fails to open produced dozens
of identical toasts. Memoizing the context value earlier removed one cause but
not the behaviour — I was wrong to call it fixed. Now handled at two layers: the
toast system refuses to stack an identical message, and Settings does not attempt
to open a device that isn't in the device list, showing a persistent inline
banner instead. A persistent condition deserves persistent UI; a toast that must
be re-shown is a toast that gets shown in a loop. This is the unplugged-kit case.

---

### 2026-07-17: Ranked alignment candidates — the way out of the bar ambiguity

Auto-align used to hand back one answer it couldn't defend, and the UI told the
player to nudge until it sounded right. Now it enumerates the alternatives,
scores them symmetrically, and reports them ranked with the margin between them.

**The metric was the whole problem, and the fix was already written down** — in
tests/alignment.test.ts: *"If the metric is ever changed to penalise unmatched
audio onsets, landmarks WOULD start to help."* The old score is a MEAN of
envelope strength where chart notes land: it rewards notes hitting onsets and is
blind both to onsets nobody played and to notes landing in silence. That is
precisely why every bar looks alike to it. `scoreSymmetric` counts both
directions (an F1 over chart↔audio), so a shifted chart starts before the drums
come in and leaves real hits unexplained at the end. The song's edges finally
count.

**Two measurements changed the design mid-build:**

1. *The ambiguity is per-BEAT, not per-bar.* Enumerating whole bars left the
   truth outside the candidate set entirely — a synthetic test failed by exactly
   501ms, one beat at 120bpm. A kick/snare groove repeats every two beats, so
   candidates are now spaced by beats and labelled "+1 beat" / "−1 bar".
2. *Precision was capped and nearly useless.* Scoring only kick/snare notes
   against ALL audio onsets caps precision at roughly beatNotes/onsets —
   measured 0.545 for the truth vs 0.505 for the runner-up, i.e. flat. Feeding
   the symmetric score every note (while the seed search keeps using beat notes,
   since hats smear a mean) took the oracle from F1 0.70 → 0.82 with precision
   0.807.

**And it forced an honest constant.** The confidence threshold was invented at
0.08. Measured on the oracle — audio rendered from its own chart, the clearest
case that can exist — the truth beats the runner-up by only **0.050** (0.819 vs
0.769). Repetitive grooves just don't separate by much. The threshold is now 0.04,
calibrated on that single data point, documented as such, and `confident` is a
hint that sets the UI's tone rather than permission to skip the preview.

**Fit residual / "this recording breathes".** The linear model assumes one tempo.
`analyzeAlignment` now fits each 20s window's own best offset (searched ±0.4s —
under half a bar, so a window can't hop a bar and call it residual) and reports
the worst deviation. Over 25ms means no single tempo fits the take, and the UI
says so and points at Logic's Smart Tempo. This answers "will this file work?"
BEFORE playing it — the old "drift" number only reported the linear mismatch and
was silent about the wobble around it.

12 new tests (65 total), including the oracle asserting the winner is right, the
margin is real, and precision is doing work.

**NOT VERIFIED:** the candidate list's rendering. The screen locked mid-test, so
the UI has only been type-checked and its logic unit-tested. Drive it before
trusting it.

---

### 2026-07-17: Calibration, and a getting-started guide

The last placeholder is gone — **all five screens are real**, plus Sync.

**Calibration** derives `latencyOffsetMs` from tapping along to a metronome.
Design notes worth keeping:

- *Median, not mean.* One flubbed tap 300ms out drags a mean of twelve samples by
  25ms — the entire Perfect window. Spread is reported as a MAD, which one
  outlier can't inflate either.
- *Consistency is the honest number.* A confident-looking offset built from
  scattered taps is worse than none, so a run with >50ms spread is REFUSED rather
  than saved. The UI leads with consistency, not the offset.
- *It measures the player, not just the gear, and that's correct.* Humans tap
  early against a metronome (negative mean asynchrony, 20-50ms, person-specific).
  That bias belongs in the number because the goal is judging THIS player fairly
  — which also means the offset is per-player, not a kit constant.
- *Clock assumption, stated in the file:* gameplay judges against an `<audio>`
  element's currentTime; calibration schedules on an AudioContext and reads
  `ctx.currentTime`. Different playback paths. They share an output device so
  they should agree, but "should" is doing work — it's the first thing to suspect
  if a calibrated offset feels wrong in play.

**Measured: end-to-end MIDI jitter is ±4ms.** A machine tapping at exact 600ms
intervals produced 4ms of scatter through CoreMIDI → addon → IPC → clock read.
That's well inside the ±25ms Perfect window, and it answers a question open since
session 0: the plumbing is precise enough to judge drumming. Human taps will be
looser, but the floor isn't the software.

**README.md** — the getting-started guide, written to answer "what would we tell
a new user?". The load-bearing parts: the kit needs nothing but USB (no Logic, no
DAW); sheet music is a SOURCE OF MIDI (MuseScore/Guitar Pro export) rather than a
separate input; Sync is not optional and the bar nudge is not polish; and a
symptom table whose rule of thumb is **consistent error = settings, growing error
= sync** — the distinction this whole codebase keeps having to teach.

17 new tests (53 total).

---

### 2026-07-17: Transcription evaluation harness

`scripts/eval/` — answers "how good would audio transcription have to get before
it could replace a MIDI chart?". The rule that the app never charts from audio
does not change; this measures what the alternative would cost. Reference MIDI vs
candidate transcription, Hungarian matching within tolerance, per-lane P/R/F1, a
time-only confusion matrix, and a timing histogram, scored at BOTH ±25ms (the
app's Perfect window) and ±50ms (the research standard).

The harness is the durable part; the bundled transcriber (spectral flux + band
energy, no downloads) is a deliberate floor that a real ADT model swaps in behind
`--candidate`.

**It caught a bug in itself, twice.** First run: mean timing error -31.7ms with a
stdev of 4.8ms — a bias that constant is never transcription error, it's framing.
The same FRAME_LEAD trap as alignment.ts. Then the fix went in with the WRONG
SIGN, doubling the error to -60ms and collapsing F1 to ~0, which is how the sign
got caught. Corrected: mean -2.9ms, stdev 3.8ms. The lesson generalises: a tight
stdev around a non-zero mean is a systematic bug, and the spread is the number to
read, not the average.

**Timing is not the bottleneck — classification is.** On Practice Groove (the
only clean evaluation), ±25ms F1 is 51.3% and ±50ms is 51.6%. The gap is 0.3
points and 99.3% of matched onsets land inside ±25ms. That settles the earlier
open question about the ±25/±50 gap: once framing is right, onset placement on
clean audio is solved. Per lane the failures are lopsided — kick 80%, hihat 64%,
but ride 3.5% (1 of 56, called a hi-hat 40 times), snare 0%, tom 0%. The
predicted cymbal confusion arrived exactly as predicted.

**On a real mix it falls apart informatively.** Queen (confounded): 17.8% F1 at
±25ms. The interesting part is what it INVENTS: the chart has zero crashes,
rides and toms; the baseline reported 402 crashes, 248 rides and 13 toms — 663
notes hallucinated from guitar, bass and vocal energy landing in the bands the
classifier reads as cymbals. Isolated drums never told us that; one run on a real
record did. Timing stdev jumps 3.8ms → 25.2ms and the ±25/±50 gap reopens, but
that is partly the confounded alignment and the harness cannot separate the two —
which is the honest limit of a confounded evaluation, and why it prints a warning
rather than a tidy number.

**Conclusion:** transcription is nowhere near replacing a MIDI chart, and the
reason is specific — classification (especially cymbals) and catastrophic false
positives in a full mix, not timing. Source separation before transcription
attacks exactly that failure; the harness makes the experiment cheap.

**Sheet music** (asked alongside): digital scores are a SOURCE OF MIDI, not a new
input type — MusicXML/Guitar Pro/MuseScore export MIDI directly, needing zero app
code, and covering songs with no standalone .mid. Scanned notation needs OMR,
weakest exactly on percussion. Either way it does NOT solve alignment: it's in
musical time and has no idea the recording sags to 109.68bpm. The complementary
pairing (notes from the symbolic source, times from the audio) is score-to-audio
alignment, and the concrete upgrade there is DTW instead of the linear
offset+tempoScale — a nonlinear map would eat the ~82ms bow the linear model
leaves mid-song on the Queen pair. Written up in scripts/eval/README.md.

---

### 2026-07-17: Settings, Results, and a committed MIDI harness

**`scripts/midi-sim.mjs` — the kit simulator.** The IAC bus cuts both ways: the
same virtual cable the app listens on can be written to. This plays the part of
an e-kit (`burst`, `note <n>`, `chart <file>`, `devices`), so nearly everything
can be exercised with no hardware in the room. It was a throwaway in a scratch
dir; it earned promotion the moment it produced the first real score.

What it does NOT cover, and the docs say so: timing *feel*, velocity curves,
hi-hat pedal CC, double-triggering, unplug/replug. Note times are wall-clock from
launch with no way to sync to the app's audio clock, so expect Early/Late rather
than Perfect — that's the harness's imprecision, not the judge's.

**Settings** — the screen that made the app usable at all. Until now the MIDI
device could only be chosen by hand-writing localStorage from the DevTools
console. It has the device picker, the note→drum mapping with per-drum Learn,
hit windows, and the latency offset.

*The input monitor is an addition, and earns its place.* When a kit doesn't work
the questions are always "is anything arriving?" and "what note is this pad?".
Without it the answer is a silent screen and the player can't tell a dead cable
from a wrong mapping. Verified: sending note 38 shows
`note 38 velocity 100 → Snare`, live.

*Learn verified end to end, on the case that motivated it:* armed Learn on Snare,
sent note **39 (Hand Clap)** — the exact note the Queen chart has 75 of and the
default GM mapping ignores — and it mapped, persisted through a remount, and now
reads `37, 38, 39, 40`. That closes the carried-over checklist item "MIDI with
notes outside the default GM mapping — mappable via Learn without re-import".

**Results** — per-song history, newest first. Read-only; gameplay already wrote
the data and nothing read it. The per-drum breakdown is the point: one accuracy
number says you did badly, the breakdown says it was the ride. Verified against
the real saved run — 3,004 / 7.2% / 20x / 316 notes, and per-drum bars showing
Hi-Hat 29/128 but Tom 0/17, Crash 0/5, Ride 0/56 (the blind sender never hit the
sparse lanes). Lanes a chart never uses are omitted rather than shown as 0/0
failures.

Calibration is now the only placeholder left.

---

### 2026-07-16: Gameplay — canvas, judging, and the first real MIDI hits

The core loop works end-to-end: **import → sync → play → judge → save → results**.

**Verified by driving the real app with real MIDI.** The IAC bus cuts both ways —
a script opened an *output* on `IAC Driver Bus 1` and played the part of an
e-kit, so the whole chain ran for the first time: CoreMIDI → native addon → main
→ IPC → renderer → judge → HUD. Score reached 3,004 live on screen.

The saved result's accounting is exact, which is the assertion that matters:
`9 perfect + 14 good + 8 early + 10 late + 275 miss = 316 = totalNotes`. Every
note resolved exactly once — no double-counting, no leaks. Saved accuracy
(7.22%) matches an independent hand-check of the spec formula to the digit.
(275 misses is correct: the sender only ran for 9s of a 61s song.)

**Range requests work.** Seeking to 58s in the console worked
(`seeked to 58, duration 63.7`), which exercised the hand-rolled 206 /
`Content-Range` path for the first time — the last untested surface in
`song-audio://`. `decodeAudioData` fetches whole files, so only media seeking
reaches it.

**Alignment is applied once, up front.** Every note's `audioTime` is precomputed
via `chartTimeToAudioTime`, so the render loop and the judge compare audio time
to audio time and never think about alignment again. Gameplay warns when
`alignment.source === "none"` rather than silently judging a drifting chart.

**Three fixes over the Glaze original:**

1. *Pause had no resume.* The original's pause button stopped the audio while
   the loop kept running against a frozen clock, and the only way out was
   quitting. Now pause/resume works and judging is disabled while paused, so a
   stray pad hit can't score.
2. *The HUD accuracy read as broken.* It used the spec formula (denominator =
   every note in the song), so one Perfect into a 316-note song showed "0.3%" and
   crawled upward all song — a player would conclude the app was misjudging them.
   The HUD now shows accuracy over notes RESOLVED so far (`runningAccuracy`);
   the SAVED result still uses the spec formula (`finalAccuracy`). A test pins
   that the two converge once every note is resolved.
3. *Rescanning the whole chart every frame.* Miss detection swept all notes at
   60fps and hit-matching searched the entire chart per note-on. The chart is
   sorted, so a cursor now bounds both to the live window.

**Judging math is extracted and tested** (`judgeTiming`, `scoreForHit`,
`finalAccuracy`, `runningAccuracy`) — 17 new tests, 35 total. It was trapped
inside a React effect where no assertion could reach it, and these are tuned
values the spec says to keep exactly. One test caught my own misreading: with
`goodMs: 50`, a 40ms error is Good, not Late — the windows nest.

**Not verified, and cannot be from here:** whether a Perfect *feels* like a
Perfect. That needs the kit and ears.

---

### 2026-07-16: Sync screen — alignment wired into the app

The estimator existed and was tested but nothing called it. Now the Library has a
Sync screen: Auto-align → check by ear → ±1 bar nudge → save. Verified in the
running app against the oracle song: **confidence 4.70, offset -0.006s, tempo
100.000%, drift 0ms** — matching the vitest oracle (-6.3ms) to within a rounding
digit, through an entirely different path (fetch → decodeAudioData →
OfflineAudioContext → estimator).

**The design point: auto-align is a suggestion, not an answer.** `offsetMs` is
ambiguous by whole bars, so the screen leads with the estimate, then says in
plain text that high confidence does NOT mean the bar is right, then gives a
preview that clicks on every charted kick/snare so the player can hear whether
the clicks land on the drums. The ±1 bar nudge is the fix when they don't.
`source` is `"auto"` when the machine's guess is accepted as-is and `"manual"`
only when a human actually moved it — the two are different claims about who
chose the bar.

**`corsEnabled` — the bug this screen was built to find.** `song-audio://` had
never served a byte to the renderer. On first use it failed with a bare
"Failed to fetch". Two layers, both mine:

1. CSP: `connect-src` does NOT inherit from `media-src`. `media-src 'self'
   song-audio:` covers the <audio> element; `fetch()` falls back to
   `default-src 'self'` and is blocked. Both must list the scheme.
2. The real one: the renderer's origin is `file://`, so fetching `song-audio://`
   is CROSS-ORIGIN, and Chromium refuses before the handler runs —
   *"Cross origin requests are only supported for protocol schemes: chrome,
   chrome-extension, chrome-untrusted, data, http, https"*. No response header
   can fix that; the scheme itself must be registered with `corsEnabled: true`,
   and then the handler must also return `Access-Control-Allow-Origin`.

Worth internalising: this fails ONLY for `fetch()`. Media elements load no-cors,
so **gameplay would have worked while analysis died**, and the visible symptom
(a failed fetch) points at the file, not the protocol policy. Found it by
reading the DevTools console — the main-process log showed nothing, because the
request never reached the handler.

**Also:** `SongMeta` gains `bpm` (the MIDI's first declared tempo, or null),
used solely to size the ±1 bar nudge. Without it "one bar" is unknowable; the
screen falls back to ±0.5s and says so. Songs imported before this default to
null rather than undefined.

---

### 2026-07-16: Practice Groove — a test song with known ground truth

**Problem.** Every real audio+MIDI pair has unknown alignment, so a failure is
ambiguous: is the code wrong, or do the files simply not line up? With only the
Queen pair (which is known NOT to align) there was no way to answer that. Asked
to find a good example song, the right move was to generate one rather than hunt
for a licensed pair — matched pairs of commercial music barely exist, since the
audio is a recording and the MIDI is someone's transcription.

**What.** `assets/practice-groove/` — a 316-note, 61.2s, 100bpm chart, plus
audio **rendered from that same note list**, sample-accurate. True alignment is
therefore known: offset 0, tempoScale 1. This is the project's oracle. Original
content, so it is committed, unlike the Queen pair.

**It paid for itself immediately.** Estimator vs. known truth: **-6.3ms error,
scale 1.00000, confidence 4.78** (the Queen pair scores 2.06). The 6.3ms
residual is sub-frame quantization — a frame is 11.6ms. Without the `FRAME_LEAD`
correction the same test reads ~-35ms; no self-consistent test could have caught
that, because the bias applies equally to every candidate alignment.

**Deliberate properties, each earned:**

- *All six lanes* (kick 60, snare 50, hat 128, ride 56, tom 17, crash 5). The
  Queen chart only uses kick/snare/hat and could never surface a tom/crash/ride
  bug. Round-trips through the real parser at 100% mapped, difficulty Hard.
- *Structure, not a loop* — section changes, a 16th tom fill, a near-silent
  break. A uniform loop is inherently ambiguous to align (see the bar-ambiguity
  finding); this gives the estimator something unique to lock onto.
- *FLAC, not mp3.* mp3/AAC carry ~13-26ms of encoder delay — the same order as
  the ±25ms Perfect window, and precisely the class of silent systematic bias
  that FRAME_LEAD already cost real time. Lossless keeps the ground truth true.
  1.9MB, small enough to commit.
- *Deterministic* — the synth is seeded, so regeneration is byte-identical.
- *No soundfont/fluidsynth* (neither installed): the kit is synthesised from
  sine sweeps and filtered noise in numpy. Sharp transients are what onset
  detection and a drummer's ear need; fidelity is beside the point.

**Test-only ffmpeg.** Decoded PCM is regenerable, so it's gitignored;
`npm run test:fixtures` rebuilds it. The app needs nothing installed — it
decodes with Web Audio.

18 alignment tests pass, now including two against known truth.

---

### 2026-07-16: Per-song chart↔audio alignment (spec change)

**The spec was wrong, and real data proved it.** BUILD-PROMPT models a song as
"an audio file + MIDI file pair" with a single global latency offset for
hardware lag. That assumes the two files share a time base. They don't, unless
both come from the same master — and a MIDI transcription paired with a
commercial recording never does.

**Measured on the first real pair** (Another One Bites the Dust, user-supplied
mp3 + MIDI):

- The MIDI is a rigid **110.000 bpm** grid, single tempo event, no changes.
- The recording runs at **~109.68 bpm** and is not perfectly steady.
- The chart therefore walks ~3ms further out of sync per second — **~600ms**
  across the song.
- With a constant offset tuned to the intro, **7 of 11 twenty-second windows
  fall outside the ±100ms edge window: ~64% of the song auto-Misses**, no matter
  how well the player drums.

The failure mode is what makes this worth a spec change: it doesn't look like a
bad file, it looks like *broken judging*. It would have sent a future session
debugging the scoring code, which would have been correct all along.

**Change.** `SongMeta` gains `alignment: {offsetMs, tempoScale, source,
confidence}`, persisted per song, applied as
`audioTime = chartTime * tempoScale + offsetMs/1000`. New IPC:
`songs:setAlignment`. `settings.latencyOffsetMs` is untouched and keeps its
original meaning — hardware/IPC lag, global. **The two are deliberately
separate**: merging them would make calibrating the kit corrupt every song.

**The estimator lives in the renderer** (`renderer/lib/alignment.ts`), because
Web Audio's `decodeAudioData` decodes mp3/m4a/flac with no native dependency.
Doing it in main would mean shipping an audio decoder or depending on ffmpeg,
which cannot be assumed present in a packaged app. Import therefore writes
`source: "none"` and the renderer fills alignment in later.

**Two findings from building it, both counter-intuitive:**

1. *A ~35ms systematic bias, found by a synthetic test.* An FFT frame starting
   at sample `f*HOP` is centered half a window later, and flux compares frame
   i+1 to i, so the envelope's time base LEADS true onsets by exactly
   `1 + N_FFT/(2*HOP)` = 3 frames. Measured: -3.13 frames for a click at t=1.0s.
   Uncorrected this biases every estimated offset by more than the ±25ms Perfect
   window. Fixed via `FRAME_LEAD`; pinned by a regression test.

2. *`offsetMs` is fundamentally ambiguous by whole bars.* A groove looks
   identical shifted one bar, so the correlator cannot distinguish them. An
   independent numpy implementation found offset +3.383s/scale 0.99711 while the
   TypeScript found +8.704s/scale 0.99780 — different optima, both confident.
   **`tempoScale` is well-determined** (drift is punished across the whole song);
   the bar is not. So auto-align must be a *suggestion* the player confirms by
   ear, with a ±1 bar nudge — never a silent auto-apply. Attempting to
   disambiguate with musical landmarks (a silent break, a dense fill) does NOT
   work with the current metric: `score()` is the mean envelope strength at note
   positions, and a beat-shifted chart still lands most notes on real hits, so a
   few landmark notes barely move the average. Changing the metric to penalise
   *unmatched audio onsets* is the upgrade path.

**Tests.** 16 passing in `tests/alignment.test.ts`, including two against the
real song (skipped unless the local fixture exists — the song is copyrighted and
not committed). The real-song tests assert only what two independent
implementations agree on: tempo mismatch and confidence, never the exact offset.

**Still open:** nothing applies the alignment yet — gameplay doesn't exist. The
estimate is also not yet run anywhere; the renderer needs to call it and offer
the confirm/nudge UI.

---

### 2026-07-16: Scaffold — Electron skeleton, MIDI service, storage services

**Built.** `electron-vite` + `electron-builder` scaffold; main-process
bootstrap with the load-bearing ordering (privileged scheme at module scope →
forced dark → protocol + IPC handlers → window); `song-audio://` protocol;
MIDI, library, results, and chart services; the `contextBridge` preload; and a
throwaway smoke-test renderer that enumerates MIDI devices. Type-check clean;
all three bundles build.

**Verified, and how.**

- *The native addon loads under Electron 43* — probed headlessly
  (`npx electron probe.cjs`), printed `PROBE_OK`. This confirms the N-API
  prebuild is ABI-compatible with Electron and settles that no
  `electron-rebuild` step is needed.
- *The externalization split works* — `out/main/index.js` contains a bare
  `import { Input } from "@julusian/midi"` (externalized, resolved at runtime)
  while `@tonejs/midi` is bundled inline. This is the exact split the
  `dependencies` vs `devDependencies` layout is designed to produce.
- *NOT verified:* device enumeration against real hardware. The probe reported
  `PROBE_PORTS 0` — no e-kit is connected. The addon loading and the addon
  finding a real kit are different claims; only the first is established.

**Preload must be CommonJS.** The package is `"type": "module"`, so a `.js`
preload is treated as ESM, which Electron refuses to load as a preload script.
The preload build is pinned to `format: "cjs"` with `entryFileNames:
"[name].cjs"`, and `webPreferences.preload` points at `index.cjs`. These two
must stay in sync; a mismatch produces a window with no `window.drumTrainer`
and no obvious error.

**Range support is required for the audio protocol, and was not free.** Glaze's
`protocol.createFileResponse({root})` handled byte ranges and path containment;
Electron has no equivalent. Both are now implemented explicitly in
`src/main/protocol/song-audio.ts`. Without a 206 + `Content-Range` response the
`<audio>` element cannot seek — gameplay would play from 0:00 and silently fail
to scrub, which is a hard bug to attribute back to a protocol handler.

**Bug found in the reference implementation, fixed in the port.** The Glaze
`midi-service` commented that "Input has no explicit destroy" and let its
enumeration probe fall to GC. `@julusian/midi` 3.6.1 does expose `destroy()` —
so every `listDevices()` call leaked a CoreMIDI client until GC ran, and the
Settings screen enumerates on every open. The port destroys the probe (and the
open port) explicitly. Worth re-checking whether the old comment was ever true
of an earlier version, but it is not true of the pinned one.

**Other deltas from the reference.** `app.getPath` is synchronous in Electron,
so the cached-promise indirection around the songs root is gone. `DrumType` was
declared twice in the Glaze tree (renderer and results-service); it is unified
in `src/shared/types.ts` so the two cannot drift. Import now parses the MIDI
*before* copying any audio and rolls back the song directory on failure — the
original could leave a partial `songs/<id>/` behind on a mid-import error.
Chart parsing and difficulty are split into `services/chart.ts` so they can be
tested without Electron.

---

### 2026-07-16: Project initialized — Glaze → standalone Electron

**What this is.** A rebuild of Drum Trainer, previously built on the Glaze
macOS app framework, as a self-contained Electron app that packages to a
launchable `.dmg`. The prior build lives at
`~/Library/Application Support/app.glaze.macos.main/apps/drum-trainer-local-2qhmrebi/.glaze-sources`
(~4,300 lines) and is the reference implementation, not a dependency.

**Motivation.** The Glaze build only runs inside the Glaze host app. The goal is
a normal macOS application: double-clickable, installable from a `.dmg`,
independent of any host runtime.

**What ports cleanly vs. what has to be replaced.** The domain logic is
framework-agnostic and transfers nearly intact: the MIDI service, library and
results services, the `@tonejs/midi` chart parser, the difficulty calculation,
the canvas gameplay loop, and the tuned scoring formulas. What Glaze supplied
and this repo must now own explicitly:

| Glaze provided | Replacement |
| --- | --- |
| `@glaze/core/backend` (window bootstrap, `logger`, async `app.getPath`) | Plain Electron `app`/`BrowserWindow`/`nativeTheme`; a local logger; **synchronous** `app.getPath` |
| `@glaze/core/ipc` (JSON-RPC transport, `ipcMain.broadcast`) | `ipcMain.handle` + `webContents.send`, exposed through a `contextBridge` preload |
| `@glaze/core/components` (design system) | Local Tailwind components in `renderer/components/ui/` |
| `@glaze/core/build` + `glaze.config.ts` (`externalizePackage`) | `electron.vite.config.ts` `externalizeDepsPlugin` + electron-builder `asarUnpack` |
| `protocol.createFileResponse` | Electron `protocol.handle` + `net.fetch(pathToFileURL(...))` |

**Decisions made at bootstrap** (user-confirmed):

- *Port the logic, hand-roll the UI in Tailwind* — rather than rebuilding from
  the spec or adopting shadcn/ui. The gameplay canvas is already
  component-free, and ~2,000 lines of tuned, working view logic is not worth
  re-deriving. Rejected a fresh rebuild because the risk sits in timing and
  MIDI, which a rebuild does not de-risk and does re-expose. Rejected shadcn/ui
  as dependency weight for an app with five screens.
- *Unsigned `.dmg`* — no Apple Developer account in play, and this is a
  personal-use app. Gatekeeper is handled with a one-time quarantine removal.
  Notarization is the upgrade path if the app is ever handed to another person.
- *Own git repo in `drums/`* — `~/Documents` is itself a git repo, so the
  project was `git init`'d as a nested, self-contained repo rather than
  committed into the Documents history. Relevant if the project is ever
  published.

**Toolchain chosen.** electron-vite (renderer HMR + main/preload builds in one
config) plus electron-builder (`.dmg` target). Rejected Electron Forge —
electron-vite has the more direct story for externalizing a native addon, which
is the single riskiest part of this build. Kept from the Glaze stack: React 19,
TanStack Router (switched to hash history, since `file://` has no server to
resolve real paths), TanStack Query, Tailwind v4, `@tonejs/midi`,
`@julusian/midi`.

**Discovered while inspecting.** `@julusian/midi` ships **N-API** prebuilds
(`prebuilds/midi-darwin-arm64`), so the binary is ABI-stable across Node and
Electron — no `electron-rebuild` step is needed. The requirement is purely that
the package is externalized and unpacked from the asar so `pkg-prebuilds` can
find the binary relative to its own package directory at runtime.

**Carried forward from the Glaze build's known gaps.** That build's
`NEXT-STEPS.md` recorded that forced-dark appearance and full gameplay with a
real kit were validated by code review rather than a cold launch, because the
dev session never cold-restarted. Those remain unverified and are seeded into
`PROGRESS.md` rather than assumed working.

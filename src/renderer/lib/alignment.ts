/**
 * Chart↔audio alignment estimation.
 *
 * Finds the `{offsetMs, tempoScale}` that maps chart time onto audio time, by
 * correlating the chart's note times against an onset-strength envelope
 * computed from the audio. See `SongAlignment` in shared/types.ts for why this
 * is necessary at all.
 *
 * This runs in the RENDERER because the renderer has Web Audio
 * (`decodeAudioData`), which decodes mp3/m4a/flac with no native dependency and
 * no ffmpeg. Doing it in main would mean shipping an audio decoder.
 *
 * Everything here is PURE — plain arrays in, numbers out, no DOM and no
 * Electron. Per CLAUDE.md → Principles, that makes it the rare part of this app
 * whose correctness assertions can actually establish, so it is tested against a
 * real song in tests/alignment.test.ts.
 */

// Analysis sample rate. Onsets don't need fidelity, and this keeps the FFT cheap.
export const ANALYSIS_SAMPLE_RATE = 22050;
const N_FFT = 1024;
const HOP = 256;

/** GM notes that carry the beat. Hi-hats are dense and smear the correlation. */
const BEAT_NOTES = new Set([35, 36, 38, 40]);

/**
 * Frames of lead between an onset's true time and its flux peak.
 *
 * FFT frame `f` spans samples [f*HOP, f*HOP + N_FFT), so it is CENTERED half a
 * window later than it starts, and flux[i] compares frame i+1 against i. The
 * net effect is that a transient at time t peaks at frame `t*fps - LEAD`, where
 * LEAD = 1 + N_FFT/(2*HOP) = 3 frames = ~35ms at these settings.
 *
 * This is not cosmetic. Left uncorrected it biases every estimated offset by
 * ~35ms — larger than the ±25ms Perfect window — so every song would judge
 * systematically early. Measured empirically at -3.13 frames for a click at
 * t=1.0s, which is this constant plus sub-frame windowing asymmetry.
 */
const FRAME_LEAD = 1 + N_FFT / (2 * HOP);

export interface OnsetEnvelope {
  /** Onset strength per frame, standardized to mean 0 / stdev 1. */
  strength: Float32Array;
  /** Frames per second. */
  fps: number;
}

/** Envelope frame index for an audio time, correcting the FFT framing lead. */
export function frameForTime(time: number, fps: number): number {
  return Math.round(time * fps - FRAME_LEAD);
}

/** Audio time at an envelope frame. Inverse of frameForTime. */
export function timeOfFrame(frame: number, fps: number): number {
  return (frame + FRAME_LEAD) / fps;
}

export interface AlignmentEstimate {
  offsetMs: number;
  tempoScale: number;
  /** Mean envelope strength at the winning alignment, in stdevs. */
  confidence: number;
}

// ── FFT ───────────────────────────────────────────────────────────────
// Iterative in-place radix-2 Cooley-Tukey. Only used at N_FFT, which is a power
// of two by construction.

function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
        const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

// ── Onset envelope ────────────────────────────────────────────────────

/**
 * Spectral flux onset envelope: per frame, the summed positive change in
 * log-magnitude spectrum. Percussive hits produce broadband energy jumps, which
 * is exactly what this measures.
 *
 * @param mono Mono samples at ANALYSIS_SAMPLE_RATE.
 */
export function onsetEnvelope(mono: Float32Array, sampleRate = ANALYSIS_SAMPLE_RATE): OnsetEnvelope {
  const frameCount = Math.max(0, 1 + Math.floor((mono.length - N_FFT) / HOP));
  if (frameCount < 2) {
    return { strength: new Float32Array(0), fps: sampleRate / HOP };
  }

  const window = new Float32Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N_FFT - 1)); // Hann
  }

  const bins = N_FFT / 2 + 1;
  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);
  let prev = new Float32Array(bins);
  let cur = new Float32Array(bins);
  const flux = new Float32Array(frameCount - 1);

  for (let f = 0; f < frameCount; f++) {
    const start = f * HOP;
    for (let i = 0; i < N_FFT; i++) {
      re[i] = mono[start + i] * window[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let b = 0; b < bins; b++) {
      cur[b] = Math.log1p(Math.hypot(re[b], im[b]));
    }
    if (f > 0) {
      let sum = 0;
      for (let b = 0; b < bins; b++) {
        const d = cur[b] - prev[b];
        if (d > 0) sum += d; // half-wave rectify: only energy increases
      }
      flux[f - 1] = sum;
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }

  // Standardize so `confidence` is in stdevs and comparable across songs.
  let mean = 0;
  for (let i = 0; i < flux.length; i++) mean += flux[i];
  mean /= flux.length;
  let variance = 0;
  for (let i = 0; i < flux.length; i++) variance += (flux[i] - mean) ** 2;
  const stdev = Math.sqrt(variance / flux.length) || 1e-9;
  for (let i = 0; i < flux.length; i++) flux[i] = (flux[i] - mean) / stdev;

  return { strength: flux, fps: sampleRate / HOP };
}

/** Downmix to mono. Resampling is the caller's job (use an OfflineAudioContext). */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    out[i] = sum / channels.length;
  }
  return out;
}

// ── Alignment search ──────────────────────────────────────────────────

/** Mean envelope strength where the mapped notes land. Higher = better lock. */
function score(
  env: OnsetEnvelope,
  times: Float32Array,
  scale: number,
  offsetSec: number,
  minHits: number,
): number {
  const { strength, fps } = env;
  let sum = 0;
  let hits = 0;
  for (let i = 0; i < times.length; i++) {
    const frame = frameForTime(times[i] * scale + offsetSec, fps);
    if (frame >= 0 && frame < strength.length) {
      sum += strength[frame];
      hits++;
    }
  }
  return hits < minHits ? -Infinity : sum / hits;
}

export interface EstimateOptions {
  /** Widest plausible constant shift, seconds. */
  minOffsetSec?: number;
  maxOffsetSec?: number;
  /** Widest plausible tempo ratio. ±3% covers transcription error comfortably. */
  minScale?: number;
  maxScale?: number;
}

/**
 * Estimate `{offsetMs, tempoScale}` aligning `noteTimes` to the audio.
 *
 * Two-stage: a coarse joint sweep over (scale, offset), then a fine local
 * refine around the winner. A single-stage fine sweep would be ~100x the work
 * for the same answer.
 *
 * Both terms are needed. Searching offset alone finds a value that fits the
 * START of the song and then drifts; that is the bug this exists to prevent.
 *
 * ── KNOW THIS BEFORE TRUSTING THE RESULT ─────────────────────────────
 * `offsetMs` IS AMBIGUOUS BY WHOLE BARS. A drum groove repeats: bar N looks
 * exactly like bar N+1 to a correlator, so an alignment shifted by one bar
 * scores just as well as the true one. Measured on the first real song, the
 * search found two near-equal answers ~2s apart — one bar at 110bpm.
 *
 * What that means in practice:
 *  - `tempoScale` IS reliable. Drift accumulates over the whole song, so a
 *    wrong scale is punished everywhere and the correct one wins clearly.
 *  - `offsetMs` is reliable only modulo one bar. Only song structure (an intro,
 *    a fill, a break) breaks the tie, and a repetitive song may not have enough.
 *
 * So this is a SUGGESTION requiring confirmation, never a silent auto-apply.
 * The UI must let the player nudge by ±1 bar and hear the result. A high
 * `confidence` means "locked onto the groove", NOT "locked onto the right bar".
 */
export function estimateAlignment(
  env: OnsetEnvelope,
  chart: { time: number; midiNote: number }[],
  options: EstimateOptions = {},
): AlignmentEstimate {
  const {
    minOffsetSec = -6,
    maxOffsetSec = 16,
    minScale = 0.97,
    maxScale = 1.03,
  } = options;

  if (env.strength.length === 0 || chart.length === 0) {
    return { offsetMs: 0, tempoScale: 1, confidence: 0 };
  }

  // Prefer kick/snare; fall back to everything if the chart has none.
  const beat = chart.filter((n) => BEAT_NOTES.has(n.midiNote));
  const source = beat.length >= 20 ? beat : chart;
  const times = Float32Array.from(source.map((n) => n.time));
  const minHits = Math.max(10, Math.floor(times.length * 0.5));

  const coarseOffsetStep = 4 / env.fps;
  const coarseScaleStep = 0.0005;

  let best = { scale: 1, offset: 0, value: -Infinity };
  for (let scale = minScale; scale <= maxScale; scale += coarseScaleStep) {
    for (let off = minOffsetSec; off <= maxOffsetSec; off += coarseOffsetStep) {
      const value = score(env, times, scale, off, minHits);
      if (value > best.value) best = { scale, offset: off, value };
    }
  }

  // Fine refine. The coarse grid can only be off by one step in each axis, so a
  // narrow window around the winner is sufficient.
  const fineOffsetStep = 1 / (env.fps * 4);
  for (
    let scale = best.scale - coarseScaleStep;
    scale <= best.scale + coarseScaleStep;
    scale += coarseScaleStep / 5
  ) {
    for (
      let off = best.offset - coarseOffsetStep;
      off <= best.offset + coarseOffsetStep;
      off += fineOffsetStep
    ) {
      const value = score(env, times, scale, off, minHits);
      if (value > best.value) best = { scale, offset: off, value };
    }
  }

  return {
    offsetMs: best.offset * 1000,
    tempoScale: best.scale,
    confidence: best.value,
  };
}

/** Apply an alignment to a chart time. The one place the mapping is defined. */
export function chartTimeToAudioTime(
  chartSeconds: number,
  alignment: { offsetMs: number; tempoScale: number },
): number {
  return chartSeconds * alignment.tempoScale + alignment.offsetMs / 1000;
}

// ── Candidate ranking (the way out of the bar ambiguity) ──────────────

/**
 * Audio onset times, in seconds.
 *
 * `estimateAlignment` only ever asks "is there energy where a chart note
 * lands?". It never asks the reverse — "is there a chart note for this hit?" —
 * so a bar-shifted chart, which still lands on real hits, scores identically.
 * Detecting the onsets explicitly is what makes the reverse question askable.
 */
export function detectOnsets(env: OnsetEnvelope, threshold = 0.5): number[] {
  const { strength, fps } = env;
  const refractory = Math.max(1, Math.round(0.03 * fps)); // one strike = one onset
  const times: number[] = [];
  let last = -Infinity;

  for (let i = 1; i < strength.length - 1; i++) {
    if (strength[i] < threshold) continue;
    if (strength[i] < strength[i - 1] || strength[i] < strength[i + 1]) continue;
    if (i - last < refractory) continue;
    times.push(timeOfFrame(i, fps));
    last = i;
  }
  return times;
}

export interface AlignmentScore {
  /** Share of AUDIO onsets that a chart note explains. */
  precision: number;
  /** Share of CHART notes that land on an audio onset. */
  recall: number;
  f1: number;
}

/**
 * Symmetric score: how well do the chart and the audio explain EACH OTHER?
 *
 * This is the fix for bar ambiguity. `score()` above is a mean — it rewards
 * notes hitting onsets and is blind to onsets nobody played and notes landing
 * in silence, which is exactly why every bar looks alike to it. Counting both
 * directions makes a song's edges matter: a chart shifted a bar early starts
 * before the drums come in (recall drops) and leaves real hits at the end
 * unexplained (precision drops).
 *
 * Precision is depressed on a full mix, where bass and vocals produce onsets no
 * drum chart will ever explain. That's fine: candidates are compared against
 * each other on the same audio, so the penalty is common to all of them and
 * cancels in the ranking. Read the RANKING, not the absolute number.
 */
export function scoreSymmetric(
  chartAudioTimes: number[],
  onsetTimes: number[],
  toleranceSec = 0.03,
): AlignmentScore {
  if (chartAudioTimes.length === 0 || onsetTimes.length === 0) {
    return { precision: 0, recall: 0, f1: 0 };
  }

  // Both lists are sorted, so a merge-style sweep beats a nested scan.
  const nearest = (needles: number[], haystack: number[]): number => {
    let hits = 0;
    let j = 0;
    for (const t of needles) {
      while (j + 1 < haystack.length && Math.abs(haystack[j + 1] - t) <= Math.abs(haystack[j] - t)) {
        j++;
      }
      if (Math.abs(haystack[j] - t) <= toleranceSec) hits++;
    }
    return hits;
  };

  const recall = nearest(chartAudioTimes, onsetTimes) / chartAudioTimes.length;
  const precision = nearest(onsetTimes, chartAudioTimes) / onsetTimes.length;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

export interface AlignmentCandidate extends AlignmentScore {
  offsetMs: number;
  tempoScale: number;
  /**
   * BEATS away from the estimator's first guess. 0 is the raw estimate.
   *
   * Beats, not bars. Enumerating only whole bars was wrong: the seed can land a
   * single BEAT off (a kick/snare groove repeats every two beats, not every
   * bar), and then the truth isn't in the candidate set at all — measured as a
   * clean 501ms error at 120bpm, i.e. exactly one beat.
   */
  beatsFromSeed: number;
}

/** Human label for a candidate's shift: "+1 bar", "−2 beats", "estimate". */
export function describeShift(beatsFromSeed: number, beatsPerBar = 4): string {
  if (beatsFromSeed === 0) return "estimate";
  const sign = beatsFromSeed > 0 ? "+" : "−";
  const n = Math.abs(beatsFromSeed);
  if (n % beatsPerBar === 0) {
    const bars = n / beatsPerBar;
    return `${sign}${bars} bar${bars === 1 ? "" : "s"}`;
  }
  return `${sign}${n} beat${n === 1 ? "" : "s"}`;
}

export interface AlignmentAnalysis {
  /** Best first. */
  candidates: AlignmentCandidate[];
  /** True when the winner beats the runner-up clearly enough to just pick it. */
  confident: boolean;
  /** F1 gap between the top two. The number behind `confident`. */
  margin: number;
  /**
   * Worst per-window timing residual after the linear fit, ms.
   *
   * The linear model assumes the recording holds ONE tempo. Real playing
   * breathes. This measures what the straight line couldn't explain: fit each
   * 20s window's own best offset and see how far they wander from the line.
   */
  residualMs: number;
  /** Residual exceeds the Perfect window: no single tempo can fit this take. */
  breathes: boolean;
}

/**
 * F1 gap above which the winner is treated as obviously right.
 *
 * CALIBRATED ON ONE SONG, so treat it as what it is. On the oracle — audio
 * rendered from its own chart, the clearest case that can exist — the true
 * alignment beats the runner-up by only 0.050 (0.819 vs 0.769). A repetitive
 * groove simply doesn't separate by much, even with a symmetric metric: shifting
 * a beat still lands most notes on real hits, and only the song's edges, fills
 * and breaks disagree.
 *
 * So this is set just under that, and `confident` is a HINT that sets the UI's
 * tone — never permission to skip the preview. The margin is reported alongside
 * it precisely so nobody has to trust this constant.
 */
const CONFIDENT_MARGIN = 0.04;

/**
 * Resolution of the seed's phase search, ms. Finer than the ±25ms Perfect
 * window by enough that phase error stops being the limiting factor, and
 * coarse enough that a full-beat sweep stays ~200 evaluations.
 */
const PHASE_STEP_MS = 5;

/**
 * Best offset within ±radius of `centre`, taking the CENTRE of the winning
 * plateau rather than its first sample.
 *
 * The plateau is the point. `scoreSymmetric` matches within a ±30ms tolerance,
 * so on clean audio the score SATURATES: every offset across a ~60ms band
 * scores identically, and a plain argmax returns whichever edge it scanned
 * first. Measured on synthetic click tracks, that produced a dead-constant
 * ~30ms error — independent of note count and of the true offset, i.e. half the
 * matching tolerance, exactly as an edge-of-plateau bias predicts.
 *
 * A tight error around a non-zero mean is a systematic bug, not noise (the same
 * reading that caught FRAME_LEAD twice). Real songs hide it because their
 * scores never saturate; a well-separated stem or a rendered chart is precisely
 * where it would bite, and those are the easy cases that should be exact.
 */
function bestOffsetNear(
  centre: number,
  radiusMs: number,
  stepMs: number,
  f1At: (offsetMs: number) => number,
): number {
  let bestF1 = -Infinity;
  const scores: { offsetMs: number; f1: number }[] = [];
  for (let d = -radiusMs; d <= radiusMs; d += stepMs) {
    const offsetMs = centre + d;
    const f1 = f1At(offsetMs);
    scores.push({ offsetMs, f1 });
    if (f1 > bestF1) bestF1 = f1;
  }

  // Widest contiguous run at the best score, then its midpoint. Ties elsewhere
  // in the sweep (a repetitive groove aliasing a bar away) must not drag the
  // answer between them, so only the run containing the FIRST best sample counts.
  const start = scores.findIndex((s) => s.f1 >= bestF1);
  let end = start;
  while (end + 1 < scores.length && scores[end + 1].f1 >= bestF1) end++;
  return (scores[start].offsetMs + scores[end].offsetMs) / 2;
}

/**
 * Rank the plausible alignments instead of guessing one.
 *
 * `estimateAlignment` finds a good fit but cannot know which BAR it landed on.
 * This enumerates the bar-shifted alternatives, scores each symmetrically, and
 * reports them ranked with the margin between them — so the UI can say "this
 * one, clearly" or "these two are nearly tied, listen to both" instead of
 * silently picking and hoping.
 *
 * Needs `bpm` to know how long a bar is. Without it there is only one candidate,
 * which is honest: we cannot enumerate alternatives we can't measure.
 */
export function analyzeAlignment(
  env: OnsetEnvelope,
  chart: { time: number; midiNote: number }[],
  options: { bpm?: number | null; beatsPerBar?: number; maxBars?: number } = {},
): AlignmentAnalysis {
  const { bpm, beatsPerBar = 4, maxBars = 2 } = options;

  const seed = estimateAlignment(env, chart);
  const onsets = detectOnsets(env);

  /**
   * ALL notes here, not just kick/snare — the opposite of what the seed search
   * wants, and deliberately so.
   *
   * The mean-based seed uses beat notes because dense hats smear an average.
   * But precision asks "what share of AUDIO onsets does the chart explain?", and
   * scoring only kick/snare against every onset caps it at roughly
   * beatNotes/onsets — measured at 0.545 on the oracle, with the runner-up at
   * 0.505. Nearly flat, i.e. nearly useless for ranking. Feeding it every note
   * lets an onset actually be explained.
   */
  const times = chart.map((n) => n.time);

  const scoreAt = (offsetMs: number): AlignmentScore =>
    scoreSymmetric(
      times.map((t) => t * seed.tempoScale + offsetMs / 1000),
      onsets,
    );

  const candidates: AlignmentCandidate[] = [];
  const beatSec = bpm ? 60 / bpm : null;

  // Beat granularity, spanning ±maxBars worth of beats. A groove aliases at the
  // beat, so bar-only candidates can miss the truth entirely.
  const maxBeats = maxBars * beatsPerBar;

  /**
   * ANCHOR THE CANDIDATES ON A FINE SWEEP, not on the raw seed.
   *
   * Every candidate below is a whole-BEAT shift of an anchor, so the anchor's
   * sub-beat phase is inherited by all of them. If that phase is wrong the
   * truth is not in the candidate set AT ALL, and no amount of enumerating more
   * bars puts it there — the per-candidate ±40ms retune cannot cross the gap.
   *
   * Measured on a known-truth pair (an ADTOF chart against the audio it was
   * transcribed from, so truth is exactly offset 0): the seed landed 1844ms
   * out, which is 3.9 beats — not a whole number. The truth scored f1 0.705
   * against the winning candidate's 0.664, so the METRIC was right and would
   * have picked it; the nearest offered candidate was 206ms away, enough to
   * auto-Miss the whole song.
   *
   * A LOCAL search around the seed is not enough, and failing that way is
   * instructive: anchored to the seed it found a higher-scoring phase inside
   * its window and moved there, which broke a pair that previously worked
   * (Hounds of Love, correct at 3ms, went to 1648ms). The best phase is not
   * necessarily near the seed. So sweep the whole span the candidates cover and
   * take the global best; the beat enumeration then supplies the alternatives,
   * which is the part only a human can settle.
   */
  const anchorOffsetMs = beatSec
    ? bestOffsetNear(seed.offsetMs, maxBeats * beatSec * 1000, PHASE_STEP_MS, (o) => scoreAt(o).f1)
    : seed.offsetMs;
  const shifts = beatSec ? Array.from({ length: maxBeats * 2 + 1 }, (_, i) => i - maxBeats) : [0];

  for (const beats of shifts) {
    // Re-tune each candidate locally: the bar-shifted position may sit slightly
    // better a few ms either way, and judging candidates at a stale offset would
    // rank them on a handicap rather than on merit.
    const seeded = anchorOffsetMs + beats * (beatSec ?? 0) * 1000;
    const offsetMs = bestOffsetNear(seeded, 40, 5, (o) => scoreAt(o).f1);
    const best = { score: scoreAt(offsetMs) };

    candidates.push({
      offsetMs,
      tempoScale: seed.tempoScale,
      beatsFromSeed: beats,
      ...best.score,
    });
  }

  candidates.sort((a, b) => b.f1 - a.f1);
  const margin = candidates.length > 1 ? candidates[0].f1 - candidates[1].f1 : 1;

  return {
    candidates,
    margin,
    confident: candidates.length === 1 || margin >= CONFIDENT_MARGIN,
    ...residualFor(env, times, candidates[0]),
  };
}

/**
 * How much of the timing the straight line failed to explain.
 *
 * Each window is searched only ±0.4s around the global fit — less than half a
 * bar at any sane tempo, so a window cannot silently hop to a neighbouring bar
 * and report that hop as "residual".
 */
function residualFor(
  env: OnsetEnvelope,
  chartTimes: number[],
  best: { offsetMs: number; tempoScale: number },
): { residualMs: number; breathes: boolean } {
  const span = chartTimes[chartTimes.length - 1] ?? 0;
  if (span < 40) return { residualMs: 0, breathes: false }; // too short to drift

  const windowSec = 20;
  const residuals: number[] = [];

  for (let start = 0; start + windowSec <= span; start += windowSec) {
    const inWindow = chartTimes.filter((t) => t >= start && t < start + windowSec);
    if (inWindow.length < 10) continue;

    let bestLocal = { delta: 0, value: -Infinity };
    for (let delta = -0.4; delta <= 0.4; delta += 1 / (env.fps * 2)) {
      const value = score(
        env,
        Float32Array.from(inWindow),
        best.tempoScale,
        best.offsetMs / 1000 + delta,
        Math.max(5, Math.floor(inWindow.length * 0.5)),
      );
      if (value > bestLocal.value) bestLocal = { delta, value };
    }
    residuals.push(Math.abs(bestLocal.delta) * 1000);
  }

  const residualMs = residuals.length ? Math.max(...residuals) : 0;
  return { residualMs, breathes: residualMs > 25 };
}

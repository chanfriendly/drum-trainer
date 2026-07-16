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

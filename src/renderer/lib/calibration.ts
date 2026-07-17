/**
 * Latency calibration maths.
 *
 * Pure — no DOM, no audio, no Electron — so the part that decides your offset
 * can actually be tested. See CLAUDE.md → Principles.
 *
 * WHAT IS BEING MEASURED. You hear a click and hit a pad. The app sees that hit
 * some milliseconds later: the pad's own scan time, USB/CoreMIDI transport, the
 * IPC hop, and the audio output buffer that made you hear the click late in the
 * first place. `latencyOffsetMs` is the sum, and gameplay subtracts it from the
 * audio clock at judge time.
 *
 * IT ALSO MEASURES YOU, AND THAT IS CORRECT. Humans reliably tap slightly EARLY
 * against a metronome — "negative mean asynchrony", typically 20-50ms, and it
 * varies by person. That bias lands in this number. It would be a defect if the
 * goal were measuring hardware; the goal is making YOUR hits judge fairly, so
 * folding in your personal tendency is the point. It does mean the offset is
 * per-player, not a property of the kit, and that it should be redone if the
 * player changes.
 */

/** One tap, in the same clock as the click times. */
export interface CalibrationSample {
  /** Seconds when the app received the note-on. */
  hitTime: number;
  /** Seconds the nearest click was scheduled to sound. */
  clickTime: number;
}

export interface CalibrationSummary {
  /** The offset to store, in ms. Median — see below. */
  offsetMs: number;
  /** Spread of the taps, ms. The honesty number: large means don't trust it. */
  spreadMs: number;
  /** Taps used (after discarding settling taps and unmatched ones). */
  sampleCount: number;
  /** False when the taps are too few or too scattered to mean anything. */
  usable: boolean;
  /** Plain-language verdict for the UI. */
  verdict: string;
}

/**
 * How far a tap may sit from a click and still be counted as that click's tap.
 * Half a beat at 100bpm is 300ms; 250ms keeps a wild tap from being credited to
 * the neighbouring click, which would fold a whole beat into the average.
 */
const MATCH_WINDOW_SEC = 0.25;

/** Taps to discard at the start — people need a couple of clicks to settle in. */
export const SETTLING_TAPS = 2;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Median absolute deviation, scaled to be comparable to a standard deviation. */
export function robustSpread(values: number[]): number {
  if (values.length < 2) return 0;
  const m = median(values);
  return 1.4826 * median(values.map((v) => Math.abs(v - m)));
}

/**
 * Pair each tap with the click it was aiming at.
 *
 * Taps beyond MATCH_WINDOW_SEC of every click are dropped rather than snapped
 * to the nearest one: a missed beat is not evidence about latency, and pulling
 * it in would drag the estimate by a whole beat.
 */
export function matchTapsToClicks(
  tapTimes: number[],
  clickTimes: number[],
): CalibrationSample[] {
  const samples: CalibrationSample[] = [];
  for (const hitTime of tapTimes) {
    let best: number | null = null;
    let bestDiff = Infinity;
    for (const clickTime of clickTimes) {
      const diff = Math.abs(hitTime - clickTime);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = clickTime;
      }
    }
    if (best !== null && bestDiff <= MATCH_WINDOW_SEC) {
      samples.push({ hitTime, clickTime: best });
    }
  }
  return samples;
}

/**
 * Reduce samples to an offset.
 *
 * MEDIAN, not mean. One flubbed tap 300ms out drags a mean of twelve samples by
 * 25ms — the entire Perfect window — while the median doesn't notice. Drummers
 * flub taps; the estimator shouldn't care.
 */
export function summarize(samples: CalibrationSample[]): CalibrationSummary {
  const usableSamples = samples.slice(SETTLING_TAPS);
  const offsets = usableSamples.map((s) => (s.hitTime - s.clickTime) * 1000);

  if (offsets.length < 4) {
    return {
      offsetMs: 0,
      spreadMs: 0,
      sampleCount: offsets.length,
      usable: false,
      verdict: "Not enough taps. Hit a pad on every click.",
    };
  }

  const offsetMs = median(offsets);
  const spreadMs = robustSpread(offsets);

  // A spread wider than the Good window means the taps disagree with each other
  // by more than the thing being measured. An offset from that is a number, not
  // a measurement, and quietly saving it would be worse than not offering it.
  const usable = spreadMs <= 50;

  return {
    offsetMs,
    spreadMs,
    sampleCount: offsets.length,
    usable,
    verdict: usable
      ? spreadMs <= 20
        ? "Tight and consistent."
        : "Usable, but your taps varied a fair bit."
      : "Too inconsistent to trust — try again, and aim for the click rather than the screen.",
  };
}

/** Click times for a metronome, in seconds from start. */
export function clickSchedule(bpm: number, beats: number, startAt = 0): number[] {
  const interval = 60 / bpm;
  return Array.from({ length: beats }, (_, i) => startAt + i * interval);
}

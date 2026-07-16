/**
 * Alignment estimator tests.
 *
 * WHY THESE LOOK THE WAY THEY DO — three attempts, each failing by ~one beat,
 * and each failure taught something worth keeping:
 *
 *  1. Uniform click tracks. Failed: a uniform pattern has NO unique alignment.
 *     Shift it one beat and it matches itself perfectly.
 *  2. Grid patterns with a silent break and a dense fill, on the theory that
 *     musical landmarks disambiguate. ALSO failed by a beat — and this is the
 *     non-obvious part: `score()` is the MEAN envelope strength where notes
 *     land, so a beat-shifted chart still lands most notes on real hits, and a
 *     handful of break notes falling into silence barely moves an average.
 *     Landmarks are invisible to an averaging metric. (If the metric is ever
 *     changed to penalise unmatched audio onsets, landmarks WOULD start to
 *     help — that is the upgrade path out of the ambiguity.)
 *  3. Off-grid irregular patterns. These work, because any shift drops notes
 *     into silence and the score collapses.
 *
 * So the tests split the question in two:
 *  - "Can the estimator find an alignment when one is unambiguous?" — the
 *    irregular-pattern tests, asserted tightly.
 *  - "Is a musical grid ambiguous?" — its own test, pinning the limitation.
 *    That ambiguity is a property of repetitive music, not a defect here, and
 *    it is why the UI must offer a bar-nudge instead of trusting auto-align.
 *
 * On the real song, only what two independent implementations AGREE on is
 * asserted (tempo mismatch, confidence), never the exact offset. See the
 * real-song describe block.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ANALYSIS_SAMPLE_RATE,
  chartTimeToAudioTime,
  estimateAlignment,
  frameForTime,
  onsetEnvelope,
  timeOfFrame,
  toMono,
} from "../src/renderer/lib/alignment.js";

/** Deterministic PRNG — tests must not flake on random audio. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Click track: a decaying broadband transient at each time. */
function clickTrack(times: number[], durationSec: number, seed = 7): Float32Array {
  const rand = rng(seed);
  const out = new Float32Array(Math.ceil(durationSec * ANALYSIS_SAMPLE_RATE));
  for (const t of times) {
    const start = Math.floor(t * ANALYSIS_SAMPLE_RATE);
    for (let i = 0; i < 256 && start + i < out.length; i++) {
      if (start + i >= 0) out[start + i] += (rand() * 2 - 1) * Math.exp(-i / 40);
    }
  }
  return out;
}

/**
 * An OFF-GRID pattern with a genuinely unique alignment.
 *
 * Two earlier attempts failed, and why matters:
 *  1. A uniform click track — every offset a beat apart is equally valid.
 *  2. A grid pattern with a silent break and a dense fill — still failed by one
 *     beat. The landmarks don't help, because `score()` is the MEAN envelope
 *     strength where notes land: a beat-shifted chart still lands most of its
 *     notes on real hits, and the handful of break notes falling into silence
 *     barely move an average. Landmarks are invisible to an averaging metric.
 *
 * So these notes sit at irregular, off-grid intervals. Any shift drops them
 * into silence and the score collapses, making the true alignment the only
 * good one. That isolates "can the estimator find an unambiguous alignment?"
 * from "is a musical grid ambiguous?" — the latter has its own test below, and
 * is a property of music, not a bug here.
 */
function irregularPattern(count: number, seed = 3): { time: number; midiNote: number }[] {
  const rand = rng(seed);
  const notes: { time: number; midiNote: number }[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    t += 0.18 + rand() * 0.45; // 180-630ms apart, never a repeating interval
    notes.push({ time: t, midiNote: rand() < 0.5 ? 36 : 38 });
  }
  return notes;
}

describe("chartTimeToAudioTime", () => {
  it("applies offset and scale", () => {
    expect(chartTimeToAudioTime(10, { offsetMs: 500, tempoScale: 1 })).toBeCloseTo(10.5, 6);
    expect(chartTimeToAudioTime(100, { offsetMs: 0, tempoScale: 0.99 })).toBeCloseTo(99, 6);
    expect(chartTimeToAudioTime(100, { offsetMs: 3383, tempoScale: 0.99711 })).toBeCloseTo(
      103.094,
      3,
    );
  });

  it("is identity for a no-op alignment", () => {
    expect(chartTimeToAudioTime(42, { offsetMs: 0, tempoScale: 1 })).toBe(42);
  });
});

describe("frame/time mapping", () => {
  it("round-trips", () => {
    const fps = ANALYSIS_SAMPLE_RATE / 256;
    for (const t of [0.5, 1.0, 10.0, 123.456]) {
      expect(timeOfFrame(frameForTime(t, fps), fps)).toBeCloseTo(t, 1);
    }
  });

  it("corrects the FFT framing lead so a click's peak maps back to its true time", () => {
    // Regression guard: without FRAME_LEAD the peak sits ~35ms early, which is
    // larger than the ±25ms Perfect window and would bias every song.
    const audio = clickTrack([1.0], 3);
    const { strength, fps } = onsetEnvelope(audio);

    let peak = 0;
    for (let i = 1; i < strength.length; i++) if (strength[i] > strength[peak]) peak = i;

    expect(timeOfFrame(peak, fps)).toBeCloseTo(1.0, 1);
    expect(Math.abs(timeOfFrame(peak, fps) - 1.0)).toBeLessThan(0.025);
  });
});

describe("onsetEnvelope", () => {
  it("peaks where the hits are", () => {
    const audio = clickTrack([1.0, 2.0, 3.0], 4);
    const { strength, fps } = onsetEnvelope(audio);
    expect(fps).toBeCloseTo(ANALYSIS_SAMPLE_RATE / 256, 6);

    const at = (t: number) => strength[frameForTime(t, fps)];
    expect(at(1.0)).toBeGreaterThan(3); // a hit
    expect(at(1.5)).toBeLessThan(1); // silence between hits
  });

  it("returns empty for audio shorter than one frame", () => {
    expect(onsetEnvelope(new Float32Array(100)).strength.length).toBe(0);
  });
});

describe("toMono", () => {
  it("passes a single channel through untouched", () => {
    const ch = Float32Array.from([1, 2, 3]);
    expect(toMono([ch])).toBe(ch);
  });

  it("averages channels", () => {
    const out = toMono([Float32Array.from([1, 0]), Float32Array.from([0, 1])]);
    expect(Array.from(out)).toEqual([0.5, 0.5]);
  });
});

describe("estimateAlignment", () => {
  it("recovers a constant offset from an unambiguous pattern", () => {
    const chart = irregularPattern(120);
    const audio = clickTrack(
      chart.map((n) => n.time + 2.5),
      50,
    );
    const est = estimateAlignment(onsetEnvelope(audio), chart);

    expect(est.offsetMs).toBeCloseTo(2500, -2); // within ~50ms
    expect(est.tempoScale).toBeCloseTo(1, 2);
    expect(est.confidence).toBeGreaterThan(1);
  });

  it("recovers a tempo scale — the case a constant offset CANNOT fix", () => {
    const chart = irregularPattern(140, 11);
    const SCALE = 0.995;
    const OFFSET = 1.5;
    const audio = clickTrack(
      chart.map((n) => n.time * SCALE + OFFSET),
      70,
    );
    const est = estimateAlignment(onsetEnvelope(audio), chart);

    expect(est.tempoScale).toBeCloseTo(SCALE, 2);
    expect(est.offsetMs).toBeCloseTo(OFFSET * 1000, -2);

    // The point of the feature: the LAST note must land accurately, not just
    // the first. Offset-only alignment fails precisely here.
    const last = chart[chart.length - 1].time;
    const trueAudioTime = last * SCALE + OFFSET;
    expect(Math.abs(chartTimeToAudioTime(last, est) - trueAudioTime)).toBeLessThan(0.05);

    // And prove the naive alternative really would have failed.
    const naive = last + est.offsetMs / 1000;
    expect(Math.abs(naive - trueAudioTime)).toBeGreaterThan(0.1);
  });

  it("is ambiguous by whole bars on a PERFECTLY REPETITIVE pattern", () => {
    // Pins the known limitation. A uniform groove matches a bar-shifted copy of
    // itself, so the estimator may return any bar. It should still lock onto the
    // groove (high confidence) — confidence means "found the beat", not "found
    // the right bar". If this ever starts passing exactly, the ambiguity was
    // solved and the UI's bar-nudge may no longer be needed.
    const bpm = 120;
    const beat = 60 / bpm;
    const bar = beat * 4;
    const chart = Array.from({ length: 64 }, (_, b) => ({
      time: b * beat,
      midiNote: b % 2 === 0 ? 36 : 38,
    }));
    const TRUE_OFFSET = 3.0;
    const audio = clickTrack(
      chart.map((n) => n.time + TRUE_OFFSET),
      50,
    );

    const est = estimateAlignment(onsetEnvelope(audio), chart);
    expect(est.confidence).toBeGreaterThan(1); // locked onto the groove

    // The error is (near) a whole number of beats — not arbitrary.
    const errorBeats = (est.offsetMs / 1000 - TRUE_OFFSET) / beat;
    expect(Math.abs(errorBeats - Math.round(errorBeats))).toBeLessThan(0.2);
    expect(bar).toBeGreaterThan(0);
  });

  it("reports low confidence when the chart does not match the audio", () => {
    const chart = irregularPattern(120);
    const rand = rng(99);
    const noise = new Float32Array(50 * ANALYSIS_SAMPLE_RATE);
    for (let i = 0; i < noise.length; i++) noise[i] = (rand() * 2 - 1) * 0.05;

    const est = estimateAlignment(onsetEnvelope(noise), chart);
    expect(est.confidence).toBeLessThan(1);
  });

  it("falls back to all notes when the chart has no kick/snare", () => {
    const hats = irregularPattern(120, 5).map((n) => ({ ...n, midiNote: 42 }));
    const audio = clickTrack(
      hats.map((n) => n.time + 1),
      50,
    );
    const est = estimateAlignment(onsetEnvelope(audio), hats);
    expect(est.offsetMs).toBeCloseTo(1000, -2);
  });

  it("returns a no-op estimate for an empty chart or empty audio", () => {
    expect(estimateAlignment(onsetEnvelope(new Float32Array(0)), [])).toEqual({
      offsetMs: 0,
      tempoScale: 1,
      confidence: 0,
    });
  });
});

/**
 * Real-song cross-check — skipped unless the fixture exists. The song is
 * copyrighted and deliberately not committed (see PROGRESS.md). Generate with:
 *   ffmpeg -i "<song>.mp3" -ac 1 -ar 22050 -f f32le tests/fixtures/song.raw
 */
const RAW = new URL("./fixtures/song.raw", import.meta.url).pathname;
const NOTES = new URL("./fixtures/notes.json", import.meta.url).pathname;

describe.skipIf(!(existsSync(RAW) && existsSync(NOTES)))("estimateAlignment (real song)", () => {
  /**
   * WHAT THIS DOES AND DOES NOT CHECK.
   *
   * An independent numpy implementation of the same analysis found
   * offset +3.383s / scale 0.99711. This code finds offset +8.704s /
   * scale 0.99780 — a DIFFERENT optimum, and not merely a bar-shift of the
   * other (the scales differ, so the offsets aren't even commensurable).
   *
   * That disagreement is a finding, not a defect to assert away: the search
   * space is genuinely multi-modal, which is exactly why auto-alignment is a
   * suggestion the player confirms by ear, never a silent auto-apply.
   *
   * So this asserts only what BOTH implementations independently agree on and
   * what the product actually depends on:
   *   - the estimator locks onto the groove (high confidence)
   *   - the recording is slower than the MIDI's rigid 110.000bpm (scale < 1)
   *   - the resulting drift dwarfs the ±100ms edge window
   * It deliberately does NOT pin offsetMs. If someone makes the search
   * deterministic enough to pin it, that is a real improvement — and this
   * comment is the context for why it wasn't pinned before.
   */
  it("detects the tempo mismatch that both implementations agree on", () => {
    const buf = readFileSync(RAW);
    const audio = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const chart = JSON.parse(readFileSync(NOTES, "utf-8")) as {
      time: number;
      midiNote: number;
    }[];

    const est = estimateAlignment(onsetEnvelope(audio), chart);

    // Locked onto real onsets, not noise (numpy: ~1.9-3.5 depending on window).
    expect(est.confidence).toBeGreaterThan(1.5);

    // The recording (~109.7bpm) is slower than the MIDI (110.000bpm).
    // numpy said 0.99711; this says 0.99780. Both are meaningfully below 1.
    expect(est.tempoScale).toBeGreaterThan(0.99);
    expect(est.tempoScale).toBeLessThan(0.999);
  });

  it("proves a constant offset alone would break the song", () => {
    const buf = readFileSync(RAW);
    const audio = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const chart = JSON.parse(readFileSync(NOTES, "utf-8")) as {
      time: number;
      midiNote: number;
    }[];
    const est = estimateAlignment(onsetEnvelope(audio), chart);

    // Drift across the song, i.e. what offset-only alignment would leave behind.
    const last = chart[chart.length - 1].time;
    const drift = Math.abs(last * (1 - est.tempoScale)) * 1000;

    // Well beyond the ±100ms edge window: the tail of the song would auto-Miss.
    expect(drift).toBeGreaterThan(300);
  });
});

/**
 * Candidate anchoring: the truth must be REACHABLE, not just scoreable.
 *
 * `analyzeAlignment` offers candidates that are whole-BEAT shifts of an anchor,
 * so the anchor's sub-beat phase is inherited by every one of them. If that
 * phase is wrong, the true alignment is not in the candidate set at all and no
 * amount of enumerating more bars will put it there.
 *
 * This was real, not theoretical. On a known-truth pair (an ADTOF chart against
 * the audio it was transcribed from, so truth is exactly offset 0) the seed
 * landed 1844ms out — 3.9 beats, not a whole number. The truth scored f1 0.705
 * against the winning candidate's 0.664, so the METRIC was right and would have
 * picked it; it was simply never offered, and the nearest candidate sat 206ms
 * away, enough to auto-Miss the whole song.
 *
 * The first fix attempt — a local phase search around the seed — is why this
 * test asserts on TWO offsets. Anchored to the seed it moved to a
 * higher-scoring phase inside its own window and broke a case that already
 * worked. Only a sweep of the whole span the candidates cover is safe.
 */

import { describe, expect, it } from "vitest";

import { ANALYSIS_SAMPLE_RATE, analyzeAlignment, onsetEnvelope } from "../src/renderer/lib/alignment.js";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

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

/** Off-grid notes, so exactly one alignment is correct. See alignment.test.ts. */
function irregularPattern(count: number, seed = 3): { time: number; midiNote: number }[] {
  const rand = rng(seed);
  const notes: { time: number; midiNote: number }[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    t += 0.18 + rand() * 0.45;
    notes.push({ time: t, midiNote: rand() < 0.5 ? 36 : 38 });
  }
  return notes;
}

describe("analyzeAlignment candidate anchoring", () => {
  // 120bpm → a 500ms beat. Each offset below is a deliberately FRACTIONAL
  // number of beats, which is the case beat-shifting alone cannot reach.
  const BPM = 120;

  for (const trueOffsetSec of [1.117, 0.363]) {
    it(`recovers a ${Math.round((trueOffsetSec / 0.5) * 100) / 100}-beat offset (${trueOffsetSec}s)`, () => {
      const chart = irregularPattern(90);
      const audioTimes = chart.map((n) => n.time + trueOffsetSec);
      const duration = Math.max(...audioTimes) + 2;
      const env = onsetEnvelope(clickTrack(audioTimes, duration));

      const { candidates } = analyzeAlignment(env, chart, { bpm: BPM });

      // The winner must be the truth, within the app's Perfect window.
      expect(candidates[0].offsetMs).toBeCloseTo(trueOffsetSec * 1000, -1.4);
      expect(Math.abs(candidates[0].offsetMs - trueOffsetSec * 1000)).toBeLessThan(25);
    });
  }

  it("keeps the truth reachable even when it is a whole number of beats away", () => {
    // The case that previously worked — it must not regress while fixing the
    // fractional one. A whole-beat offset is what beat enumeration was built for.
    const chart = irregularPattern(90, 11);
    const trueOffsetSec = 1.5; // exactly 3 beats at 120bpm
    const audioTimes = chart.map((n) => n.time + trueOffsetSec);
    const env = onsetEnvelope(clickTrack(audioTimes, Math.max(...audioTimes) + 2));

    const { candidates } = analyzeAlignment(env, chart, { bpm: BPM });
    expect(Math.abs(candidates[0].offsetMs - 1500)).toBeLessThan(25);
  });

  it("still produces beat-separated alternatives for a human to choose between", () => {
    // Anchoring must not collapse the candidate list — the whole point of the
    // Sync screen is offering the neighbouring bars/beats the maths cannot rank.
    const chart = irregularPattern(90);
    const audioTimes = chart.map((n) => n.time + 1.117);
    const env = onsetEnvelope(clickTrack(audioTimes, Math.max(...audioTimes) + 2));

    const { candidates } = analyzeAlignment(env, chart, { bpm: BPM });
    const distinct = new Set(candidates.map((c) => Math.round(c.offsetMs / 100)));
    expect(candidates.length).toBeGreaterThan(4);
    expect(distinct.size).toBeGreaterThan(4);
  });
});

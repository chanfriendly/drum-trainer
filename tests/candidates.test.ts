/**
 * Candidate ranking — the way out of the bar ambiguity.
 *
 * The claim under test: a SYMMETRIC score (chart↔audio both ways) can pick the
 * right bar where the mean-based score provably cannot, because it notices
 * onsets nobody played and notes landing in silence — i.e. the song's edges.
 *
 * The old behaviour is pinned in alignment.test.ts ("is ambiguous by whole bars
 * on a PERFECTLY REPETITIVE pattern"). Both are kept deliberately: one documents
 * the limitation, the other documents the escape.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ANALYSIS_SAMPLE_RATE,
  analyzeAlignment,
  detectOnsets,
  onsetEnvelope,
  scoreSymmetric,
} from "../src/renderer/lib/alignment.js";

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

describe("detectOnsets", () => {
  it("finds one onset per hit, not one per frame", () => {
    const onsets = detectOnsets(onsetEnvelope(clickTrack([1, 2, 3], 4)));
    expect(onsets).toHaveLength(3);
    expect(onsets[0]).toBeCloseTo(1, 1);
    expect(onsets[2]).toBeCloseTo(3, 1);
  });

  it("finds nothing in silence", () => {
    expect(detectOnsets(onsetEnvelope(new Float32Array(2 * ANALYSIS_SAMPLE_RATE)))).toHaveLength(0);
  });
});

describe("scoreSymmetric", () => {
  it("is perfect when both sides explain each other", () => {
    const s = scoreSymmetric([1, 2, 3], [1, 2, 3]);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(1);
  });

  it("penalises audio onsets no chart note explains", () => {
    // The blind spot of the mean-based score: it would call this perfect,
    // because every chart note DID land on a hit.
    const s = scoreSymmetric([1], [1, 2, 3]);
    expect(s.recall).toBe(1);
    expect(s.precision).toBeCloseTo(1 / 3, 6);
    expect(s.f1).toBeLessThan(0.6);
  });

  it("penalises chart notes landing in silence", () => {
    const s = scoreSymmetric([1, 2, 3], [1]);
    expect(s.precision).toBe(1);
    expect(s.recall).toBeCloseTo(1 / 3, 6);
  });

  it("is zero on empty input rather than dividing by zero", () => {
    expect(scoreSymmetric([], [1]).f1).toBe(0);
    expect(scoreSymmetric([1], []).f1).toBe(0);
  });
});

describe("analyzeAlignment", () => {
  /** A groove with a real beginning and end — like a song, unlike a loop. */
  function groove(bpm: number, bars: number) {
    const beat = 60 / bpm;
    const notes: { time: number; midiNote: number }[] = [];
    for (let b = 0; b < bars * 4; b++) {
      notes.push({ time: b * beat, midiNote: b % 2 === 0 ? 36 : 38 });
    }
    return notes;
  }

  it("picks the right bar on a uniform groove — where the mean score cannot", () => {
    const bpm = 120;
    const chart = groove(bpm, 8);
    const TRUE_OFFSET = 3.0;
    // Audio contains ONLY the charted hits, with silence before and after. Those
    // edges are the entire signal a bar-shift gets wrong.
    const audio = clickTrack(
      chart.map((n) => n.time + TRUE_OFFSET),
      24,
    );

    const analysis = analyzeAlignment(onsetEnvelope(audio), chart, { bpm });
    const best = analysis.candidates[0];

    expect(Math.abs(best.offsetMs - TRUE_OFFSET * 1000)).toBeLessThan(60);
    expect(analysis.candidates.length).toBeGreaterThan(1); // alternatives were considered
    expect(best.f1).toBeGreaterThan(0.8);
  });

  it("ranks bar-shifted alternatives BELOW the truth", () => {
    const bpm = 120;
    const chart = groove(bpm, 8);
    const audio = clickTrack(
      chart.map((n) => n.time + 3.0),
      24,
    );
    const analysis = analyzeAlignment(onsetEnvelope(audio), chart, { bpm });

    const winner = analysis.candidates[0];
    const shifted = analysis.candidates.filter((c) => c.beatsFromSeed !== winner.beatsFromSeed);
    for (const alt of shifted) {
      expect(alt.f1).toBeLessThanOrEqual(winner.f1);
    }
  });

  it("returns a single candidate when the tempo is unknown, rather than inventing bars", () => {
    const chart = groove(120, 8);
    const audio = clickTrack(chart.map((n) => n.time + 1), 20);
    const analysis = analyzeAlignment(onsetEnvelope(audio), chart, { bpm: null });
    expect(analysis.candidates).toHaveLength(1);
    expect(analysis.confident).toBe(true); // nothing to be unsure between
  });

  it("reports no drift for audio that holds one tempo", () => {
    const chart = groove(120, 30); // 60s — long enough for the windowed check
    const audio = clickTrack(
      chart.map((n) => n.time + 2),
      70,
    );
    const analysis = analyzeAlignment(onsetEnvelope(audio), chart, { bpm: 120 });
    expect(analysis.residualMs).toBeLessThan(25);
    expect(analysis.breathes).toBe(false);
  });

  it("detects a recording that breathes — where no single tempo fits", () => {
    // Audio that speeds up and slows down around the chart's rigid grid. A
    // linear fit CANNOT track this; the residual is what says so.
    const chart = groove(120, 30);
    const audio = clickTrack(
      chart.map((n) => n.time + 2 + 0.12 * Math.sin((n.time / 60) * 2 * Math.PI)),
      70,
    );
    const analysis = analyzeAlignment(onsetEnvelope(audio), chart, { bpm: 120 });
    expect(analysis.residualMs).toBeGreaterThan(25);
    expect(analysis.breathes).toBe(true);
  });
});

/** The oracle: real audio whose true alignment is known exactly. */
const GROOVE_RAW = new URL("./fixtures/practice-groove.raw", import.meta.url).pathname;
const GROOVE_NOTES = new URL("../assets/practice-groove/notes.json", import.meta.url).pathname;

describe.skipIf(!existsSync(GROOVE_RAW))("analyzeAlignment (Practice Groove — known truth)", () => {
  it("picks offset 0 as the winner and knows it", () => {
    const buf = readFileSync(GROOVE_RAW);
    const audio = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const chart = (
      JSON.parse(readFileSync(GROOVE_NOTES, "utf-8")) as { time: number; midi: number }[]
    ).map((n) => ({ time: n.time, midiNote: n.midi }));

    const analysis = analyzeAlignment(onsetEnvelope(audio), chart, { bpm: 100 });
    const best = analysis.candidates[0];

    // Truth is offset 0. Must be inside the Perfect window.
    expect(Math.abs(best.offsetMs)).toBeLessThan(25);
    // It must beat every shifted alternative — but only just. Measured margin is
    // ~0.050 (0.819 vs 0.769 for +1 beat). Even the clearest case that can exist
    // separates by little, which is exactly why the UI ranks candidates and asks
    // rather than silently picking.
    expect(analysis.margin).toBeGreaterThan(0.03);
    expect(analysis.confident).toBe(true);
    // Rendered from its own chart at a fixed tempo: nothing to breathe about.
    expect(analysis.breathes).toBe(false);
    // Precision must be doing real work, not capped by scoring a subset of notes.
    expect(best.precision).toBeGreaterThan(0.7);
  });
});

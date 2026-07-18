/**
 * Chord-file detection at import.
 *
 * Audio-to-MIDI services export pitch transcriptions (chords/bass/vocals), never
 * drums. Those files import cleanly and then play as nonsense — and the symptom
 * reads as broken judging rather than a bad file, which is exactly why it needs
 * catching at the door. Three of the first five real songs imported into this
 * app were chord exports.
 *
 * Thresholds here are calibrated on those real files; the shapes below are taken
 * from them.
 */

import { describe, expect, it } from "vitest";

import type { ChartNote } from "../src/shared/types.js";
import { chartShape, looksHarmonic } from "../src/main/services/chart.js";

/** A chord export: N notes struck together, every `gap` seconds. */
function chordFile(events: number, gap: number, notesPerChord = 3): ChartNote[] {
  const out: ChartNote[] = [];
  for (let e = 0; e < events; e++) {
    for (let n = 0; n < notesPerChord; n++) {
      out.push({ time: e * gap, midiNote: 44 + n * 7, velocity: 100 });
    }
  }
  return out;
}

/** A drum groove: mostly single hits, close together. */
function drumChart(events: number, gap = 0.15): ChartNote[] {
  const out: ChartNote[] = [];
  for (let e = 0; e < events; e++) {
    out.push({ time: e * gap, midiNote: e % 2 === 0 ? 36 : 42, velocity: 100 });
    if (e % 8 === 0) out.push({ time: e * gap, midiNote: 49, velocity: 100 }); // occasional stack
  }
  return out;
}

describe("chartShape", () => {
  it("measures a chord file", () => {
    const s = chartShape(chordFile(50, 1.9));
    expect(s.chordRatio).toBe(1);
    expect(s.medianGapSec).toBeCloseTo(1.9, 3);
    expect(s.eventCount).toBe(50);
  });

  it("measures a drum groove", () => {
    const s = chartShape(drumChart(200));
    expect(s.chordRatio).toBeLessThan(0.2);
    expect(s.medianGapSec).toBeCloseTo(0.15, 3);
  });

  it("handles an empty chart without dividing by zero", () => {
    expect(chartShape([])).toEqual({ chordRatio: 0, medianGapSec: 0, eventCount: 0 });
  });
});

describe("looksHarmonic", () => {
  it("REJECTS the real chord exports (measured shapes)", () => {
    // KRS-ONE: 73 events, 100% triads, 2.506s median gap
    expect(looksHarmonic(chartShape(chordFile(73, 2.506)), false)).toBe(true);
    // Kate Bush: 85 events, 100% triads, 1.717s
    expect(looksHarmonic(chartShape(chordFile(85, 1.717)), false)).toBe(true);
    // Olivia Rodrigo: 98 events, 100% triads, 1.903s
    expect(looksHarmonic(chartShape(chordFile(98, 1.903)), false)).toBe(true);
  });

  it("ACCEPTS real drum charts (measured shapes)", () => {
    // practice-groove: 213 events, 1% triads, 0.300s gap — and it HAS a
    // percussion track, which alone is enough to accept.
    expect(looksHarmonic(chartShape(drumChart(213, 0.3)), true)).toBe(false);
    // Taylor Swift: 1685 events, 2% triads, 0.114s gap
    expect(looksHarmonic(chartShape(drumChart(1685, 0.114)), true)).toBe(false);
  });

  it("NEVER rejects a file that has a percussion track", () => {
    // The decisive signal. A real drum MIDI is on GM channel 10, so even a
    // sparse or chord-heavy one is accepted — better to let an odd chart
    // through than to block a genuine drum file.
    const chordy = chartShape(chordFile(100, 2));
    expect(looksHarmonic(chordy, true)).toBe(false);
  });

  it("does not reject a dense chord-less melody line without a percussion track", () => {
    // A single-note melody: chordRatio 0, so it passes even though it isn't
    // drums. This check targets CHORD exports specifically; catching every
    // possible non-drum file would risk rejecting real ones.
    const melody = chartShape(chordFile(80, 0.4, 1));
    expect(looksHarmonic(melody, false)).toBe(false);
  });

  it("does not judge a file too small to have a shape", () => {
    expect(looksHarmonic(chartShape(chordFile(4, 2)), false)).toBe(false);
  });

  it("accepts a fast chord-ish file (gap too short to be chord changes)", () => {
    // Guard against over-rejection: triads 0.2s apart are not a chord chart.
    expect(looksHarmonic(chartShape(chordFile(60, 0.2)), false)).toBe(false);
  });
});

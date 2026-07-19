/**
 * Chart parsing and difficulty — the pure core of import.
 *
 * These go through REAL MIDI bytes (built with @tonejs/midi and round-tripped
 * through toArray) rather than hand-mocked structures, so what's asserted is
 * what an actual .mid file produces. chartShape/looksHarmonic have their own
 * file (chart-shape.test.ts); this one covers parseChart, difficultyFor and
 * notesPerSecond, which had none.
 */

import { describe, expect, it } from "vitest";
import { Midi } from "@tonejs/midi";

import { difficultyFor, notesPerSecond, parseChart } from "../src/main/services/chart.js";

/** Build real MIDI bytes. Notes: [midi, time, velocity(0-1)] per track. */
function midiBytes(
  tracks: { channel?: number; notes: [number, number, number][] }[],
  bpm?: number,
): Uint8Array {
  const midi = new Midi();
  if (bpm !== undefined) {
    midi.header.tempos.push({ bpm, ticks: 0 });
    midi.header.update();
  }
  for (const spec of tracks) {
    const track = midi.addTrack();
    if (spec.channel !== undefined) track.channel = spec.channel;
    for (const [note, time, velocity] of spec.notes) {
      track.addNote({ midi: note, time, duration: 0.1, velocity });
    }
  }
  return new Uint8Array(midi.toArray());
}

describe("difficultyFor", () => {
  it("buckets by notes per second, boundaries going UP", () => {
    // The boundaries are `<`, so landing exactly on one promotes you.
    expect(difficultyFor(0)).toBe("Easy");
    expect(difficultyFor(1.99)).toBe("Easy");
    expect(difficultyFor(2)).toBe("Medium");
    expect(difficultyFor(3.99)).toBe("Medium");
    expect(difficultyFor(4)).toBe("Hard");
    expect(difficultyFor(6.99)).toBe("Hard");
    expect(difficultyFor(7)).toBe("Expert");
    expect(difficultyFor(20)).toBe("Expert");
  });
});

describe("notesPerSecond", () => {
  it("divides, and treats zero duration as zero rather than Infinity", () => {
    expect(notesPerSecond(300, 100)).toBe(3);
    expect(notesPerSecond(300, 0)).toBe(0);
    expect(notesPerSecond(0, 100)).toBe(0);
  });
});

describe("parseChart", () => {
  it("takes ONLY percussion tracks when the file has one", () => {
    const bytes = midiBytes([
      { channel: 9, notes: [[36, 0, 0.8], [38, 0.5, 0.8]] },
      { channel: 0, notes: [[60, 0, 0.8], [64, 0, 0.8], [67, 0, 0.8]] }, // a C chord
    ]);
    const { chart, usedPercussionTracks } = parseChart(bytes);
    expect(usedPercussionTracks).toBe(true);
    expect(chart.map((n) => n.midiNote)).toEqual([36, 38]);
  });

  it("falls back to every track when no percussion track exists, and says so", () => {
    const bytes = midiBytes([{ channel: 0, notes: [[60, 0, 0.8], [64, 1, 0.8]] }]);
    const { chart, usedPercussionTracks } = parseChart(bytes);
    // The fallback exists so an import never silently yields an empty chart —
    // and the flag is what lets looksHarmonic treat that fallback with suspicion.
    expect(usedPercussionTracks).toBe(false);
    expect(chart).toHaveLength(2);
  });

  it("merges multiple percussion tracks and sorts by time", () => {
    const bytes = midiBytes([
      { channel: 9, notes: [[42, 1.0, 0.8], [42, 3.0, 0.8]] },
      { channel: 9, notes: [[36, 0.5, 0.8], [36, 2.0, 0.8]] },
    ]);
    const { chart } = parseChart(bytes);
    expect(chart.map((n) => n.time)).toEqual([0.5, 1.0, 2.0, 3.0]);
  });

  it("converts normalized velocity to 1-127", () => {
    // The wire format quantizes to 7 bits on WRITE (floor), so what round-trips
    // is the quantized value: 0.5 → byte 63, and the faintest surviving
    // velocity is byte 1 (≈0.008). These asserted values are MIDI's, not ours.
    const bytes = midiBytes([
      { channel: 9, notes: [[36, 0, 0.008], [38, 1, 1.0], [42, 2, 0.5]] },
    ]);
    const { chart } = parseChart(bytes);
    expect(chart.map((n) => n.velocity)).toEqual([1, 127, 63]);
  });

  it("never yields a velocity-0 note — MIDI defines that as a note-off", () => {
    // A "note" with velocity 0 is the running-status idiom for releasing a key.
    // The parser must treat it as such (no chart note), not as a silent hit.
    const bytes = midiBytes([{ channel: 9, notes: [[36, 0, 0]] }]);
    const { chart } = parseChart(bytes);
    expect(chart).toHaveLength(0);
  });

  it("reports the first declared tempo, or null when the file declares none", () => {
    const withTempo = parseChart(midiBytes([{ channel: 9, notes: [[36, 0, 0.8]] }], 123.4));
    expect(withTempo.bpm).toBeCloseTo(123.4, 2);

    const without = parseChart(midiBytes([{ channel: 9, notes: [[36, 0, 0.8]] }]));
    expect(without.bpm).toBeNull();
  });

  it("keeps raw GM note numbers — lanes are assigned at judge time, not here", () => {
    // Note 39 (Hand Clap) is outside the default mapping. It must still be in
    // the chart: mapping it is the user's call in Settings, and excluding it
    // here would make remapping require a re-import.
    const bytes = midiBytes([{ channel: 9, notes: [[39, 0, 0.8]] }]);
    const { chart } = parseChart(bytes);
    expect(chart[0].midiNote).toBe(39);
  });
});

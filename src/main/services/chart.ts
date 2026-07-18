/**
 * Chart parsing and difficulty — the pure core of import.
 *
 * Split out of library-service so it can be tested without touching Electron,
 * userData, or the filesystem. Per CLAUDE.md → Principles, these are exactly
 * the functions where assertions CAN establish correctness, so they are the
 * ones that must be provably right.
 */

import { Midi } from "@tonejs/midi";

import type { ChartNote, Difficulty } from "../../shared/types.js";

export function difficultyFor(notesPerSecond: number): Difficulty {
  if (notesPerSecond < 2) return "Easy";
  if (notesPerSecond < 4) return "Medium";
  if (notesPerSecond < 7) return "Hard";
  return "Expert";
}

/**
 * Parse a MIDI file's drum track into a chart.
 *
 * Prefers percussion tracks (GM channel 10, which is index 9 zero-based, or a
 * track flagged percussion). Falls back to every track when a file has no
 * percussion track, so an import never silently yields an empty chart.
 *
 * Notes keep their RAW GM note number — lanes are assigned at judge time via
 * the editable mapping. See CLAUDE.md → Conventions.
 */
export function parseChart(data: Uint8Array): {
  chart: ChartNote[];
  duration: number;
  bpm: number | null;
  /** False when the file had no percussion track and we fell back to all tracks. */
  usedPercussionTracks: boolean;
} {
  const midi = new Midi(data);

  const percussionTracks = midi.tracks.filter(
    (track) => track.instrument?.percussion === true || track.channel === 9,
  );
  const tracks = percussionTracks.length > 0 ? percussionTracks : midi.tracks;

  const chart: ChartNote[] = [];
  for (const track of tracks) {
    for (const note of track.notes) {
      chart.push({
        time: note.time,
        midiNote: note.midi,
        // @tonejs/midi gives normalized 0-1 velocity; the chart stores 1-127.
        velocity: Math.max(1, Math.min(127, Math.round(note.velocity * 127))),
      });
    }
  }
  chart.sort((a, b) => a.time - b.time);

  // The FIRST tempo only. A file may have a tempo map, but this is used for one
  // thing — sizing the Sync screen's ±1 bar nudge — and a bar is only a useful
  // unit where the tempo is steady anyway. Null when the file declares none.
  const bpm = midi.header.tempos[0]?.bpm ?? null;

  return {
    chart,
    duration: midi.duration,
    bpm,
    usedPercussionTracks: percussionTracks.length > 0,
  };
}

/** Notes per second across the song — the difficulty input. */
export function notesPerSecond(noteCount: number, duration: number): number {
  return duration > 0 ? noteCount / duration : 0;
}

// ── Is this actually a drum chart? ────────────────────────────────────

export interface ChartShape {
  /** Share of timestamps carrying 3+ simultaneous notes (a chord). */
  chordRatio: number;
  /** Typical seconds between events. Drums are dense; chords are not. */
  medianGapSec: number;
  /** Distinct events, i.e. distinct onset times. */
  eventCount: number;
}

/**
 * Measure the shape of a parsed chart.
 *
 * Pure and separate from the verdict so the numbers can be shown to the user
 * and asserted in tests.
 */
export function chartShape(chart: ChartNote[]): ChartShape {
  if (chart.length === 0) return { chordRatio: 0, medianGapSec: 0, eventCount: 0 };

  const byTime = new Map<string, number>();
  for (const note of chart) {
    const key = note.time.toFixed(3);
    byTime.set(key, (byTime.get(key) ?? 0) + 1);
  }

  const sizes = [...byTime.values()];
  const chordRatio = sizes.filter((n) => n >= 3).length / sizes.length;

  const times = [...new Set(chart.map((n) => n.time))].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  gaps.sort((a, b) => a - b);
  const medianGapSec = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : 0;

  return { chordRatio, medianGapSec, eventCount: byTime.size };
}

/**
 * Does this file look like harmony (chords/melody) rather than drums?
 *
 * WHY THIS EXISTS. Audio-to-MIDI services (Fadr and friends) export *pitch*
 * transcriptions — chords, bass, vocals — because pitch is what they detect.
 * Drums are unpitched, so those exports contain no drum track at all. Their
 * files are named like any other `.mid`, so it is very easy to import one as a
 * drum chart. Three of the first five real songs imported into this app were
 * chord exports, and the symptom was NOT "wrong notes" — it was gameplay
 * feeling broken and Sync reporting near-zero confidence, which reads as an app
 * bug rather than a bad file.
 *
 * The signals, all of which held on the real cases:
 *   - no percussion track in the file (drum MIDIs are on GM channel 10)
 *   - most events are 3+ notes struck together (a triad)
 *   - events are ~1-3s apart (chord changes), where drums are ~0.1-0.3s
 *
 * All three must hold. A sparse real drum chart still has a percussion track;
 * a busy chord file still has wide gaps. Requiring agreement keeps this from
 * rejecting unusual but genuine charts.
 */
export function looksHarmonic(shape: ChartShape, usedPercussionTracks: boolean): boolean {
  if (usedPercussionTracks) return false;
  if (shape.eventCount < 8) return false; // too little to judge
  return shape.chordRatio >= 0.5 && shape.medianGapSec >= 0.5;
}

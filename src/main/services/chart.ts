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

  return { chart, duration: midi.duration, bpm };
}

/** Notes per second across the song — the difficulty input. */
export function notesPerSecond(noteCount: number, duration: number): number {
  return duration > 0 ? noteCount / duration : 0;
}

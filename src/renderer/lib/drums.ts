import type { DrumType } from "../../shared/types.js";

export const DRUM_TYPES: DrumType[] = ["kick", "snare", "hihat", "tom", "crash", "ride"];

export const DRUM_LABELS: Record<DrumType, string> = {
  kick: "Kick",
  snare: "Snare",
  hihat: "Hi-Hat",
  tom: "Tom",
  crash: "Crash",
  ride: "Ride",
};

/** Vivid lane colours for the gameplay canvas (neon gaming aesthetic). */
export const DRUM_COLORS: Record<DrumType, string> = {
  kick: "#a855f7", // violet
  snare: "#ef4444", // red
  hihat: "#eab308", // yellow
  tom: "#22c55e", // green
  crash: "#f97316", // orange
  ride: "#06b6d4", // cyan
};

/** Dim variants for lane backgrounds. */
export const DRUM_COLORS_DIM: Record<DrumType, string> = {
  kick: "rgba(168, 85, 247, 0.12)",
  snare: "rgba(239, 68, 68, 0.12)",
  hihat: "rgba(234, 179, 8, 0.12)",
  tom: "rgba(34, 197, 94, 0.12)",
  crash: "rgba(249, 115, 22, 0.12)",
  ride: "rgba(6, 182, 212, 0.12)",
};

/**
 * Default General MIDI drum mapping.
 *
 * Notes NOT listed here are ignored at judge time — not scored as misses. That
 * is deliberate: an unmapped note means the app doesn't know the player's kit,
 * and punishing them for the app's ignorance is wrong. Real charts hit this: the
 * Another One Bites the Dust chart has 75 Hand Clap (39) notes that fall through
 * to "ignored" until the player maps them with Learn.
 */
export const DEFAULT_MIDI_MAPPING: Record<number, DrumType> = {
  // Kick
  35: "kick",
  36: "kick",
  // Snare
  37: "snare",
  38: "snare",
  40: "snare",
  // Hi-Hat
  22: "hihat",
  26: "hihat",
  42: "hihat",
  44: "hihat",
  46: "hihat",
  // Tom
  41: "tom",
  43: "tom",
  45: "tom",
  47: "tom",
  48: "tom",
  50: "tom",
  58: "tom",
  // Crash
  49: "crash",
  52: "crash",
  55: "crash",
  57: "crash",
  // Ride
  51: "ride",
  53: "ride",
  59: "ride",
};

/**
 * General MIDI percussion names, for showing a bare note number as something a
 * human can act on. "Note 54" tells you nothing; "Tambourine" tells you which
 * pad you'd want it on.
 */
export const GM_DRUM_NAMES: Record<number, string> = {
  35: "Acoustic Bass Drum", 36: "Bass Drum 1", 37: "Side Stick", 38: "Acoustic Snare",
  39: "Hand Clap", 40: "Electric Snare", 41: "Low Floor Tom", 42: "Closed Hi-Hat",
  43: "High Floor Tom", 44: "Pedal Hi-Hat", 45: "Low Tom", 46: "Open Hi-Hat",
  47: "Low-Mid Tom", 48: "Hi-Mid Tom", 49: "Crash Cymbal 1", 50: "High Tom",
  51: "Ride Cymbal 1", 52: "Chinese Cymbal", 53: "Ride Bell", 54: "Tambourine",
  55: "Splash Cymbal", 56: "Cowbell", 57: "Crash Cymbal 2", 58: "Vibraslap",
  59: "Ride Cymbal 2", 60: "Hi Bongo", 61: "Low Bongo", 62: "Mute Hi Conga",
  63: "Open Hi Conga", 64: "Low Conga", 65: "High Timbale", 66: "Low Timbale",
  67: "High Agogo", 68: "Low Agogo", 69: "Cabasa", 70: "Maracas",
  71: "Short Whistle", 72: "Long Whistle", 73: "Short Guiro", 74: "Long Guiro",
  75: "Claves", 76: "Hi Wood Block", 77: "Low Wood Block", 78: "Mute Cuica",
  79: "Open Cuica", 80: "Mute Triangle", 81: "Open Triangle",
};

export interface UnmappedNote {
  midiNote: number;
  /** GM name if known — otherwise the caller shows the bare number. */
  name: string | null;
  /** How many notes across the whole library carry it. */
  count: number;
  /** Song names it appears in, for "where is this coming from?". */
  songs: string[];
}

/**
 * Which notes in these charts have no lane, and so are invisible during play.
 *
 * WHY THIS EXISTS. Excluding unmapped notes is correct — scoring them as misses
 * would punish the player for the app's ignorance of their kit. But doing it
 * SILENTLY is not: a chart can put a third of its notes on a drum the default
 * mapping doesn't know, and the player just sees a section with nothing in it
 * and assumes the chart is broken. Measured on a real chart: Taylor Swift's Red
 * carries 670 notes (34% of it) on Tambourine (54), which replaces the hi-hat
 * pattern outright in the choruses.
 *
 * Worse, Learn cannot fix it. Learn maps whatever pad you HIT, and no e-kit
 * sends a tambourine note — so without a way to assign a note you can't play,
 * those notes are permanently unreachable.
 *
 * Sorted by count: the one worth mapping is the one that appears most.
 */
export function findUnmappedNotes(
  songs: { name: string; chart: { midiNote: number }[] }[],
  mapping: Record<number, DrumType>,
): UnmappedNote[] {
  const byNote = new Map<number, { count: number; songs: Set<string> }>();

  for (const song of songs) {
    for (const note of song.chart) {
      if (mapping[note.midiNote]) continue;
      let entry = byNote.get(note.midiNote);
      if (!entry) {
        entry = { count: 0, songs: new Set() };
        byNote.set(note.midiNote, entry);
      }
      entry.count++;
      entry.songs.add(song.name);
    }
  }

  return [...byNote.entries()]
    .map(([midiNote, { count, songs: names }]) => ({
      midiNote,
      name: GM_DRUM_NAMES[midiNote] ?? null,
      count,
      songs: [...names].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.midiNote - b.midiNote);
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

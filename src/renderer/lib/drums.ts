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

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

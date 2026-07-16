/**
 * Types shared across main, preload, and renderer.
 *
 * These describe the IPC payloads and the on-disk storage shapes, so they are
 * the contract between processes. The Glaze sources declared `DrumType` twice
 * (renderer/lib/types.ts and main/services/results-service.ts); they are unified
 * here so the two can never drift.
 */

export type DrumType = "kick" | "snare" | "hihat" | "tom" | "crash" | "ride";

export type Difficulty = "Easy" | "Medium" | "Hard" | "Expert";

/** A judged outcome for a single note. */
export type Judgment = "perfect" | "good" | "early" | "late" | "miss";

// ── MIDI ──────────────────────────────────────────────────────────────

export interface MidiDevice {
  index: number;
  name: string;
}

export interface MidiNoteEvent {
  /** MIDI note number (0-127). */
  note: number;
  /** Velocity (1-127). */
  velocity: number;
  /** Raw MIDI status byte. */
  status: number;
  /**
   * Main-process `performance.now()` at receipt, in ms.
   *
   * Diagnostics only. NEVER compare this to `audioEl.currentTime` — the two
   * clocks share no origin. Judging reads the audio clock in the renderer at
   * the instant the event arrives. See CLAUDE.md → Principles.
   */
  timestamp: number;
}

// ── Chart & library ───────────────────────────────────────────────────

/**
 * One charted note. Stores the RAW General MIDI note number, never a lane —
 * lane assignment happens at judge time through the user-editable mapping, so
 * remapping a drum never requires re-importing a song.
 */
export interface ChartNote {
  /** Seconds from song start. */
  time: number;
  /** Raw General MIDI note number (0-127). */
  midiNote: number;
  /** Velocity 1-127. */
  velocity: number;
}

export interface SongMeta {
  id: string;
  name: string;
  /** Song duration in seconds (from the MIDI file). */
  duration: number;
  /** Total drum notes in the chart. */
  noteCount: number;
  difficulty: Difficulty;
  /** File name only; the bytes are served over `song-audio://`. */
  audioFile: string;
  createdAt: number;
}

export interface SongWithChart extends SongMeta {
  chart: ChartNote[];
}

export interface ImportSongInput {
  audioPath: string;
  midiPath: string;
  name?: string;
}

// ── Results ───────────────────────────────────────────────────────────

export interface JudgmentBreakdown {
  perfect: number;
  good: number;
  early: number;
  late: number;
  miss: number;
}

export interface SongResult {
  id: string;
  songId: string;
  playedAt: number;
  score: number;
  /** 0-100. */
  accuracy: number;
  maxCombo: number;
  totalNotes: number;
  overall: JudgmentBreakdown;
  perDrum: Record<DrumType, JudgmentBreakdown>;
}

export type ResultInput = Omit<SongResult, "id" | "playedAt">;

// ── Settings (renderer-owned, localStorage) ───────────────────────────

export interface HitWindows {
  perfectMs: number;
  goodMs: number;
  edgeMs: number;
}

export interface AppSettings {
  midiMapping: Record<number, DrumType>;
  hitWindows: HitWindows;
  latencyOffsetMs: number;
  selectedDeviceIndex: number | null;
}

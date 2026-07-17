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

/**
 * Maps chart time onto audio time: `audioSeconds = chartSeconds * tempoScale +
 * offsetMs/1000`.
 *
 * WHY THIS EXISTS. The spec assumes an audio + MIDI pair is inherently aligned.
 * That is only true when both come from the same master. A MIDI transcription
 * paired with a commercial recording is not: measured on the first real pair
 * (Another One Bites the Dust), the MIDI is a rigid 110.000 bpm grid while the
 * recording sits at ~109.68 bpm and is not perfectly steady. The chart walks
 * ~3ms further out of sync per second — ~600ms by the end of the song.
 *
 * With only the global latency offset (which is for HARDWARE lag, and is a
 * single constant for the whole app), ~64% of that song auto-Misses no matter
 * how well the player drums. Worse, it presents as "the judging is broken",
 * which sends you debugging the wrong code.
 *
 * So alignment is PER SONG and has two terms, not one. `latencyOffsetMs` in
 * settings stays what it always was: hardware/IPC lag, global, from calibration.
 * These two are a property of the file pair. Don't merge them.
 */
export interface SongAlignment {
  /** Constant shift, ms. Positive = the chart happens LATER in the audio. */
  offsetMs: number;
  /** Tempo ratio. 1 = MIDI tempo matches the recording. */
  tempoScale: number;
  /** How this was arrived at — `none` means untried, so gameplay should warn. */
  source: "none" | "auto" | "manual";
  /**
   * Mean onset-envelope score at the chosen alignment, in standard deviations
   * above the envelope mean. Near 0 means the chart landed on random audio (a
   * failed estimate); >1 is a confident lock. Surface this rather than silently
   * trusting a bad auto-estimate.
   */
  confidence: number;
}

export const NO_ALIGNMENT: SongAlignment = {
  offsetMs: 0,
  tempoScale: 1,
  source: "none",
  confidence: 0,
};

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
  /**
   * The MIDI's first declared tempo, or null if it declares none.
   *
   * Used only to size the Sync screen's ±1 bar nudge — auto-alignment is
   * ambiguous by whole bars, so "nudge one bar" needs to know how long a bar is.
   * Not used for judging: chart note times are absolute seconds already.
   */
  bpm: number | null;
  /** How the chart lines up with the audio. See SongAlignment. */
  alignment: SongAlignment;
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

/**
 * Library Service — song import, storage, and retrieval.
 *
 * Songs live under `<userData>/songs/<id>/`:
 *   - the imported audio file (original extension preserved)
 *   - `song.json`    — metadata + parsed chart (source of truth for notes)
 *   - `results.json` — performance history (owned by results-service)
 *
 * The MIDI file is the ONLY source of chart notes; nothing is ever inferred
 * from audio. See CLAUDE.md → Critical rules.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { app } from "electron";

import type {
  ImportSongInput,
  SongAlignment,
  SongMeta,
  SongWithChart,
} from "../../shared/types.js";
import { NO_ALIGNMENT } from "../../shared/types.js";
import { logger } from "../logger.js";
import { chartShape, difficultyFor, looksHarmonic, notesPerSecond, parseChart } from "./chart.js";

/**
 * `app.getPath` is SYNCHRONOUS in Electron — the Glaze sources awaited it, and
 * awaiting a non-promise happens to work, which is exactly why the mistake
 * survives review. Kept sync here so the whole cached-promise dance the Glaze
 * version needed just disappears.
 */
function songsRoot(): string {
  return path.join(app.getPath("userData"), "songs");
}

export function getSongDir(id: string): string {
  return path.join(songsRoot(), id);
}

function generateId(): string {
  return `song_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Import a song from an audio file + a MIDI file (both already on disk). */
export async function importSong(input: ImportSongInput): Promise<SongMeta> {
  const audioPath = input.audioPath?.trim();
  const midiPath = input.midiPath?.trim();
  if (!audioPath || !midiPath) {
    throw new Error("Import requires both an audio file and a MIDI file.");
  }

  // Parse BEFORE copying anything: a bad MIDI file should fail the import
  // without leaving a half-written song directory behind.
  let parsed: ReturnType<typeof parseChart>;
  try {
    const buffer = await fs.readFile(midiPath);
    parsed = parseChart(new Uint8Array(buffer));
  } catch (error) {
    logger.warn("library", "MIDI parse failed", error);
    throw new Error(
      `Could not read "${path.basename(midiPath)}" as a MIDI file. Pick a valid .mid or .midi file.`,
    );
  }

  const { chart, duration, bpm, usedPercussionTracks } = parsed;
  if (chart.length === 0) {
    throw new Error("No drum notes found in that MIDI file. Pick one that contains a drum track.");
  }

  // Refuse chord/melody exports before they become a "song" that plays as
  // nonsense. See looksHarmonic() for why this is worth a hard stop: the
  // failure mode presents as broken judging, not as a bad file.
  const shape = chartShape(chart);
  if (looksHarmonic(shape, usedPercussionTracks)) {
    logger.warn("library", "Rejected harmonic MIDI as a drum chart", {
      midiPath: path.basename(midiPath),
      chordRatio: shape.chordRatio,
      medianGapSec: shape.medianGapSec,
    });
    throw new Error(
      `"${path.basename(midiPath)}" looks like a chord or melody track, not a drum chart. ` +
        `${Math.round(shape.chordRatio * 100)}% of its notes are struck in chords, ` +
        `about ${shape.medianGapSec.toFixed(1)}s apart, and it has no drum (percussion) track.\n\n` +
        `Audio-to-MIDI services export chords, bass and vocals — not drums. ` +
        `Look for a MIDI with a real drum track, or export one from a drum score.`,
    );
  }

  // Fail before writing if the audio is unreadable.
  try {
    await fs.access(audioPath);
  } catch {
    throw new Error(`Could not read the audio file "${path.basename(audioPath)}".`);
  }

  const id = generateId();
  const dir = getSongDir(id);
  await fs.mkdir(dir, { recursive: true });

  try {
    const audioExt = path.extname(audioPath) || ".mp3";
    const audioFile = `audio${audioExt}`;
    await fs.copyFile(audioPath, path.join(dir, audioFile));

    const name = input.name?.trim() || path.basename(audioPath, path.extname(audioPath));

    const meta: SongMeta = {
      id,
      name,
      duration,
      noteCount: chart.length,
      difficulty: difficultyFor(notesPerSecond(chart.length, duration)),
      audioFile,
      createdAt: Date.now(),
      bpm,
      // Import cannot estimate alignment: the audio decoder lives in the
      // renderer (Web Audio). The renderer runs the estimate and calls
      // songs:setAlignment. Until then `source: "none"` marks it unaligned, and
      // gameplay should say so rather than silently judging a drifting chart.
      alignment: NO_ALIGNMENT,
      analysisAudioFile: null,
      chartSource: input.chartSource ?? "midi",
    };

    // Copy the analysis stem in the same breath as the audio, so a transcribed
    // song arrives already able to Sync well instead of needing a second step.
    if (input.analysisAudioPath) {
      try {
        const ext = path.extname(input.analysisAudioPath) || ".wav";
        meta.analysisAudioFile = `analysis${ext}`;
        await fs.copyFile(input.analysisAudioPath, path.join(dir, meta.analysisAudioFile));
      } catch (error) {
        // A missing stem must not fail the import — it is an optimisation for
        // Sync, not part of the song.
        meta.analysisAudioFile = null;
        logger.warn("library", "Could not copy analysis audio", error);
      }
    }

    const full: SongWithChart = { ...meta, chart };
    await fs.writeFile(path.join(dir, "song.json"), JSON.stringify(full), "utf-8");

    logger.info("library", "Imported song", {
      id,
      name,
      noteCount: chart.length,
      difficulty: meta.difficulty,
    });
    return meta;
  } catch (error) {
    // Never leave a partial song directory — it would show up in the library as
    // an entry that cannot be played or deleted cleanly.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    logger.error("library", "Import failed, rolled back", error);
    throw error;
  }
}

async function readSong(id: string): Promise<SongWithChart | null> {
  try {
    const raw = await fs.readFile(path.join(getSongDir(id), "song.json"), "utf-8");
    const song = JSON.parse(raw) as SongWithChart;
    // Songs written before these fields existed lack them. Default rather than
    // letting `undefined` reach the renderer's judging math or the Sync screen.
    return {
      ...song,
      alignment: song.alignment ?? NO_ALIGNMENT,
      bpm: song.bpm ?? null,
      analysisAudioFile: song.analysisAudioFile ?? null,
      // Everything imported before this field existed came from a real MIDI.
      chartSource: song.chartSource ?? "midi",
    };
  } catch {
    return null;
  }
}

/**
 * Persist an alignment. Separate from import because only the renderer can
 * decode audio, so the estimate necessarily arrives later.
 */
export async function setAlignment(id: string, alignment: SongAlignment): Promise<SongMeta> {
  const song = await readSong(id);
  if (!song) throw new Error(`Song not found: ${id}`);

  if (!Number.isFinite(alignment.offsetMs) || !Number.isFinite(alignment.tempoScale)) {
    throw new Error("Alignment offsetMs and tempoScale must be finite numbers.");
  }
  // A tempoScale far from 1 means the estimate is nonsense, not that the song is
  // exotic; applying it would scatter the chart across the song.
  if (alignment.tempoScale < 0.5 || alignment.tempoScale > 2) {
    throw new Error(`Implausible tempoScale: ${alignment.tempoScale}`);
  }

  const updated: SongWithChart = { ...song, alignment };
  await fs.writeFile(path.join(getSongDir(id), "song.json"), JSON.stringify(updated), "utf-8");

  logger.info("library", "Saved alignment", {
    id,
    offsetMs: Math.round(alignment.offsetMs),
    tempoScale: alignment.tempoScale,
    source: alignment.source,
    confidence: alignment.confidence,
  });

  const { chart: _chart, ...meta } = updated;
  return meta;
}

/**
 * Attach (path) or remove (null) a separate analysis stem for Sync.
 *
 * The file is COPIED into the song directory, like import does for the main
 * audio: a song must stay playable if the original download is deleted.
 */
export async function setAnalysisAudio(id: string, sourcePath: string | null): Promise<SongMeta> {
  const song = await readSong(id);
  if (!song) throw new Error(`Song not found: ${id}`);
  const dir = getSongDir(id);

  // Remove the old file in both paths: replacing an .mp3 stem with a .flac one
  // must not leave a stale analysis.mp3 behind.
  if (song.analysisAudioFile) {
    await fs.rm(path.join(dir, song.analysisAudioFile), { force: true }).catch(() => {});
  }

  let analysisAudioFile: string | null = null;
  if (sourcePath !== null) {
    const src = sourcePath.trim();
    try {
      await fs.access(src);
    } catch {
      throw new Error(`Could not read the audio file "${path.basename(src)}".`);
    }
    // "analysis" never collides with the main audio, which is always "audio.<ext>".
    analysisAudioFile = `analysis${path.extname(src) || ".mp3"}`;
    await fs.copyFile(src, path.join(dir, analysisAudioFile));
  }

  const updated: SongWithChart = { ...song, analysisAudioFile };
  await fs.writeFile(path.join(dir, "song.json"), JSON.stringify(updated), "utf-8");
  logger.info("library", "Set analysis audio", { id, analysisAudioFile });

  const { chart: _chart, ...meta } = updated;
  return meta;
}

/** List all songs (metadata only — the chart can be thousands of notes). */
export async function listSongs(): Promise<SongMeta[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(songsRoot());
  } catch {
    return []; // No songs directory yet — an empty library, not an error.
  }

  const songs = await Promise.all(entries.map((id) => readSong(id)));

  return songs
    .filter((song): song is SongWithChart => song !== null)
    .map(({ chart: _chart, ...meta }) => meta)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Get a single song including its full chart. */
export async function getSong(id: string): Promise<SongWithChart> {
  const song = await readSong(id);
  if (!song) throw new Error(`Song not found: ${id}`);
  return song;
}

/** Delete a song and everything under it (audio, chart, results history). */
export async function deleteSong(id: string): Promise<void> {
  // Guard: an id containing path separators would escape the songs root.
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`Invalid song id: ${id}`);
  }
  await fs.rm(getSongDir(id), { recursive: true, force: true });
  logger.info("library", "Deleted song", { id });
}

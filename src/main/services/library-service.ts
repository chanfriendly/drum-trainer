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

import type { ImportSongInput, SongMeta, SongWithChart } from "../../shared/types.js";
import { logger } from "../logger.js";
import { difficultyFor, notesPerSecond, parseChart } from "./chart.js";

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

  const { chart, duration } = parsed;
  if (chart.length === 0) {
    throw new Error("No drum notes found in that MIDI file. Pick one that contains a drum track.");
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
    };

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
    return JSON.parse(raw) as SongWithChart;
  } catch {
    return null;
  }
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

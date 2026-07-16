/**
 * Results Service — performance history per song.
 *
 * History lives in `<userData>/songs/<id>/results.json` as a newest-first array,
 * so deleting a song takes its history with it (same directory).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ResultInput, SongResult } from "../../shared/types.js";
import { logger } from "../logger.js";
import { getSongDir } from "./library-service.js";

function resultsPath(songId: string): string {
  return path.join(getSongDir(songId), "results.json");
}

export async function listResults(songId: string): Promise<SongResult[]> {
  try {
    const raw = await fs.readFile(resultsPath(songId), "utf-8");
    const parsed = JSON.parse(raw) as SongResult[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // No history yet, or unreadable — an empty list either way.
  }
}

export async function saveResult(input: ResultInput): Promise<SongResult> {
  if (!input.songId) throw new Error("saveResult requires a songId.");

  const result: SongResult = {
    ...input,
    id: `res_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    playedAt: Date.now(),
  };

  const existing = await listResults(input.songId);
  existing.unshift(result); // Newest first.
  await fs.writeFile(resultsPath(input.songId), JSON.stringify(existing), "utf-8");

  logger.info("results", "Saved result", {
    songId: input.songId,
    score: result.score,
    accuracy: result.accuracy,
  });
  return result;
}

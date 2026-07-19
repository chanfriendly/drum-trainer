/**
 * Audio loading and preview playback.
 *
 * This is the renderer's half of the alignment feature: it decodes a song's
 * audio with Web Audio (no native dependency, no ffmpeg, works in the packaged
 * app) and hands PCM to the pure estimator in alignment.ts.
 *
 * The bytes come over `song-audio://`, never IPC — see CLAUDE.md → Architecture.
 */

import type { SongMeta } from "../../shared/types.js";
import { ANALYSIS_SAMPLE_RATE, toMono } from "./alignment.js";

export function songAudioUrl(song: SongMeta): string {
  const params = new URLSearchParams({ id: song.id, file: song.audioFile });
  return `song-audio://audio?${params.toString()}`;
}

/** Decoded playback audio, keyed by song id — gameplay and preview reuse it. */
const decodeCache = new Map<string, AudioBuffer>();

/** Decode a song-audio:// file at its native rate. */
async function decodeUrl(url: string, label: string, cacheKey?: string): Promise<AudioBuffer> {
  const cached = cacheKey ? decodeCache.get(cacheKey) : undefined;
  if (cached) return cached;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load audio (HTTP ${response.status}). The file may be missing.`);
  }
  const bytes = await response.arrayBuffer();

  // A bare AudioContext decodes at the hardware rate; that's fine here because
  // analysis resamples separately below and preview wants full quality.
  const ctx = new AudioContext();
  try {
    return await new Promise<AudioBuffer>((resolve, reject) => {
      // Callback form: Safari/WebKit historically lacked the promise form, and
      // this decodes whatever the platform supports (mp3/m4a/flac/wav).
      ctx.decodeAudioData(
        bytes,
        (buffer) => {
          if (cacheKey) decodeCache.set(cacheKey, buffer);
          resolve(buffer);
        },
        (err) =>
          reject(
            new Error(
              `Could not decode "${label}". The file may be corrupt or in an unsupported format. (${err?.message ?? "unknown"})`,
            ),
          ),
      );
    });
  } finally {
    void ctx.close();
  }
}

export async function decodeSongAudio(song: SongMeta): Promise<AudioBuffer> {
  return decodeUrl(songAudioUrl(song), song.audioFile, song.id);
}

/**
 * Decode whatever Sync should ANALYSE: the attached drum stem when the song has
 * one, otherwise the playback audio. Deliberately uncached — replacing the stem
 * reuses the same file name, so a cache keyed on anything stable would serve
 * the old stem, and analysis runs once per Auto-align click anyway.
 */
async function decodeAnalysisAudio(song: SongMeta): Promise<AudioBuffer> {
  if (!song.analysisAudioFile) return decodeSongAudio(song);
  const params = new URLSearchParams({ id: song.id, file: song.analysisAudioFile });
  return decodeUrl(`song-audio://audio?${params.toString()}`, song.analysisAudioFile);
}

/**
 * Mono PCM at ANALYSIS_SAMPLE_RATE, for the onset envelope. Reads the analysis
 * stem when one is attached (see decodeAnalysisAudio), else the playback audio.
 *
 * Resampling goes through an OfflineAudioContext rather than naive decimation:
 * dropping samples aliases high frequencies down into the spectrum, and the
 * onset detector reads exactly those bands (cymbals, snare rattle). Aliased
 * garbage there would degrade the estimate in a way that's hard to attribute.
 */
export async function loadAnalysisPcm(song: SongMeta): Promise<Float32Array> {
  const buffer = await decodeAnalysisAudio(song);

  const frames = Math.ceil((buffer.duration * ANALYSIS_SAMPLE_RATE) / 1);
  const offline = new OfflineAudioContext(1, frames, ANALYSIS_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();

  const rendered = await offline.startRendering();
  return toMono([rendered.getChannelData(0)]);
}

/**
 * Preview player: plays the song from a given point with a click on each charted
 * note, so the player can HEAR whether the chart lines up.
 *
 * This is the confirmation step that makes auto-alignment safe. The estimator
 * cannot tell which bar is correct (a groove looks identical shifted a bar), so
 * a human ear is the oracle. Scheduling is done on the Web Audio clock, which is
 * sample-accurate, rather than setTimeout.
 */
/**
 * The song is ducked under the clicks. A commercial master is limited to near
 * 0dBFS, so a click mixed at unity against it is masked — and an inaudible
 * click makes this whole screen useless, since the preview IS the verdict.
 * Loud enough to still hear where the drums are, quiet enough to hear the tick
 * against them.
 */
const PREVIEW_MUSIC_GAIN = 0.4;

export class AlignmentPreview {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;

  /**
   * @param noteTimes Chart times, in CHART seconds (the alignment is applied here).
   * @returns how many clicks were scheduled — zero means the caller picked a
   *   window with nothing in it, which must not look like silence-as-success.
   */
  async play(
    song: SongMeta,
    noteTimes: number[],
    alignment: { offsetMs: number; tempoScale: number },
    fromSeconds: number,
    durationSeconds: number,
  ): Promise<number> {
    this.stop();

    const buffer = await decodeSongAudio(song);
    const ctx = new AudioContext();
    this.ctx = ctx;

    const music = ctx.createGain();
    music.gain.value = PREVIEW_MUSIC_GAIN;
    music.connect(ctx.destination);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(music);
    this.source = source;

    // Everything is scheduled relative to this instant on the audio clock.
    const startAt = ctx.currentTime + 0.15; // small lead so scheduling isn't late
    source.start(startAt, fromSeconds, durationSeconds);

    let scheduled = 0;
    for (const chartTime of noteTimes) {
      const audioTime = chartTime * alignment.tempoScale + alignment.offsetMs / 1000;
      if (audioTime < fromSeconds || audioTime > fromSeconds + durationSeconds) continue;
      this.scheduleClick(ctx, startAt + (audioTime - fromSeconds));
      scheduled++;
    }
    return scheduled;
  }

  /**
   * A short bright tick — deliberately unlike a drum, so it's distinguishable.
   *
   * Two partials rather than one sine: a bare 1800Hz tone sits inside the same
   * band as hats and vocal sibilance and blends into them. The octave above
   * gives it an edge that reads as "not part of the music".
   */
  private scheduleClick(ctx: AudioContext, when: number): void {
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.9, when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.04);

    for (const [freq, level] of [
      [1800, 1],
      [3600, 0.5],
    ]) {
      const osc = ctx.createOscillator();
      const partial = ctx.createGain();
      partial.gain.value = level;
      osc.frequency.value = freq;
      osc.connect(partial);
      partial.connect(gain);
      osc.start(when);
      osc.stop(when + 0.05);
    }
  }

  stop(): void {
    try {
      this.source?.stop();
    } catch {
      /* already stopped */
    }
    this.source = null;
    void this.ctx?.close();
    this.ctx = null;
  }
}

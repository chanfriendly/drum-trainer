/**
 * IPC handlers — a thin boundary over the services. Validate, delegate, return.
 *
 * Everything crossing this line comes from the renderer, so nothing is trusted:
 * each argument is checked before it reaches a service. `ipcMain.handle` turns a
 * thrown error into a rejected promise in the renderer, which is the intended
 * path for user-facing failures (bad import file, missing song).
 *
 * Live note-ons are pushed the other way, to every window, via
 * `webContents.send("midi:note", …)`.
 */

import { BrowserWindow, ipcMain } from "electron";

import * as midi from "../services/midi-service.js";
import * as library from "../services/library-service.js";
import * as results from "../services/results-service.js";
import { pickAudioFile, pickMidiFile } from "../dialogs.js";
import { logger } from "../logger.js";
import type { JudgmentBreakdown, DrumType } from "../../shared/types.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected an object argument.");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${field}".`);
  }
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Expected number for "${field}".`);
  }
  return value;
}

/** Broadcast to every open window. */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

export function registerHandlers(): void {
  // Forward live MIDI note-ons to renderers.
  midi.setNoteListener((event) => broadcast("midi:note", event));

  // ── MIDI devices ────────────────────────────────────────────────────
  ipcMain.handle("midi:listDevices", () => midi.listDevices());

  ipcMain.handle("midi:openDevice", (_event, arg: unknown) => {
    const index = asNumber(arg, "index");
    midi.openDevice(index);
    return { ok: true as const, index };
  });

  ipcMain.handle("midi:closeDevice", () => {
    midi.closeDevice();
    return { ok: true as const };
  });

  ipcMain.handle("midi:getOpenDevice", () => midi.getOpenPortIndex());

  // ── File pickers ────────────────────────────────────────────────────
  ipcMain.handle("dialog:pickAudio", () => pickAudioFile());
  ipcMain.handle("dialog:pickMidi", () => pickMidiFile());

  // ── Song library ────────────────────────────────────────────────────
  ipcMain.handle("songs:import", (_event, arg: unknown) => {
    const obj = asRecord(arg);
    return library.importSong({
      audioPath: asString(obj.audioPath, "audioPath"),
      midiPath: asString(obj.midiPath, "midiPath"),
      name: typeof obj.name === "string" ? obj.name : undefined,
    });
  });

  ipcMain.handle("songs:list", () => library.listSongs());

  ipcMain.handle("songs:get", (_event, arg: unknown) => library.getSong(asString(arg, "id")));

  ipcMain.handle("songs:delete", async (_event, arg: unknown) => {
    await library.deleteSong(asString(arg, "id"));
    return { ok: true as const };
  });

  ipcMain.handle("songs:setAlignment", (_event, arg: unknown) => {
    const obj = asRecord(arg);
    const alignment = asRecord(obj.alignment);
    const source = alignment.source;
    if (source !== "none" && source !== "auto" && source !== "manual") {
      throw new Error(`Invalid alignment source: ${String(source)}`);
    }
    return library.setAlignment(asString(obj.id, "id"), {
      offsetMs: asNumber(alignment.offsetMs, "offsetMs"),
      tempoScale: asNumber(alignment.tempoScale, "tempoScale"),
      source,
      confidence: asNumber(alignment.confidence, "confidence"),
    });
  });

  ipcMain.handle("songs:setAnalysisAudio", (_event, arg: unknown) => {
    const obj = asRecord(arg);
    // null is meaningful (remove the stem), so it can't go through asString.
    if (obj.path !== null && typeof obj.path !== "string") {
      throw new Error('Expected string or null for "path".');
    }
    return library.setAnalysisAudio(
      asString(obj.id, "id"),
      obj.path === null ? null : asString(obj.path, "path"),
    );
  });

  // ── Results history ─────────────────────────────────────────────────
  ipcMain.handle("results:list", (_event, arg: unknown) =>
    results.listResults(asString(arg, "songId")),
  );

  ipcMain.handle("results:save", (_event, arg: unknown) => {
    const r = asRecord(arg);
    return results.saveResult({
      songId: asString(r.songId, "songId"),
      score: asNumber(r.score, "score"),
      accuracy: asNumber(r.accuracy, "accuracy"),
      maxCombo: asNumber(r.maxCombo, "maxCombo"),
      totalNotes: asNumber(r.totalNotes, "totalNotes"),
      overall: r.overall as JudgmentBreakdown,
      perDrum: r.perDrum as Record<DrumType, JudgmentBreakdown>,
    });
  });

  logger.info("ipc", "Handlers registered");
}

/** Release the MIDI device on quit. */
export function cleanupHandlers(): void {
  midi.setNoteListener(null);
  midi.closeDevice();
}

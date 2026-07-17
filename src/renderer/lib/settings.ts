/**
 * Renderer-owned settings, persisted to localStorage.
 *
 * NOTE `latencyOffsetMs` here is HARDWARE lag — your kit, CoreMIDI, the audio
 * output path — and is global, from calibration. It is NOT the same thing as a
 * song's `alignment`, which describes the audio/MIDI file pair. Keeping them
 * separate is deliberate: see SongAlignment in shared/types.ts.
 */

import type { AppSettings } from "../../shared/types.js";
import { DEFAULT_MIDI_MAPPING } from "./drums.js";

const SETTINGS_KEY = "drumTrainer.settings";

export const DEFAULT_SETTINGS: AppSettings = {
  midiMapping: DEFAULT_MIDI_MAPPING,
  hitWindows: {
    perfectMs: 25,
    goodMs: 50,
    edgeMs: 100,
  },
  latencyOffsetMs: 0,
  selectedDeviceIndex: null,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      hitWindows: { ...DEFAULT_SETTINGS.hitWindows, ...(parsed.hitWindows ?? {}) },
      // JSON object keys are strings; the mapping is keyed by number.
      midiMapping: parsed.midiMapping
        ? (Object.fromEntries(
            Object.entries(parsed.midiMapping).map(([k, v]) => [Number(k), v]),
          ) as AppSettings["midiMapping"])
        : DEFAULT_MIDI_MAPPING,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function updateSettings(partial: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...loadSettings(), ...partial };
  saveSettings(next);
  return next;
}

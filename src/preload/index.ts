/**
 * Preload — the ONLY main↔renderer surface.
 *
 * Replaces Glaze's `@glaze/core/preload` + JSON-RPC transport with plain
 * `contextBridge` + `ipcRenderer`. Context isolation is on, so nothing here
 * leaks `ipcRenderer` itself into the page: each channel is exposed as a named
 * function, and the renderer cannot invoke arbitrary channels.
 *
 * Keep this in sync with the IPC table in CLAUDE.md and the handlers in
 * src/main/ipc/. The shape here IS the contract.
 */

import { contextBridge, ipcRenderer } from "electron";

import type {
  ImportSongInput,
  MidiDevice,
  MidiNoteEvent,
  ResultInput,
  SongAlignment,
  SongMeta,
  SongResult,
  SongWithChart,
} from "../shared/types.js";

/** Subscribe helper — returns an unsubscribe fn so React effects can clean up. */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  midi: {
    listDevices: (): Promise<MidiDevice[]> => ipcRenderer.invoke("midi:listDevices"),
    openDevice: (index: number): Promise<{ ok: true; index: number }> =>
      ipcRenderer.invoke("midi:openDevice", index),
    closeDevice: (): Promise<{ ok: true }> => ipcRenderer.invoke("midi:closeDevice"),
    getOpenDevice: (): Promise<number | null> => ipcRenderer.invoke("midi:getOpenDevice"),
    /**
     * Live note-on stream. The renderer must read `audioEl.currentTime` inside
     * this callback to judge — see CLAUDE.md → Principles. `event.timestamp` is
     * diagnostics only.
     */
    onNote: (callback: (event: MidiNoteEvent) => void): (() => void) =>
      subscribe<MidiNoteEvent>("midi:note", callback),
  },
  songs: {
    import: (input: ImportSongInput): Promise<SongMeta> => ipcRenderer.invoke("songs:import", input),
    list: (): Promise<SongMeta[]> => ipcRenderer.invoke("songs:list"),
    get: (id: string): Promise<SongWithChart> => ipcRenderer.invoke("songs:get", id),
    delete: (id: string): Promise<{ ok: true }> => ipcRenderer.invoke("songs:delete", id),
    /** Persist a chart↔audio alignment. See SongAlignment for why this exists. */
    setAlignment: (id: string, alignment: SongAlignment): Promise<SongMeta> =>
      ipcRenderer.invoke("songs:setAlignment", { id, alignment }),
    /** Attach a drum stem for Sync's estimator (path), or remove it (null). */
    setAnalysisAudio: (id: string, path: string | null): Promise<SongMeta> =>
      ipcRenderer.invoke("songs:setAnalysisAudio", { id, path }),
    /** Native open dialogs — the renderer cannot reach the filesystem itself. */
    pickAudio: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickAudio"),
    pickMidi: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickMidi"),
  },
  results: {
    list: (songId: string): Promise<SongResult[]> => ipcRenderer.invoke("results:list", songId),
    save: (input: ResultInput): Promise<SongResult> => ipcRenderer.invoke("results:save", input),
  },
  /** Menu → route navigation (the "Settings…" item). */
  onNavigate: (callback: (path: string) => void): (() => void) =>
    subscribe<string>("nav:goto", callback),
};

export type DrumTrainerAPI = typeof api;

contextBridge.exposeInMainWorld("drumTrainer", api);

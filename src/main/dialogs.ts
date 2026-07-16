/**
 * Native file pickers.
 *
 * The renderer is context-isolated with no Node access, so it cannot read a
 * file path from a drag-drop or <input type="file"> in a form the main process
 * can use. Import needs real on-disk paths (it copies the audio and parses the
 * MIDI), so the picker has to live here.
 */

import { BrowserWindow, dialog } from "electron";

const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "ogg", "flac"];
const MIDI_EXTENSIONS = ["mid", "midi"];

async function pickOne(name: string, extensions: string[]): Promise<string | null> {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options: Electron.OpenDialogOptions = {
    properties: ["openFile"],
    filters: [{ name, extensions }],
  };

  // Sheet-style (attached to the window) when there is a window to attach to.
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

export function pickAudioFile(): Promise<string | null> {
  return pickOne("Audio", AUDIO_EXTENSIONS);
}

export function pickMidiFile(): Promise<string | null> {
  return pickOne("MIDI", MIDI_EXTENSIONS);
}

/**
 * MIDI Service — real-time CoreMIDI input.
 *
 * Uses @julusian/midi (N-API, prebuilt binary) to enumerate CoreMIDI input
 * ports and stream note-on events. One persistent Input is open at a time; its
 * note-ons are forwarded to a listener with a high-resolution timestamp.
 *
 * The timestamp is DIAGNOSTICS ONLY. Judging reads the audio clock in the
 * renderer at the moment the event arrives — see CLAUDE.md → Principles.
 *
 * PORTING NOTE: the Glaze version commented that "Input has no explicit
 * destroy" and let the enumeration probe get garbage collected. That is not
 * true of @julusian/midi 3.6.1, which exposes `destroy()`. Every probe was
 * leaking a CoreMIDI client until GC ran, and Settings enumerates on every
 * open. The probe is now destroyed explicitly.
 */

import { Input } from "@julusian/midi";

import type { MidiDevice, MidiNoteEvent } from "../../shared/types.js";
import { logger } from "../logger.js";

const NOTE_ON = 0x90;

let input: Input | null = null;
let openPortIndex: number | null = null;
let noteListener: ((event: MidiNoteEvent) => void) | null = null;

/** Enumerate available CoreMIDI input ports. */
export function listDevices(): MidiDevice[] {
  const probe = new Input();
  try {
    const count = probe.getPortCount();
    const devices: MidiDevice[] = [];
    for (let i = 0; i < count; i++) {
      devices.push({ index: i, name: probe.getPortName(i) });
    }
    return devices;
  } finally {
    try {
      probe.destroy();
    } catch {
      /* already disposed */
    }
  }
}

/** Open a CoreMIDI input port by index and begin streaming note-on events. */
export function openDevice(index: number): void {
  closeDevice();

  const inp = new Input();
  const count = inp.getPortCount();
  if (index < 0 || index >= count) {
    inp.destroy();
    throw new Error(`MIDI port index ${index} out of range (${count} ports available)`);
  }

  const name = inp.getPortName(index);

  inp.on("message", (_deltaTime: number, message: number[]) => {
    const [status, note, velocity] = message;
    // Note-on with non-zero velocity. Many kits send note-on velocity 0 to mean
    // note-off, so velocity must be checked, not just the status byte.
    if ((status & 0xf0) === NOTE_ON && velocity > 0) {
      noteListener?.({ note, velocity, status, timestamp: performance.now() });
    }
  });

  inp.openPort(index);
  input = inp;
  openPortIndex = index;
  logger.info("midi", "Opened MIDI input port", { index, name });
}

/** Close and dispose the currently open input port, if any. */
export function closeDevice(): void {
  if (!input) return;
  try {
    input.closePort();
    input.destroy();
  } catch {
    /* already closed */
  }
  input = null;
  openPortIndex = null;
}

export function getOpenPortIndex(): number | null {
  return openPortIndex;
}

/** Register the single note-event listener (the renderer forwarder). */
export function setNoteListener(listener: ((event: MidiNoteEvent) => void) | null): void {
  noteListener = listener;
}

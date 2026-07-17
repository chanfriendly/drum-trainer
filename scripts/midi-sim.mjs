#!/usr/bin/env node
/**
 * MIDI simulator — plays the part of an e-kit over the IAC bus.
 *
 * WHY: nearly all of this app can be exercised without hardware. CoreMIDI can't
 * be faked, but it CAN be driven: enable the IAC Driver (a virtual MIDI cable
 * built into macOS) and this script sends note-ons into it, which the app
 * receives exactly as it would from a real kit. That covers the whole chain —
 * addon → main → IPC → renderer → judge → HUD — with no drums in the room.
 *
 * WHAT IT DOES NOT COVER: timing *feel*, and real-kit quirks (velocity curves,
 * hi-hat pedal CC, double-triggering, unplug/replug). This proves plumbing, not
 * playability. Note times here are wall-clock from when you hit enter, with no
 * way to sync to the app's audio clock, so expect Early/Late rather than
 * Perfect — that is the harness's imprecision, not the judge's.
 *
 * SETUP (one time): Audio MIDI Setup → Window → Show MIDI Studio (⌘2) →
 * double-click IAC Driver → tick "Device is online".
 *
 * USAGE
 *   node scripts/midi-sim.mjs burst [seconds]     # dense hits on all 6 lanes
 *   node scripts/midi-sim.mjs note <midiNote>     # one hit (for Settings→Learn)
 *   node scripts/midi-sim.mjs chart <file.mid> [--delay 3]
 *                                                 # play a chart's drum track
 *   node scripts/midi-sim.mjs devices             # list MIDI outputs
 */

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
// @julusian/midi is CommonJS with no ESM entry; require it rather than fight
// Node's ESM named-export detection.
const { Output } = require("@julusian/midi");

/** GM notes the default mapping understands, one per lane. */
const LANE_NOTES = { kick: 36, snare: 38, hihat: 42, tom: 45, crash: 49, ride: 51 };
const NOTE_ON_CH10 = 0x99; // note-on, channel 10 (percussion)
const NOTE_OFF_CH10 = 0x89;

function openIac() {
  const out = new Output();
  const count = out.getPortCount();
  for (let i = 0; i < count; i++) {
    if (out.getPortName(i).includes("IAC")) {
      out.openPort(i);
      console.log(`→ ${out.getPortName(i)}`);
      return out;
    }
  }
  out.destroy();
  console.error(
    "No IAC output found. Enable it: Audio MIDI Setup → Window → Show MIDI Studio (⌘2)\n" +
      "→ double-click IAC Driver → tick “Device is online”.",
  );
  process.exit(1);
}

function hit(out, note, velocity = 100) {
  out.sendMessage([NOTE_ON_CH10, note, velocity]);
  // A real kit sends note-off; the app ignores it (pads are momentary), but
  // sending it keeps the stream well-formed for anything else listening.
  setTimeout(() => out.sendMessage([NOTE_OFF_CH10, note, 0]), 20);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [mode = "burst", arg, ...rest] = process.argv.slice(2);

  if (mode === "devices") {
    const out = new Output();
    const count = out.getPortCount();
    console.log(count === 0 ? "(no MIDI outputs)" : "MIDI outputs:");
    for (let i = 0; i < count; i++) console.log(`  ${i}: ${out.getPortName(i)}`);
    out.destroy();
    return;
  }

  const out = openIac();

  if (mode === "note") {
    const note = Number(arg);
    if (!Number.isFinite(note)) {
      console.error("usage: midi-sim.mjs note <midiNote>   e.g. note 38");
      process.exit(1);
    }
    hit(out, note);
    console.log(`sent note ${note}`);
    await sleep(150);
  } else if (mode === "burst") {
    const seconds = Number(arg ?? 8);
    const order = Object.values(LANE_NOTES);
    const started = Date.now();
    let sent = 0;
    console.log(`bursting all lanes for ${seconds}s…`);
    while (Date.now() - started < seconds * 1000) {
      hit(out, order[sent % order.length]);
      sent++;
      await sleep(40);
    }
    console.log(`sent ${sent} note-ons`);
  } else if (mode === "chart") {
    if (!arg) {
      console.error("usage: midi-sim.mjs chart <file.mid> [--delay 3]");
      process.exit(1);
    }
    const delayIdx = rest.indexOf("--delay");
    const delaySec = delayIdx === -1 ? 3 : Number(rest[delayIdx + 1]);

    // Import lazily: only this mode needs a MIDI parser.
    const { Midi } = await import("@tonejs/midi/dist/Midi.js");
    const midi = new Midi(new Uint8Array(await readFile(arg)));
    const tracks = midi.tracks.filter((t) => t.instrument?.percussion === true || t.channel === 9);
    const notes = (tracks.length ? tracks : midi.tracks)
      .flatMap((t) => t.notes.map((n) => ({ time: n.time, midi: n.midi })))
      .sort((a, b) => a.time - b.time);

    console.log(`${notes.length} notes over ${midi.duration.toFixed(1)}s`);
    console.log(`starting in ${delaySec}s — hit Play in the app NOW`);
    await sleep(delaySec * 1000);

    const t0 = Date.now();
    for (const n of notes) {
      const due = t0 + n.time * 1000;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      hit(out, n.midi);
    }
    console.log("chart finished");
  } else {
    console.error(`unknown mode "${mode}". Try: burst | note | chart | devices`);
    process.exit(1);
  }

  out.closePort();
  out.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

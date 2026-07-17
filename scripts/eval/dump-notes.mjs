#!/usr/bin/env node
/**
 * MIDI drum track → JSON note events, for the transcription harness.
 *
 * Exists because Python has no MIDI parser installed and Node already has
 * @tonejs/midi. Deliberately mirrors src/main/services/chart.ts's track
 * selection (percussion tracks, else everything) so the harness evaluates
 * against the SAME notes the app would chart — an evaluation against a
 * different note set would be measuring the wrong thing.
 *
 * Usage: node scripts/eval/dump-notes.mjs <file.mid> [out.json]
 */

import { readFile, writeFile } from "node:fs/promises";

import { Midi } from "@tonejs/midi/dist/Midi.js";

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error("usage: dump-notes.mjs <file.mid> [out.json]");
  process.exit(1);
}

const midi = new Midi(new Uint8Array(await readFile(input)));
const percussion = midi.tracks.filter((t) => t.instrument?.percussion === true || t.channel === 9);
const tracks = percussion.length > 0 ? percussion : midi.tracks;

const notes = tracks
  .flatMap((t) => t.notes.map((n) => ({ time: n.time, midi: n.midi, velocity: n.velocity })))
  .sort((a, b) => a.time - b.time);

const payload = {
  source: input,
  duration: midi.duration,
  bpm: midi.header.tempos[0]?.bpm ?? null,
  usedPercussionTracks: percussion.length > 0,
  notes,
};

const json = JSON.stringify(payload);
if (output) {
  await writeFile(output, json);
  console.error(`wrote ${output}: ${notes.length} notes, ${midi.duration.toFixed(1)}s`);
} else {
  process.stdout.write(json);
}

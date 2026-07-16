/**
 * Generates the "Practice Groove" test song's MIDI drum chart.
 *
 * WHY THIS EXISTS. Every real audio+MIDI pair has unknown alignment (see
 * CHANGELOG 2026-07-16), so with real songs we can never tell "gameplay is
 * broken" apart from "that pair doesn't line up". This chart is rendered to
 * audio by scripts/render-test-song.py FROM THIS EXACT NOTE LIST, so the pair is
 * aligned by construction: offset 0, tempoScale 1, sample-accurate. That makes
 * it an ORACLE — the one song where the correct answer is known.
 *
 * It is also original content, so unlike the Queen pair it can be committed.
 *
 * Deliberate properties:
 *  - Uses ALL SIX lanes. The Queen chart only has kick/snare/hihat and would
 *    never surface a tom/crash/ride bug.
 *  - Has structure (fills, a break, section changes), so the alignment estimator
 *    has something to lock onto rather than a uniform loop.
 *
 * Usage: node scripts/generate-test-song.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The bare specifier resolves to @tonejs/midi's CommonJS `main`, whose named
// exports Node's ESM loader can't see. Vite picks the `module` (ESM) entry, so
// the app is unaffected; this script points at it explicitly.
import { Midi } from "@tonejs/midi/dist/Midi.js";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "practice-groove");

const BPM = 100;
const BEAT = 60 / BPM; // 0.6s
const BAR = BEAT * 4; // 2.4s

// General MIDI drum notes.
const KICK = 36;
const SNARE = 38;
const HAT_CLOSED = 42;
const HAT_OPEN = 46;
const TOM_LOW = 45;
const TOM_MID = 47;
const TOM_HIGH = 48;
const CRASH = 49;
const RIDE = 51;

/** @type {{time: number, midi: number, velocity: number}[]} */
const notes = [];
const at = (bar, beat, midi, velocity = 0.8) =>
  notes.push({ time: bar * BAR + beat * BEAT, midi, velocity });

// ── Section A (bars 0-7): straight rock groove, closed hats ──────────
for (let bar = 0; bar < 8; bar++) {
  if (bar === 0) at(bar, 0, CRASH, 0.9);
  for (let eighth = 0; eighth < 8; eighth++) {
    at(bar, eighth * 0.5, HAT_CLOSED, eighth % 2 === 0 ? 0.7 : 0.5);
  }
  at(bar, 0, KICK, 0.9);
  at(bar, 1, SNARE, 0.85);
  at(bar, 2, KICK, 0.85);
  if (bar % 2 === 1) at(bar, 2.5, KICK, 0.7); // syncopation
  at(bar, 3, SNARE, 0.85);
}

// ── Section B (bars 8-15): ride, busier kick ─────────────────────────
for (let bar = 8; bar < 16; bar++) {
  if (bar === 8) at(bar, 0, CRASH, 0.95);
  for (let eighth = 0; eighth < 8; eighth++) {
    at(bar, eighth * 0.5, RIDE, eighth % 2 === 0 ? 0.7 : 0.5);
  }
  at(bar, 0, KICK, 0.9);
  at(bar, 0.75, KICK, 0.7);
  at(bar, 1, SNARE, 0.85);
  at(bar, 2.5, KICK, 0.85);
  at(bar, 3, SNARE, 0.85);

  // Bar 15: tom fill — a landmark, and the only 16th-note tom run.
  if (bar === 15) {
    notes.length = notes.findIndex((n) => n.time >= bar * BAR); // clear that bar
    at(bar, 0, TOM_HIGH, 0.85);
    at(bar, 0.25, TOM_HIGH, 0.7);
    at(bar, 0.5, TOM_MID, 0.85);
    at(bar, 0.75, TOM_MID, 0.7);
    at(bar, 1, TOM_LOW, 0.9);
    at(bar, 1.25, TOM_LOW, 0.75);
    at(bar, 1.5, SNARE, 0.85);
    at(bar, 1.75, SNARE, 0.7);
    at(bar, 2, TOM_HIGH, 0.9);
    at(bar, 2.25, TOM_MID, 0.8);
    at(bar, 2.5, TOM_LOW, 0.9);
    at(bar, 2.75, TOM_LOW, 0.8);
    at(bar, 3, SNARE, 0.95);
    at(bar, 3.5, KICK, 0.9);
  }
}

// ── Section C (bars 16-23): open hats + tom accents ──────────────────
for (let bar = 16; bar < 24; bar++) {
  if (bar === 16) at(bar, 0, CRASH, 0.95);
  for (let eighth = 0; eighth < 8; eighth++) {
    // Open hat on the "and" of 4 — a recurring but not uniform accent.
    at(bar, eighth * 0.5, eighth === 7 ? HAT_OPEN : HAT_CLOSED, eighth === 7 ? 0.8 : 0.6);
  }
  at(bar, 0, KICK, 0.9);
  at(bar, 1, SNARE, 0.85);
  at(bar, 2, KICK, 0.85);
  at(bar, 3, SNARE, 0.85);
  if (bar % 4 === 3) {
    at(bar, 3.5, TOM_MID, 0.8);
    at(bar, 3.75, TOM_LOW, 0.8);
  }
}

// ── Break (bar 24): near-silence. The clearest landmark in the song. ─
at(24, 0, CRASH, 1.0);
at(24, 0, KICK, 0.9);
// bars 24 rests otherwise

// ── Outro (bar 25) ───────────────────────────────────────────────────
at(25, 0, TOM_HIGH, 0.8);
at(25, 0.5, TOM_MID, 0.85);
at(25, 1, TOM_LOW, 0.9);
at(25, 1.5, SNARE, 0.9);
at(25, 2, CRASH, 1.0);
at(25, 2, KICK, 1.0);

notes.sort((a, b) => a.time - b.time);

// ── Write MIDI ───────────────────────────────────────────────────────
const midi = new Midi();
midi.header.setTempo(BPM);
midi.header.timeSignatures.push({ ticks: 0, timeSignature: [4, 4] });
const track = midi.addTrack();
track.channel = 9; // GM channel 10 (zero-based 9) == percussion
track.name = "Drums";
for (const n of notes) {
  track.addNote({ midi: n.midi, time: n.time, duration: 0.08, velocity: n.velocity });
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "practice-groove.mid"), Buffer.from(midi.toArray()));

// The renderer script consumes this so the audio is built from the SAME times
// the chart uses — that identity is the whole point.
writeFileSync(
  join(OUT_DIR, "notes.json"),
  JSON.stringify(notes.map((n) => ({ time: n.time, midi: n.midi, velocity: n.velocity }))),
);

const lanes = new Map();
for (const n of notes) lanes.set(n.midi, (lanes.get(n.midi) ?? 0) + 1);
const duration = notes[notes.length - 1].time;
console.log(`Practice Groove: ${notes.length} notes, ${duration.toFixed(2)}s, ${BPM}bpm`);
console.log(`notes/sec ${(notes.length / duration).toFixed(2)}`);
console.log("distribution:", [...lanes.entries()].sort((a, b) => a[0] - b[0]));

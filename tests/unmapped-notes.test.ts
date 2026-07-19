/**
 * Finding chart notes that have no lane.
 *
 * Excluding unmapped notes from scoring is a hard rule (never punish the player
 * for the app's ignorance of their kit). Doing it silently is the bug this
 * function exists to prevent: on a real chart — Taylor Swift's Red — 670 of
 * 1,944 notes sit on Tambourine (54), which REPLACES the hi-hat pattern in the
 * choruses rather than doubling it. The player sees a section with nothing in
 * it and concludes the chart is broken.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_MIDI_MAPPING, findUnmappedNotes } from "../src/renderer/lib/drums.js";

const song = (name: string, notes: number[]) => ({
  name,
  chart: notes.map((midiNote) => ({ midiNote })),
});

describe("findUnmappedNotes", () => {
  it("returns nothing when every note has a lane", () => {
    expect(findUnmappedNotes([song("a", [36, 38, 42])], DEFAULT_MIDI_MAPPING)).toEqual([]);
  });

  it("finds unmapped notes and names them from General MIDI", () => {
    const found = findUnmappedNotes([song("Red", [36, 54, 54, 54])], DEFAULT_MIDI_MAPPING);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ midiNote: 54, name: "Tambourine", count: 3, songs: ["Red"] });
  });

  it("ranks by count — the note worth mapping is the one that appears most", () => {
    const found = findUnmappedNotes(
      [song("x", [56, ...Array<number>(10).fill(54)])],
      DEFAULT_MIDI_MAPPING,
    );
    expect(found.map((n) => n.midiNote)).toEqual([54, 56]);
  });

  it("aggregates one note across songs, listing each song once", () => {
    const found = findUnmappedNotes(
      [song("A", [54, 54]), song("B", [54]), song("A", [54])],
      DEFAULT_MIDI_MAPPING,
    );
    expect(found[0].count).toBe(4);
    expect(found[0].songs).toEqual(["A", "B"]);
  });

  it("respects a CUSTOM mapping, not just the defaults", () => {
    // The whole point: once the player maps 54, it must stop being reported —
    // otherwise the list never empties and the warning becomes noise.
    const mapped = { ...DEFAULT_MIDI_MAPPING, 54: "hihat" as const };
    expect(findUnmappedNotes([song("Red", [54, 54])], mapped)).toEqual([]);
  });

  it("reports an unknown percussion note with a null name rather than dropping it", () => {
    const found = findUnmappedNotes([song("odd", [99])], DEFAULT_MIDI_MAPPING);
    expect(found[0]).toMatchObject({ midiNote: 99, name: null, count: 1 });
  });
});

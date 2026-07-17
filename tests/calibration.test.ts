/**
 * Calibration maths.
 *
 * The offset these functions produce is subtracted from the audio clock on every
 * judged note, so a bug here quietly mis-scores every song — and would present
 * as "the judging feels off", which is exactly the misattribution this project
 * keeps having to design against.
 */

import { describe, expect, it } from "vitest";

import {
  SETTLING_TAPS,
  clickSchedule,
  matchTapsToClicks,
  median,
  robustSpread,
  summarize,
} from "../src/renderer/lib/calibration.js";

describe("median", () => {
  it("handles odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("ignores an outlier that would wreck a mean", () => {
    // The reason median is used at all: one flubbed tap must not move the number.
    expect(median([10, 11, 12, 13, 500])).toBe(12);
  });

  it("returns 0 for no samples", () => {
    expect(median([])).toBe(0);
  });
});

describe("robustSpread", () => {
  it("is ~0 for identical taps", () => {
    expect(robustSpread([20, 20, 20, 20])).toBe(0);
  });

  it("grows with scatter", () => {
    expect(robustSpread([0, 100, 200, 300])).toBeGreaterThan(50);
  });

  it("is not fooled by a single outlier", () => {
    // A standard deviation here would be ~200; MAD stays small, which is the
    // point: one bad tap shouldn't condemn an otherwise tight run.
    expect(robustSpread([20, 21, 19, 20, 500])).toBeLessThan(5);
  });
});

describe("clickSchedule", () => {
  it("spaces clicks by the beat", () => {
    expect(clickSchedule(120, 4)).toEqual([0, 0.5, 1, 1.5]);
  });

  it("honours a start offset", () => {
    expect(clickSchedule(60, 3, 10)).toEqual([10, 11, 12]);
  });
});

describe("matchTapsToClicks", () => {
  const clicks = clickSchedule(100, 8); // every 0.6s

  it("pairs each tap with the click it was aiming at", () => {
    const samples = matchTapsToClicks([0.02, 0.62, 1.22], clicks);
    expect(samples).toHaveLength(3);
    expect(samples[0].clickTime).toBeCloseTo(0, 6);
    expect(samples[1].clickTime).toBeCloseTo(0.6, 6);
    expect(samples[2].clickTime).toBeCloseTo(1.2, 6);
  });

  it("DROPS a tap too far from any click rather than snapping it", () => {
    // A missed beat is not evidence about latency. Snapping it to the nearest
    // click would fold most of a beat into the estimate.
    const samples = matchTapsToClicks([0.3], clicks);
    expect(samples).toHaveLength(0);
  });

  it("handles no taps and no clicks", () => {
    expect(matchTapsToClicks([], clicks)).toEqual([]);
    expect(matchTapsToClicks([1], [])).toEqual([]);
  });
});

describe("summarize", () => {
  /** Taps that land `offsetMs` after each click. */
  function taps(offsetMs: number, count: number, jitterMs = 0): number[] {
    const clicks = clickSchedule(100, count);
    return clicks.map((c, i) => {
      const jitter = jitterMs === 0 ? 0 : ((i % 3) - 1) * jitterMs;
      return c + (offsetMs + jitter) / 1000;
    });
  }

  it("recovers a clean constant lag", () => {
    const clicks = clickSchedule(100, 12);
    const result = summarize(matchTapsToClicks(taps(30, 12), clicks));
    expect(result.offsetMs).toBeCloseTo(30, 1);
    expect(result.usable).toBe(true);
    expect(result.spreadMs).toBeLessThan(1);
  });

  it("recovers a NEGATIVE offset (hits landing before the click)", () => {
    const clicks = clickSchedule(100, 12);
    const result = summarize(matchTapsToClicks(taps(-15, 12), clicks));
    expect(result.offsetMs).toBeCloseTo(-15, 1);
  });

  it("discards the settling taps", () => {
    // First two taps are wild; the rest are clean. The result should ignore them.
    const clicks = clickSchedule(100, 12);
    const tapTimes = taps(25, 12);
    tapTimes[0] += 0.2;
    tapTimes[1] += 0.15;
    const result = summarize(matchTapsToClicks(tapTimes, clicks));
    expect(result.offsetMs).toBeCloseTo(25, 1);
    expect(result.sampleCount).toBe(12 - SETTLING_TAPS);
  });

  it("survives one flubbed tap in the middle", () => {
    const clicks = clickSchedule(100, 14);
    const tapTimes = taps(20, 14);
    tapTimes[7] += 0.2; // a bad hit, still inside the match window
    const result = summarize(matchTapsToClicks(tapTimes, clicks));
    expect(result.offsetMs).toBeCloseTo(20, 0);
    expect(result.usable).toBe(true);
  });

  it("refuses scattered taps instead of inventing an offset", () => {
    const clicks = clickSchedule(100, 12);
    const result = summarize(matchTapsToClicks(taps(30, 12, 90), clicks));
    expect(result.usable).toBe(false);
    expect(result.verdict).toMatch(/inconsistent/i);
  });

  it("refuses too few taps", () => {
    const clicks = clickSchedule(100, 8);
    const result = summarize(matchTapsToClicks([0, 0.6, 1.2], clicks));
    expect(result.usable).toBe(false);
    expect(result.sampleCount).toBeLessThan(4);
  });

  it("flags a usable but sloppy run rather than pretending it's tight", () => {
    // ±25ms jitter → robust spread ~37ms: past the "tight" line (20) but inside
    // the usable one (50). At ±35 the spread computes to ~52 and is correctly
    // REFUSED — the band between sloppy and unusable is narrower than it looks.
    const clicks = clickSchedule(100, 14);
    const result = summarize(matchTapsToClicks(taps(30, 14, 25), clicks));
    expect(result.usable).toBe(true);
    expect(result.spreadMs).toBeGreaterThan(20);
    expect(result.verdict).toMatch(/varied/i);
  });
});

/**
 * Judging and scoring math.
 *
 * These formulas are TUNED VALUES carried over from the spec, not incidental
 * code (CLAUDE.md → Conventions). They're pinned here so a future "simplify"
 * has to argue with a failing test rather than silently rescoring every song.
 *
 * This is the other half of what assertions can actually establish in this
 * project. What they CANNOT establish is whether a Perfect *feels* like a
 * Perfect — that needs a kit and ears.
 */

import { describe, expect, it } from "vitest";

import type { HitWindows, JudgmentBreakdown } from "../src/shared/types.js";
import {
  finalAccuracy,
  judgeTiming,
  runningAccuracy,
  scoreForHit,
} from "../src/renderer/views/gameplay-view.js";

const WINDOWS: HitWindows = { perfectMs: 25, goodMs: 50, edgeMs: 100 };

function breakdown(b: Partial<JudgmentBreakdown>): JudgmentBreakdown {
  return { perfect: 0, good: 0, early: 0, late: 0, miss: 0, ...b };
}

describe("judgeTiming", () => {
  it("buckets by absolute error", () => {
    expect(judgeTiming(0, WINDOWS)).toBe("perfect");
    expect(judgeTiming(20, WINDOWS)).toBe("perfect");
    expect(judgeTiming(-20, WINDOWS)).toBe("perfect");
    // 40ms is inside goodMs (50), so it's Good — NOT late. Getting this wrong
    // is easy: the windows nest, and "late" only starts beyond the good window.
    expect(judgeTiming(40, WINDOWS)).toBe("good");
    expect(judgeTiming(-40, WINDOWS)).toBe("good");
    expect(judgeTiming(75, WINDOWS)).toBe("late");
    expect(judgeTiming(-75, WINDOWS)).toBe("early");
  });

  it("uses sign only OUTSIDE the good window", () => {
    // Perfect and Good are symmetric — early/late is a coarser verdict that
    // only appears once you're far enough out for the direction to matter.
    expect(judgeTiming(-30, WINDOWS)).toBe("good");
    expect(judgeTiming(30, WINDOWS)).toBe("good");
    expect(judgeTiming(-60, WINDOWS)).toBe("early");
    expect(judgeTiming(60, WINDOWS)).toBe("late");
  });

  it("treats window edges as INCLUSIVE", () => {
    expect(judgeTiming(25, WINDOWS)).toBe("perfect");
    expect(judgeTiming(25.001, WINDOWS)).toBe("good");
    expect(judgeTiming(50, WINDOWS)).toBe("good");
    expect(judgeTiming(50.001, WINDOWS)).toBe("late");
    expect(judgeTiming(100, WINDOWS)).toBe("late");
  });

  it("returns null beyond the edge window — a stray hit, not a miss", () => {
    // The distinction matters: a stray must not break combo or count against
    // accuracy. Only a note the player never hit becomes a miss.
    expect(judgeTiming(100.001, WINDOWS)).toBeNull();
    expect(judgeTiming(-500, WINDOWS)).toBeNull();
  });

  it("honours custom windows", () => {
    const tight: HitWindows = { perfectMs: 5, goodMs: 10, edgeMs: 20 };
    expect(judgeTiming(6, tight)).toBe("good");
    expect(judgeTiming(4, tight)).toBe("perfect");
    expect(judgeTiming(25, tight)).toBeNull();
  });
});

describe("scoreForHit", () => {
  it("applies base × (1 + combo/25)", () => {
    expect(scoreForHit("perfect", 0)).toBe(100);
    expect(scoreForHit("good", 0)).toBe(60);
    expect(scoreForHit("early", 0)).toBe(30);
    expect(scoreForHit("late", 0)).toBe(30);
  });

  it("multiplies by combo — 25 in a row doubles a hit", () => {
    expect(scoreForHit("perfect", 25)).toBe(200);
    expect(scoreForHit("perfect", 50)).toBe(300);
    expect(scoreForHit("good", 25)).toBe(120);
  });

  it("rounds to a whole number", () => {
    // 100 * (1 + 1/25) = 104 exactly; 60 * 1.04 = 62.4 -> 62
    expect(scoreForHit("perfect", 1)).toBe(104);
    expect(scoreForHit("good", 1)).toBe(62);
  });

  it("scores a miss at zero regardless of combo", () => {
    expect(scoreForHit("miss", 0)).toBe(0);
    expect(scoreForHit("miss", 100)).toBe(0);
  });
});

describe("finalAccuracy — the SAVED number", () => {
  it("weights perfect 1, good 0.6, early/late 0.3", () => {
    expect(finalAccuracy(breakdown({ perfect: 10 }), 10)).toBe(100);
    expect(finalAccuracy(breakdown({ good: 10 }), 10)).toBeCloseTo(60, 6);
    expect(finalAccuracy(breakdown({ early: 5, late: 5 }), 10)).toBeCloseTo(30, 6);
    expect(finalAccuracy(breakdown({ miss: 10 }), 10)).toBe(0);
  });

  it("divides by EVERY note, so unplayed notes cost accuracy", () => {
    // 10 perfect out of a 100-note song is 10%, even though every hit landed.
    expect(finalAccuracy(breakdown({ perfect: 10 }), 100)).toBeCloseTo(10, 6);
  });

  it("mixes weights correctly", () => {
    // (4*1 + 2*0.6 + (1+1)*0.3) / 10 * 100 = 58
    expect(finalAccuracy(breakdown({ perfect: 4, good: 2, early: 1, late: 1, miss: 2 }), 10)).toBeCloseTo(
      58,
      6,
    );
  });

  it("returns 0 for a chart with no mapped notes rather than dividing by zero", () => {
    expect(finalAccuracy(breakdown({}), 0)).toBe(0);
  });
});

describe("runningAccuracy — the HUD number", () => {
  it("divides by RESOLVED notes, not the whole song", () => {
    // The distinction that stops the HUD reading 0.3% after a perfect first hit.
    expect(runningAccuracy(breakdown({ perfect: 1 }))).toBe(100);
    expect(finalAccuracy(breakdown({ perfect: 1 }), 316)).toBeLessThan(1);
  });

  it("starts at 100 before anything is resolved", () => {
    expect(runningAccuracy(breakdown({}))).toBe(100);
  });

  it("counts misses against you", () => {
    expect(runningAccuracy(breakdown({ perfect: 1, miss: 1 }))).toBeCloseTo(50, 6);
  });

  it("agrees with finalAccuracy once every note is resolved", () => {
    // The two must converge at the end of a song, or the HUD was lying.
    const b = breakdown({ perfect: 4, good: 2, early: 1, late: 1, miss: 2 });
    expect(runningAccuracy(b)).toBeCloseTo(finalAccuracy(b, 10), 6);
  });
});

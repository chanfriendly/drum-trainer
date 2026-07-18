#!/usr/bin/env python3
"""Drum transcription evaluation harness.

WHAT THIS IS FOR
The app charts from MIDI and never from audio — that is a hard rule, because a
chart inferred from audio makes every score meaningless. This harness exists to
answer a different question: *how good would audio transcription have to get
before it could be trusted?* It measures a candidate transcription against a
reference chart and reports precision/recall/F1, a confusion matrix, and a
timing-error histogram.

THE HARNESS IS THE DURABLE PART. The bundled transcriber is a deliberate FLOOR
(spectral flux onsets + band-energy classification, ~200 lines, no downloads).
A real ADT model swaps in behind the same `--candidate` interface later; the
question this answers is "by how much does it need to beat the floor?".

WHAT CAN AND CANNOT BE EVALUATED HERE
  Practice Groove is the ONLY clean evaluation: alignment is known exactly
  (offset 0, scale 1), so a miss is a transcription failure and nothing else.
  It is also an OPTIMISTIC UPPER BOUND — synthetic, isolated drums, no bass or
  vocals masking anything. A transcriber that can't do well here has no chance
  on a record.

  A real recording (e.g. the Queen pair) CANNOT be cleanly evaluated: its true
  alignment is unknown (auto-align is ambiguous by whole bars), so a low F1
  could mean bad transcription OR bad alignment, and the two are not separable
  from the number. Run it, but read it as qualitative — this script labels it
  CONFOUNDED in the output rather than letting a tidy-looking F1 imply more than
  it means.

TOLERANCES
Reported at ±25ms (the app's Perfect window) and ±50ms (the research standard).
That gap is the crux: a transcriber can look respectable at the standard
tolerance and still be unable to place a note well enough to judge a drummer.

Usage:
  python3 scripts/eval/transcribe_eval.py --audio <file> --reference <notes.json>
                                          [--candidate <notes.json>]
                                          [--offset-ms N] [--tempo-scale N]
                                          [--confounded] [--plot out.png]
"""

import argparse
import json
import subprocess
import sys
from collections import Counter

import numpy as np
from scipy.optimize import linear_sum_assignment

SR = 44100
N_FFT = 2048
HOP = 256  # 5.8ms — finer than the 25ms Perfect window, so framing isn't the limit

# Frames of lead between a true onset and its flux peak.
#
# Same trap as FRAME_LEAD in src/renderer/lib/alignment.ts, and it caught this
# script too: STFT frame `p` spans samples [p*HOP, p*HOP+N_FFT), so it is
# CENTERED half a window later than it starts, and flux compares frame p to p-1.
# Reported onsets therefore lead the truth by 1 + N_FFT/(2*HOP) frames — ~29ms
# here, which is larger than the entire ±25ms Perfect window.
#
# The first run of this harness measured the bias directly: mean -31.7ms with a
# stdev of just 4.8ms. A constant that tight is never transcription error; it is
# always framing. Uncorrected it made the baseline look near-useless at ±25ms
# (0.8% F1) while scoring 51.6% at ±50ms — the entire gap was this bug, not the
# method.
#
# The peak LAGS in frame index, so the true time is LATER: add the lead, don't
# subtract it (matches timeOfFrame() in alignment.ts). Subtracting doubles the
# error to ~-60ms and drops F1 to nearly zero, which is how the sign got caught.
FRAME_LEAD = 1 + N_FFT // (2 * HOP)

# The six lanes the app charts. Mirrors renderer/lib/drums.ts.
LANES = ["kick", "snare", "hihat", "tom", "crash", "ride"]

# General MIDI → lane. Mirrors DEFAULT_MIDI_MAPPING; notes absent here are
# ignored by the app and so are excluded from evaluation too.
GM_TO_LANE = {
    35: "kick", 36: "kick",
    37: "snare", 38: "snare", 40: "snare",
    22: "hihat", 26: "hihat", 42: "hihat", 44: "hihat", 46: "hihat",
    41: "tom", 43: "tom", 45: "tom", 47: "tom", 48: "tom", 50: "tom", 58: "tom",
    49: "crash", 52: "crash", 55: "crash", 57: "crash",
    51: "ride", 53: "ride", 59: "ride",
}


# ── audio ────────────────────────────────────────────────────────────
def load_audio(path):
    """Decode to mono float32 at SR via ffmpeg (test-only dependency)."""
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        sys.exit(f"ffmpeg failed on {path}:\n{proc.stderr.decode()[:400]}")
    return np.frombuffer(proc.stdout, dtype=np.float32)


def stft_mag(audio):
    frames = 1 + (len(audio) - N_FFT) // HOP
    window = np.hanning(N_FFT).astype(np.float32)
    strided = np.lib.stride_tricks.as_strided(
        audio, shape=(frames, N_FFT), strides=(audio.strides[0] * HOP, audio.strides[0])
    )
    return np.abs(np.fft.rfft(strided * window, axis=1)), SR / HOP


# ── baseline transcriber (the FLOOR) ─────────────────────────────────
def band(mag, lo_hz, hi_hz):
    freqs = np.fft.rfftfreq(N_FFT, 1 / SR)
    sel = (freqs >= lo_hz) & (freqs < hi_hz)
    return mag[:, sel].sum(axis=1)


def transcribe_baseline(audio):
    """Spectral flux onsets + band-energy classification.

    MULTI-LABEL by design: a kick and a hi-hat struck together are one onset but
    two notes. A single-label classifier would cap recall near 50% on any real
    groove, which would make the floor look worse than the method actually is —
    an artefact of the harness, not a finding.
    """
    mag, fps = stft_mag(audio)
    log = np.log1p(mag)

    flux = np.maximum(np.diff(log, axis=0), 0).sum(axis=1)
    flux = np.concatenate([[0], flux])

    # Adaptive threshold: a moving median tracks loud and quiet passages, where
    # a global threshold would over-detect in choruses and miss the intro.
    win = int(0.15 * fps)
    padded = np.pad(flux, win, mode="edge")
    local = np.array([np.median(padded[i : i + 2 * win]) for i in range(len(flux))])
    thresh = local + 0.6 * np.std(flux)

    peaks = []
    for i in range(1, len(flux) - 1):
        if flux[i] > thresh[i] and flux[i] >= flux[i - 1] and flux[i] > flux[i + 1]:
            # ~30ms refractory: one strike is one note, not three frames of one.
            if not peaks or (i - peaks[-1]) > 0.03 * fps:
                peaks.append(i)
    peaks = np.array(peaks, dtype=int)
    if len(peaks) == 0:
        return []

    e_low = band(mag, 20, 120)
    e_lowmid = band(mag, 120, 400)
    e_mid = band(mag, 400, 2000)
    e_high = band(mag, 2000, 8000)
    e_vhigh = band(mag, 8000, 16000)
    total = e_low + e_lowmid + e_mid + e_high + e_vhigh + 1e-9

    notes = []
    for p in peaks:
        t = (p + FRAME_LEAD) / fps
        lo, lm, md, hi, vh = (x[p] / total[p] for x in (e_low, e_lowmid, e_mid, e_high, e_vhigh))

        # Decay over ~250ms separates a crash (rings) from a closed hat (clicks).
        tail = min(p + int(0.25 * fps), len(e_vhigh) - 1)
        sustain = (e_high[tail] + e_vhigh[tail]) / (e_high[p] + e_vhigh[p] + 1e-9)

        if lo > 0.30:
            notes.append((t, "kick"))
        if lm > 0.18 and md > 0.10 and hi > 0.05:
            notes.append((t, "snare"))
        elif lm > 0.25 and hi < 0.05:
            notes.append((t, "tom"))
        if vh + hi > 0.35:
            if sustain > 0.45:
                notes.append((t, "crash"))
            elif sustain > 0.20:
                notes.append((t, "ride"))
            else:
                notes.append((t, "hihat"))

    return sorted(notes)


# ── evaluation ───────────────────────────────────────────────────────
def match_within(ref_times, cand_times, tol):
    """Bipartite match minimising total |Δt|, never pairing beyond `tol`.

    Greedy nearest-neighbour double-counts when notes cluster (a fill), which
    flatters or punishes arbitrarily. Hungarian is exact and these sets are
    small.
    """
    if len(ref_times) == 0 or len(cand_times) == 0:
        return []
    cost = np.abs(np.subtract.outer(ref_times, cand_times))
    big = tol * 1000 + 1
    cost_capped = np.where(cost <= tol, cost, big)
    ri, ci = linear_sum_assignment(cost_capped)
    return [(r, c) for r, c in zip(ri, ci) if cost[r, c] <= tol]


def evaluate(reference, candidate, tol):
    """Per-lane P/R/F1 (matched within lane) + a time-only confusion matrix."""
    report = {}
    for lane in LANES:
        ref = np.array([t for t, d in reference if d == lane])
        cand = np.array([t for t, d in candidate if d == lane])
        pairs = match_within(ref, cand, tol)
        tp = len(pairs)
        fn = len(ref) - tp
        fp = len(cand) - tp
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        errors = [cand[c] - ref[r] for r, c in pairs]
        report[lane] = dict(
            n_ref=len(ref), n_cand=len(cand), tp=tp, fp=fp, fn=fn,
            precision=precision, recall=recall, f1=f1, errors=errors,
        )

    # Confusion: match on TIME ALONE, then compare labels. This is where
    # crash/ride/open-hat confusion becomes visible — per-lane F1 hides it,
    # because a crash called a ride is just an FN in one lane and an FP in
    # another, with no hint the two are related.
    ref_t = np.array([t for t, _ in reference])
    cand_t = np.array([t for t, _ in candidate])
    confusion = Counter()
    for r, c in match_within(ref_t, cand_t, tol):
        confusion[(reference[r][1], candidate[c][1])] += 1
    return report, confusion


def onset_envelope(audio):
    """Standardized spectral-flux envelope, for alignment search."""
    mag, fps = stft_mag(audio)
    flux = np.maximum(np.diff(np.log1p(mag), axis=0), 0).sum(axis=1)
    flux = np.concatenate([[0], flux])
    flux = (flux - flux.mean()) / (flux.std() + 1e-9)
    return flux, fps


def auto_align(reference, audio, beat_notes=(35, 36, 38, 40)):
    """Find (offset, tempo_scale) mapping reference chart time onto this audio.

    Mirrors the app's estimator: mean envelope strength where notes land, coarse
    2D sweep then a fine refine. Reported score is in stdevs — near 0 means the
    chart landed on noise (no lock), >1 is a confident lock.

    Aligning against an ISOLATED DRUM STEM should score far higher than against a
    full mix, because nothing but drums produces the onsets.
    """
    flux, fps = onset_envelope(audio)
    beat = np.array([t for t, d in reference if d in ("kick", "snare")])
    times = beat if len(beat) >= 20 else np.array([t for t, _ in reference])
    if len(times) == 0:
        return 0.0, 1.0, 0.0

    def score_at(scale, off):
        idx = ((times * scale + off) * fps).astype(int) - FRAME_LEAD
        idx = idx[(idx >= 0) & (idx < len(flux))]
        if len(idx) < len(times) * 0.5:
            return -np.inf
        return flux[idx].mean()

    best = (-np.inf, 0.0, 1.0)
    for scale in np.arange(0.96, 1.041, 0.002):
        for off in np.arange(-8.0, 20.0, 4.0 / fps):
            v = score_at(scale, off)
            if v > best[0]:
                best = (v, off, scale)
    _, off0, sc0 = best
    for scale in np.arange(sc0 - 0.002, sc0 + 0.0021, 0.0004):
        for off in np.arange(off0 - 4.0 / fps, off0 + 4.0 / fps, 1.0 / (fps * 4)):
            v = score_at(scale, off)
            if v > best[0]:
                best = (v, off, scale)
    return best[1], best[2], best[0]


def load_notes(path):
    with open(path) as f:
        payload = json.load(f)
    if isinstance(payload, dict) and "notes" in payload:
        out = []
        for n in payload["notes"]:
            lane = GM_TO_LANE.get(n["midi"])
            if lane:  # unmapped notes are ignored by the app; ignore them here too
                out.append((n["time"], lane))
        return sorted(out), payload
    return sorted((n["time"], n["drum"]) for n in payload), {}


def fmt_pct(x):
    return f"{x * 100:5.1f}%"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--reference", required=True, help="notes.json from dump-notes.mjs")
    ap.add_argument("--candidate", help="notes.json; omit to use the baseline transcriber")
    ap.add_argument("--offset-ms", type=float, default=0.0)
    ap.add_argument("--tempo-scale", type=float, default=1.0)
    ap.add_argument("--auto-align", action="store_true",
                    help="find offset/tempo-scale against this audio instead of trusting a stored value")
    ap.add_argument("--confounded", action="store_true",
                    help="mark output as unreliable: alignment is not known exactly")
    ap.add_argument("--plot", help="write a timing-error histogram PNG")
    args = ap.parse_args()

    reference, meta = load_notes(args.reference)
    # Reference is in CHART time; the audio is in RECORDING time. Same mapping
    # gameplay uses: audio = chart * tempoScale + offset.
    reference = [
        (t * args.tempo_scale + args.offset_ms / 1000, d) for t, d in reference
    ]

    audio = load_audio(args.audio)
    print(f"audio      {len(audio) / SR:7.2f}s   {args.audio.split('/')[-1]}")

    if args.auto_align:
        off, sc, lock = auto_align(reference, audio)
        args.offset_ms, args.tempo_scale = off * 1000, sc
        # The earlier transform ran with the defaults (scale 1, offset 0), i.e.
        # identity, so applying the discovered mapping here is correct.
        reference = [(t * sc + off, d) for t, d in reference]
        print(f"auto-align offset {off:+.3f}s  scale {sc:.5f}  lock {lock:.2f} "
              f"({'confident' if lock > 1 else 'WEAK — read results with suspicion'})")
    print(f"reference  {len(reference):5d} notes  (mapped to lanes)")
    if args.offset_ms or args.tempo_scale != 1.0:
        print(f"alignment  offset {args.offset_ms:+.1f}ms  scale {args.tempo_scale:.5f}")

    if args.candidate:
        candidate, _ = load_notes(args.candidate)
        source = args.candidate
    else:
        candidate = transcribe_baseline(audio)
        source = "baseline (spectral flux + band energy)"
    print(f"candidate  {len(candidate):5d} notes  from {source}")

    if args.confounded:
        print()
        print("  ⚠️  CONFOUNDED — this pair's true alignment is unknown, so a low")
        print("      score may be misalignment rather than mis-transcription.")
        print("      Read qualitatively. Only Practice Groove is a clean evaluation.")

    for tol in (0.025, 0.050):
        report, confusion = evaluate(reference, candidate, tol)
        label = "PERFECT window" if tol == 0.025 else "research standard"
        print(f"\n── ±{int(tol * 1000)}ms  ({label}) " + "─" * 34)
        print(f"  {'lane':<7} {'ref':>5} {'cand':>5} {'TP':>4} {'FP':>4} {'FN':>4} "
              f"{'prec':>6} {'recall':>6} {'F1':>6}")
        tot_tp = tot_fp = tot_fn = 0
        for lane in LANES:
            r = report[lane]
            tot_tp += r["tp"]; tot_fp += r["fp"]; tot_fn += r["fn"]
            print(f"  {lane:<7} {r['n_ref']:5d} {r['n_cand']:5d} {r['tp']:4d} {r['fp']:4d} "
                  f"{r['fn']:4d} {fmt_pct(r['precision'])} {fmt_pct(r['recall'])} "
                  f"{fmt_pct(r['f1'])}")
        p = tot_tp / (tot_tp + tot_fp) if tot_tp + tot_fp else 0
        rc = tot_tp / (tot_tp + tot_fn) if tot_tp + tot_fn else 0
        f1 = 2 * p * rc / (p + rc) if p + rc else 0
        print(f"  {'TOTAL':<7} {'':5} {'':5} {tot_tp:4d} {tot_fp:4d} {tot_fn:4d} "
              f"{fmt_pct(p)} {fmt_pct(rc)} {fmt_pct(f1)}")

        if tol == 0.050:
            print("\n  confusion (reference → transcribed, matched on time alone):")
            rows = [k for k in LANES if any(k == a for a, _ in confusion)]
            if not rows:
                print("    (nothing matched)")
            for a in rows:
                cells = [f"{b}×{n}" for (x, b), n in sorted(confusion.items()) if x == a]
                print(f"    {a:<7} → {', '.join(cells)}")

            errs = np.array([e for lane in LANES for e in report[lane]["errors"]])
            if len(errs):
                print(f"\n  timing error over {len(errs)} matches: "
                      f"mean {errs.mean() * 1000:+.1f}ms  "
                      f"median {np.median(errs) * 1000:+.1f}ms  "
                      f"stdev {errs.std() * 1000:.1f}ms")
                within25 = (np.abs(errs) <= 0.025).mean()
                print(f"  {fmt_pct(within25)} of matches land inside the ±25ms Perfect window")
                if args.plot:
                    import matplotlib
                    matplotlib.use("Agg")
                    import matplotlib.pyplot as plt
                    plt.figure(figsize=(7, 3.5))
                    plt.hist(errs * 1000, bins=60, color="#06b6d4")
                    for x, c in ((25, "#facc15"), (-25, "#facc15"), (50, "#ef4444"), (-50, "#ef4444")):
                        plt.axvline(x, color=c, ls="--", lw=1)
                    plt.xlabel("transcribed − reference (ms)")
                    plt.ylabel("matches")
                    plt.title("Timing error (dashed: ±25ms Perfect, ±50ms standard)")
                    plt.tight_layout()
                    plt.savefig(args.plot, dpi=120)
                    print(f"  wrote {args.plot}")


if __name__ == "__main__":
    main()

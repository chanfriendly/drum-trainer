#!/usr/bin/env python3
"""One call: a song's audio in, a drum chart `.mid` out.

This is what the app shells out to. `adtof_transcribe.py` is the model wrapper;
this is the PIPELINE around it, encoding the three things measurement taught us
(numbers in scripts/eval/README.md):

  1. Transcribe the FULL MIX, not a stem. Separation strips quiet hi-hats
     before the model sees them: 66.4% -> 70.3% F1, hi-hat recall 34% -> 52%.
  2. But GATE with a stem. A full mix hallucinates drums in intros, because
     bass and vocals sit in the kick band — one song charted its first note
     19s before the drums entered.
  3. Raise the cymbal threshold. The default is tuned for stems; on a mix
     guitars read as crashes. crash=0.55 doubles cymbal precision.

So a stem is wanted for gating even though transcription uses the mix. Sources,
in order of preference:
  --stem PATH   one you already have (Logic's Stem Splitter, Fadr, anything)
  demucs        run automatically if installed — same family as Logic's
                splitter, and scriptable, which Logic is not
  neither       still works; you get an ungated chart and a warning

Emits a JSON summary on stdout so the caller can report precisely what it did.

Usage:
  python3 chart_from_audio.py SONG.flac OUTDIR [--stem DRUMS.wav] [--no-separate]
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CRASH_THRESHOLD = "0.55"


def log(stage, message):
    """Progress on stderr — stdout is reserved for the JSON result."""
    print(f"[{stage}] {message}", file=sys.stderr, flush=True)


def have_demucs():
    try:
        import demucs  # noqa: F401

        return True
    except ImportError:
        return False


def separate(audio, workdir):
    """Isolate the drum stem with demucs. Returns a path, or None on failure.

    Separation is an OPTIONAL improvement here, never a hard requirement — a
    missing or broken demucs must degrade to an ungated chart, not kill the run
    and leave the user with nothing.
    """
    log("separate", "isolating drums with demucs (first run downloads ~300MB)")
    try:
        subprocess.run(
            [sys.executable, "-m", "demucs", "--two-stems", "drums",
             "-o", workdir, "-n", "htdemucs", audio],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        log("separate", f"failed ({e}); continuing without a stem")
        return None

    for root, _dirs, files in os.walk(workdir):
        for f in files:
            if f.startswith("drums."):
                return os.path.join(root, f)
    log("separate", "demucs produced no drums stem; continuing without one")
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", help="the song's full-mix audio")
    ap.add_argument("outdir", help="where to write the .mid")
    ap.add_argument("--stem", help="an isolated drum stem you already have")
    ap.add_argument("--no-separate", action="store_true", help="skip demucs entirely")
    args = ap.parse_args()

    if not os.path.isfile(args.audio):
        sys.exit(f"no such audio file: {args.audio}")
    os.makedirs(args.outdir, exist_ok=True)

    workdir = tempfile.mkdtemp(prefix="chart-")
    warnings = []
    try:
        stem = args.stem
        if stem and not os.path.isfile(stem):
            sys.exit(f"no such stem file: {stem}")
        if not stem and not args.no_separate:
            if have_demucs():
                stem = separate(args.audio, workdir)
            else:
                log("separate", "demucs not installed; skipping separation")
        if not stem:
            warnings.append(
                "No drum stem, so the chart is ungated: expect phantom notes in "
                "intros and quiet sections, where bass and vocals read as drums."
            )

        log("transcribe", "running the drum model on the full mix")
        cmd = [
            sys.executable,
            os.path.join(HERE, "adtof_transcribe.py"),
            args.audio,
            args.outdir,
            "--threshold",
            f"crash={CRASH_THRESHOLD}",
        ]
        if stem:
            cmd += ["--gate-with", stem]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            sys.exit(f"transcription failed:\n{proc.stderr[-1500:]}")

        base = os.path.basename(args.audio)
        midi = os.path.join(args.outdir, base + ".mid")
        if not os.path.isfile(midi):
            sys.exit(f"transcription produced no .mid for {base}")

        # Keep the stem next to the chart: the app attaches it as Sync's
        # analysis audio, where it locks 4.7x better than the full mix.
        stem_out = None
        if stem:
            stem_out = os.path.join(args.outdir, "drums" + os.path.splitext(stem)[1])
            shutil.copy(stem, stem_out)

        with open(os.path.join(args.outdir, base + ".candidate.json")) as f:
            notes = json.load(f)

        log("done", f"{len(notes)} notes")
        json.dump(
            {
                "midiPath": midi,
                "stemPath": stem_out,
                "noteCount": len(notes),
                "gated": bool(stem),
                "warnings": warnings,
            },
            sys.stdout,
        )
        print()
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()

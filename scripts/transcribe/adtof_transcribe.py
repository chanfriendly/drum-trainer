#!/usr/bin/env python3
"""Transcribe drum audio to notes with the pretrained ADTOF model.

WHY THIS MODEL FIRST: ADTOF (Zehren et al.) is a CRNN trained on crowdsourced
rhythm-game drum charts — the exact artifact this app consumes. Its output
vocabulary is the ADTOF-5 rhythm-game reduction: kick(35), snare(38), tom(47),
hihat(42), cymbal+ride(49). It ships pretrained weights inside the pip package,
so this needs no downloads beyond `pip install git+https://github.com/MZehren/ADTOF`.

This is an OFFLINE tool. It emits a .mid the app imports normally; the app's
"MIDI only, never infer from audio" rule is not relaxed. It also emits the
harness candidate JSON so every transcription is measurable:

  .venv-adt/bin/python scripts/transcribe/adtof_transcribe.py <audio> <outdir>
  python3 scripts/eval/transcribe_eval.py --audio <audio> --reference ref.json \
      --candidate <outdir>/<name>.candidate.json

The model has ONE cymbal class. Charts it produces put every cymbal on note 49
(crash); expect reference rides to score as ride→crash confusion in the
harness. That is a vocabulary limit, not a timing error.
"""

import argparse
import glob
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile

# ADTOF's model was saved with Keras 2; under Keras 3 it fails to build
# (`keras.optimizers.legacy` is gone). Must be set before tensorflow imports.
os.environ.setdefault("TF_USE_LEGACY_KERAS", "True")

# ADTOF's number for each of its five classes → the harness lane name.
ADTOF_TO_LANE = {35: "kick", 38: "snare", 47: "tom", 42: "hihat", 49: "crash"}


LANE_TO_GM = {lane: note for note, lane in ADTOF_TO_LANE.items()}


def write_midi(notes, path):
    """Rewrite the .mid after gating — predictFolder's copy is the ungated one.

    `is_drum=True` puts it on GM channel 10, which is what the app's parseChart
    looks for; a chart written to any other channel imports as an empty song.
    """
    import pretty_midi

    pm = pretty_midi.PrettyMIDI()
    inst = pretty_midi.Instrument(program=0, is_drum=True, name="drums")
    for n in notes:
        inst.notes.append(
            pretty_midi.Note(
                velocity=100, pitch=LANE_TO_GM[n["drum"]], start=n["time"], end=n["time"] + 0.05
            )
        )
    pm.instruments.append(inst)
    pm.write(path)


def load_mono(path, sr=22050):
    """Decode to mono float32 via ffmpeg. Only used for --gate-with."""
    import numpy as np

    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        sys.exit(f"ffmpeg failed on {path}:\n{proc.stderr.decode()[:300]}")
    return np.frombuffer(proc.stdout, dtype=np.float32), sr


def silent_mask(stem_path, hop_sec=0.1):
    """Per-`hop_sec` mask of where the drum stem carries no drum at all.

    Threshold is relative to the stem's OWN loud passages (2% of its 90th
    percentile RMS), so it travels across songs and masterings instead of
    encoding one track's level.
    """
    import numpy as np

    audio, sr = load_mono(stem_path)
    hop = int(hop_sec * sr)
    if hop <= 0 or len(audio) < hop:
        return np.zeros(0, dtype=bool), hop_sec
    rms = np.array(
        [np.sqrt((audio[i : i + hop] ** 2).mean()) for i in range(0, len(audio) - hop, hop)]
    )
    return rms < 0.02 * np.percentile(rms, 90), hop_sec


def main():
    ap = argparse.ArgumentParser(
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description=__doc__,
    )
    ap.add_argument("audio", help="audio file (or folder of audio files) — prefer the FULL MIX")
    ap.add_argument("outdir", help="output folder for .mid / .txt / .candidate.json")
    ap.add_argument(
        "--gate-with",
        metavar="STEM",
        help="drum stem for the same recording. Notes landing where the stem is "
        "silent are dropped: transcribing the full mix hallucinates drums in "
        "intros and breakdowns, because bass and vocals sit in the kick band.",
    )
    ap.add_argument(
        "--threshold",
        action="append",
        default=[],
        metavar="CLASS=VALUE",
        help="override a class's peak-picking threshold, e.g. --threshold crash=0.45. "
        "Higher = fewer, more confident notes. Classes: kick snare tom hihat crash.",
    )
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO)
    from adtof.model.model import Model

    model, hparams = Model.modelFactory(modelName="Frame_RNN", scenario="adtofAll", fold=0)
    if not model.weightLoadedFlag:
        sys.exit("pretrained weights failed to load — expected Frame_RNN_adtofAll_0 in adtof/models/")

    # Per-class peak-picking thresholds, in the model's own label order. Raising
    # one trades recall for precision in that lane only — the cymbal class is the
    # one worth touching, because a full mix puts guitar and vocal energy exactly
    # where crashes live.
    lane_index = {lane: i for i, lane in enumerate(ADTOF_TO_LANE[n] for n in hparams["labels"])}
    thresholds = list(hparams["peakThreshold"])
    for override in args.threshold:
        lane, _, value = override.partition("=")
        if lane not in lane_index:
            sys.exit(f"unknown class {lane!r}; expected one of {', '.join(lane_index)}")
        thresholds[lane_index[lane]] = float(value)
        print(f"threshold {lane}: {hparams['peakThreshold'][lane_index[lane]]:.2f} -> {value}")
    hparams["peakThreshold"] = thresholds

    os.makedirs(args.outdir, exist_ok=True)

    # ADTOF discovers input files with glob, so a path containing glob
    # metacharacters (Fadr downloads: "[fadr.com] Stems - …") silently matches
    # NOTHING and predictFolder writes no output. Stage such files to a clean
    # temp path instead of failing quietly.
    audio, staging = args.audio, None
    if glob.escape(audio) != audio:
        staging = tempfile.mkdtemp(prefix="adtof-")

        def clean(name):  # the FILENAME can hold glob characters too
            return "".join("_" if c in "[]*?" else c for c in name)

        if os.path.isdir(audio):
            for name in os.listdir(audio):
                shutil.copy(os.path.join(audio, name), os.path.join(staging, clean(name)))
            audio = staging
        else:
            audio = os.path.join(staging, clean(os.path.basename(audio)))
            shutil.copy(args.audio, audio)
        print(f"input path contains glob characters; staged to {staging}")

    # One file at a time, even for a folder. predictFolder's own directory
    # handling passes the DIRECTORY to the decoder and dies with
    # "IsADirectoryError", so a folder argument fails after the model has
    # already loaded — the slowest possible way to find out.
    if os.path.isdir(audio):
        targets = sorted(
            os.path.join(audio, n) for n in os.listdir(audio) if not n.startswith(".")
        )
    else:
        targets = [audio]

    try:
        for i, target in enumerate(targets, 1):
            if len(targets) > 1:
                print(f"[{i}/{len(targets)}] {os.path.basename(target)}")
            model.predictFolder(target, args.outdir, writeMidi=True, **hparams)
    finally:
        if staging:
            shutil.rmtree(staging, ignore_errors=True)

    silent, hop_sec = (silent_mask(args.gate_with) if args.gate_with else (None, 0.1))

    # predictFolder writes "<title>.txt" lines of "<time>\t<adtof-pitch>";
    # convert each to the harness candidate format.
    for name in os.listdir(args.outdir):
        if not name.endswith(".txt"):
            continue
        notes = []
        with open(os.path.join(args.outdir, name)) as f:
            for line in f:
                t, pitch = line.split()
                notes.append({"time": float(t), "drum": ADTOF_TO_LANE[int(float(pitch))]})

        dropped = 0
        if silent is not None and len(silent):

            def silent_around(t):
                """Is the stem silent ACROSS a hit's whole decay, not just at its
                onset?

                Checking only the window containing the onset deletes real notes:
                a 100ms RMS window averages a transient down, and a hit landing
                late in its window barely registers. Measured on the sparse
                practice-groove chart, the naive version gated out 200 of 262
                notes — the gaps between isolated hits read as silence. A dense
                song hides this completely, because neighbouring hits keep every
                window loud.
                """
                lo = max(0, int((t - 0.05) / hop_sec))
                hi = min(len(silent) - 1, int((t + 0.15) / hop_sec))
                return lo <= hi and bool(silent[lo : hi + 1].all())

            kept = [n for n in notes if not silent_around(n["time"])]
            dropped = len(notes) - len(kept)

            # A stem that disagrees with the mix this violently is not a stem of
            # this recording — wrong file, failed separation, or an instrumental.
            # Gating on it would silently delete most of the chart, which is far
            # worse than the phantom notes gating exists to remove.
            if dropped > 0.4 * len(notes):
                print(
                    f"WARNING: gating would drop {dropped}/{len(notes)} notes; the stem "
                    "does not match this audio. Keeping the ungated chart.",
                    file=sys.stderr,
                )
                dropped = 0
            else:
                notes = kept

        out = os.path.join(args.outdir, name[: -len(".txt")] + ".candidate.json")
        with open(out, "w") as f:
            json.dump(notes, f)
        if dropped:
            write_midi(notes, os.path.join(args.outdir, name[: -len(".txt")] + ".mid"))
        print(f"{out}: {len(notes)} notes" + (f" ({dropped} gated out)" if dropped else ""))


if __name__ == "__main__":
    main()

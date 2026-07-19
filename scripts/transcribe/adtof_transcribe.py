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
import sys
import tempfile

# ADTOF's model was saved with Keras 2; under Keras 3 it fails to build
# (`keras.optimizers.legacy` is gone). Must be set before tensorflow imports.
os.environ.setdefault("TF_USE_LEGACY_KERAS", "True")

# ADTOF's number for each of its five classes → the harness lane name.
ADTOF_TO_LANE = {35: "kick", 38: "snare", 47: "tom", 42: "hihat", 49: "crash"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", help="audio file (or folder of audio files)")
    ap.add_argument("outdir", help="output folder for .mid / .txt / .candidate.json")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO)
    from adtof.model.model import Model

    model, hparams = Model.modelFactory(modelName="Frame_RNN", scenario="adtofAll", fold=0)
    if not model.weightLoadedFlag:
        sys.exit("pretrained weights failed to load — expected Frame_RNN_adtofAll_0 in adtof/models/")

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
        out = os.path.join(args.outdir, name[: -len(".txt")] + ".candidate.json")
        with open(out, "w") as f:
            json.dump(notes, f)
        print(f"{out}: {len(notes)} notes")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""End-to-end checks for the chart-generation pipeline.

WHY THIS IS SEPARATE from `npm run test`. Those tests are pure and fast; this
one loads TensorFlow, runs the model, and needs the ~1.9GB venv. It cannot live
in the unit suite. But the pipeline had NO automated coverage at all, so a
dependency bump or a script edit could break it silently and only surface a
hardware-session later. This is the tripwire.

WHAT IT ASSERTS — plumbing correctness, never transcription ACCURACY. Accuracy
belongs in scripts/eval/ against a human-charted song, and is bottlenecked on
ground truth (see scripts/eval/README.md). Here the questions are only "does a
good input produce an importable chart?" and "does a bad input fail cleanly?".

Run:  .venv-adt/bin/python scripts/transcribe/test_pipeline.py
      npm run test:transcribe
Exits non-zero on the first failure.
"""

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
PIPELINE = os.path.join(HERE, "chart_from_audio.py")
ORACLE = os.path.join(REPO, "assets/practice-groove/practice-groove.flac")

# The GM notes ADTOF can emit — anything else means the vocabulary map broke.
VALID_GM = {35, 38, 42, 47, 49}

passed = 0
failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f" — {detail}" if detail else ""))


def run(audio, extra=None):
    """Run the pipeline on `audio`, returning (returncode, parsed_stdout, stderr).

    parsed_stdout is the JSON result dict, or None when the run failed.
    """
    out = tempfile.mkdtemp(prefix="pipetest-")
    cmd = [sys.executable, PIPELINE, audio, out, "--no-separate"] + (extra or [])
    proc = subprocess.run(cmd, capture_output=True, text=True)
    result = None
    if proc.returncode == 0:
        try:
            result = json.loads(proc.stdout.strip())
        except json.JSONDecodeError:
            pass
    return proc.returncode, result, proc.stderr, out


def midi_track(path):
    """First non-empty track of a .mid, via mido. Returns (channel, [notes])."""
    import mido

    mid = mido.MidiFile(path)
    for track in mid.tracks:
        notes = [m for m in track if m.type == "note_on" and m.velocity > 0]
        if notes:
            channel = notes[0].channel
            return channel, [m.note for m in notes]
    return None, []


def make(cmd_args, path):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *cmd_args, path], check=True)


def main():
    if not os.path.isfile(ORACLE):
        sys.exit(f"missing oracle audio: {ORACLE}")

    tmp = tempfile.mkdtemp(prefix="pipeinputs-")
    print("REGRESSION — the oracle must produce an importable chart")
    code, result, stderr, out = run(ORACLE)
    check("exit 0 on good audio", code == 0, stderr[-300:])
    if result:
        check("emitted a JSON result", isinstance(result, dict))
        check("reported a note count > 0", result.get("noteCount", 0) > 0)
        # practice-groove has 262 ungated notes; allow drift for model/dep
        # changes but catch a collapse or an explosion.
        n = result.get("noteCount", 0)
        check("note count in a sane range (150-400)", 150 <= n <= 400, f"got {n}")
        midi = result.get("midiPath", "")
        check("the .mid exists", os.path.isfile(midi))
        if os.path.isfile(midi):
            channel, notes = midi_track(midi)
            check("chart is on GM channel 10 (index 9)", channel == 9, f"channel {channel}")
            check("every note is in the model vocabulary", set(notes) <= VALID_GM,
                  f"stray notes {set(notes) - VALID_GM}")
            check("note count in .mid matches the summary", len(notes) == n,
                  f"{len(notes)} vs {n}")

    print("\nROBUSTNESS — bad inputs must fail cleanly, never crash or lie")

    missing = os.path.join(tmp, "does-not-exist.flac")
    code, _result, stderr, _out = run(missing)
    check("missing file: non-zero exit", code != 0)
    check("missing file: names the problem", "no such audio" in stderr.lower())

    corrupt = os.path.join(tmp, "corrupt.flac")
    with open(corrupt, "wb") as f:
        f.write(os.urandom(40000))
    code, _result, stderr, _out = run(corrupt)
    check("corrupt file: non-zero exit", code != 0)
    check("corrupt file: human message, not a traceback",
          "could not read" in stderr.lower() and "Traceback" not in stderr.split("\n")[-3:][0],
          stderr[-200:])

    empty = os.path.join(tmp, "empty.flac")
    open(empty, "w").close()
    code, _result, stderr, _out = run(empty)
    check("empty file: non-zero exit", code != 0)
    check("empty file: human message", "could not read" in stderr.lower(), stderr[-200:])

    silence = os.path.join(tmp, "silence.flac")
    make(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "2"], silence)
    code, _result, stderr, _out = run(silence)
    check("silence: non-zero exit", code != 0)
    check("silence: says no drums found, not 'no .mid'",
          "no drums" in stderr.lower(), stderr[-200:])

    mono = os.path.join(tmp, "mono.flac")
    make(["-i", ORACLE, "-ac", "1"], mono)
    code, result, stderr, _out = run(mono)
    check("mono audio: succeeds", code == 0, stderr[-200:])
    check("mono audio: produced notes", bool(result) and result.get("noteCount", 0) > 0)

    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

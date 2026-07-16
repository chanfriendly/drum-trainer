"""Renders the Practice Groove chart to audio.

Reads the SAME note list scripts/generate-test-song.mjs used to write the MIDI,
so the audio and the chart share a time base exactly. That identity is the point:
this is the only song where the correct alignment is known (offset 0, scale 1),
which makes it the oracle for gameplay, judging, and the alignment estimator.

Output is FLAC, deliberately. mp3/AAC encoders add ~13-26ms of encoder delay —
comparable to the +/-25ms Perfect window, and exactly the class of systematic
bias that cost real debugging time already (see CHANGELOG on FRAME_LEAD). FLAC
is lossless and sample-exact, so the ground truth survives encoding.

No soundfont or fluidsynth needed: the kit is synthesised from noise and sine
sweeps. It won't win a Grammy, but the transients are sharp, which is what both
onset detection and a drummer's ear actually need.

Usage: python3 scripts/render-test-song.py
"""

import json
import subprocess
import wave
from pathlib import Path

import numpy as np

SR = 44100
OUT = Path(__file__).resolve().parent.parent / "assets" / "practice-groove"
RNG = np.random.default_rng(1729)  # deterministic: reruns produce identical audio

KICK, SNARE = 36, 38
HAT_CLOSED, HAT_OPEN = 42, 46
TOM_LOW, TOM_MID, TOM_HIGH = 45, 47, 48
CRASH, RIDE = 49, 51


def env(n, attack, decay):
    """Percussive envelope: near-instant attack, exponential decay."""
    a = max(1, int(attack * SR))
    e = np.exp(-np.linspace(0, decay, n))
    e[:a] *= np.linspace(0, 1, a)
    return e


def noise(n):
    return RNG.uniform(-1, 1, n)


def lowpass(x, cutoff):
    """One-pole lowpass. Crude but adequate for shaping drum noise."""
    alpha = np.exp(-2 * np.pi * cutoff / SR)
    out = np.zeros_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc = alpha * acc + (1 - alpha) * x[i]
        out[i] = acc
    return out


def highpass(x, cutoff):
    return x - lowpass(x, cutoff)


def kick():
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    # Pitch sweep 120Hz -> 45Hz is what makes a kick read as a kick.
    freq = 45 + 75 * np.exp(-t * 28)
    phase = 2 * np.pi * np.cumsum(freq) / SR
    body = np.sin(phase) * env(n, 0.001, 9)
    click = noise(n) * env(n, 0.0005, 400) * 0.25
    return (body + click) * 0.95


def snare():
    n = int(0.25 * SR)
    t = np.arange(n) / SR
    tone = (np.sin(2 * np.pi * 190 * t) + np.sin(2 * np.pi * 280 * t)) * 0.35
    rattle = highpass(noise(n), 1200) * 0.9
    return (tone + rattle) * env(n, 0.0005, 22) * 0.8


def hat(open_hat):
    n = int((0.32 if open_hat else 0.055) * SR)
    body = highpass(noise(n), 7000)
    return body * env(n, 0.0003, 6 if open_hat else 45) * (0.45 if open_hat else 0.38)


def tom(base_freq):
    n = int(0.4 * SR)
    t = np.arange(n) / SR
    freq = base_freq * (1 + 0.35 * np.exp(-t * 16))
    phase = 2 * np.pi * np.cumsum(freq) / SR
    body = np.sin(phase) * env(n, 0.001, 11)
    skin = highpass(noise(n), 2000) * env(n, 0.0005, 120) * 0.18
    return (body + skin) * 0.85


def crash():
    n = int(1.6 * SR)
    shimmer = highpass(noise(n), 4000)
    return shimmer * env(n, 0.002, 4.5) * 0.5


def ride():
    n = int(0.7 * SR)
    t = np.arange(n) / SR
    bell = np.sin(2 * np.pi * 2400 * t) * 0.18 * env(n, 0.001, 30)
    wash = highpass(noise(n), 5500) * env(n, 0.001, 9) * 0.3
    return bell + wash


print("synthesising kit...")
VOICES = {
    KICK: kick(),
    SNARE: snare(),
    HAT_CLOSED: hat(False),
    HAT_OPEN: hat(True),
    TOM_LOW: tom(110),
    TOM_MID: tom(150),
    TOM_HIGH: tom(200),
    CRASH: crash(),
    RIDE: ride(),
}

notes = json.loads((OUT / "notes.json").read_text())
duration = max(n["time"] for n in notes) + 2.5
mix = np.zeros(int(duration * SR))

for n in notes:
    voice = VOICES.get(n["midi"])
    if voice is None:
        raise SystemExit(f"No voice for MIDI note {n['midi']}")
    # Sample-accurate placement: the chart time IS the audio time.
    start = int(round(n["time"] * SR))
    end = min(start + len(voice), len(mix))
    mix[start:end] += voice[: end - start] * n["velocity"]

peak = np.abs(mix).max()
mix = mix / peak * 0.89  # headroom, no clipping
print(f"mixed {len(notes)} hits, {duration:.2f}s, peak was {peak:.2f}")

wav_path = OUT / "practice-groove.wav"
with wave.open(str(wav_path), "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix * 32767).astype("<i2").tobytes())
print(f"wrote {wav_path.name} ({wav_path.stat().st_size / 1e6:.1f} MB)")

flac_path = OUT / "practice-groove.flac"
subprocess.run(
    ["ffmpeg", "-v", "error", "-y", "-i", str(wav_path), "-compression_level", "8", str(flac_path)],
    check=True,
)
wav_path.unlink()  # FLAC is lossless; the wav is just an intermediate
print(f"wrote {flac_path.name} ({flac_path.stat().st_size / 1e6:.1f} MB)")

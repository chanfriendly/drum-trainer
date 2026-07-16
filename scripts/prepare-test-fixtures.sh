#!/usr/bin/env bash
# Decodes the committed test-song audio into raw PCM for the alignment tests.
#
# The decoded PCM is ~5MB and trivially regenerable, so it is gitignored rather
# than committed; the FLAC it comes from IS committed. Tests that need it skip
# cleanly when it's absent, so this script is optional — run it to enable the
# real-audio alignment tests.
#
# ffmpeg is a TEST-ONLY dependency. The app itself decodes audio with Web Audio
# and needs nothing installed.
#
# Usage: npm run test:fixtures

set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p tests/fixtures

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found — install it (brew install ffmpeg) to enable real-audio tests." >&2
  exit 1
fi

# 22050 Hz mono f32 matches ANALYSIS_SAMPLE_RATE in src/renderer/lib/alignment.ts.
ffmpeg -v error -y \
  -i assets/practice-groove/practice-groove.flac \
  -ac 1 -ar 22050 -f f32le \
  tests/fixtures/practice-groove.raw

echo "wrote tests/fixtures/practice-groove.raw"

# Optional: the copyrighted Queen pair, if the user still has it in ~/Downloads.
# Not required — those tests skip without it. See PROGRESS.md → Test song.
QUEEN_MP3="$HOME/Downloads/Queen - Another One Bites the Dust (Official Video).mp3"
if [ -f "$QUEEN_MP3" ]; then
  ffmpeg -v error -y -i "$QUEEN_MP3" -ac 1 -ar 22050 -f f32le tests/fixtures/song.raw
  echo "wrote tests/fixtures/song.raw (real-world drift case)"
fi

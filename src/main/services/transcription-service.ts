/**
 * Transcription — audio in, a drum `.mid` out, by shelling out to Python.
 *
 * WHY THIS DOES NOT BREAK "never infer notes from audio" (CLAUDE.md critical
 * rule 2). That rule exists to forbid a SILENT FALLBACK: an import whose MIDI is
 * missing or unparseable must never quietly invent notes, because then a score
 * means nothing and nobody knows. This is the opposite — the player explicitly
 * asks for a transcription, waits for it, and the resulting song is recorded as
 * `chartSource: "transcribed"` so every screen can say where its notes came
 * from. The app still charts from a `.mid` file; this only produces one.
 *
 * WHY PYTHON, AND WHY NOT BUNDLED. The model needs TensorFlow — the venv is
 * ~1.9GB against a 115MB app. Bundling it is out of the question, so the
 * toolchain is EXTERNAL and merely located. That means it can be absent, and
 * absence must produce an explanation rather than a stack trace.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { app } from "electron";

import type { TranscriptionResult } from "../../shared/types.js";
import { logger } from "../logger.js";

/**
 * Where the Python toolchain might live.
 *
 * In dev the repo root is the cwd. In a packaged app there is no repo, so a
 * venv beside the .app or in the user's home is the realistic case. Checked in
 * order; the first that exists wins.
 */
function candidateRoots(): string[] {
  return [
    process.cwd(),
    path.join(app.getPath("home"), "Documents/GitHub/drums"),
    path.join(app.getPath("userData"), "toolchain"),
  ];
}

export interface Toolchain {
  python: string;
  script: string;
}

/** Locate the venv python and the pipeline script, or null if not set up. */
export function findToolchain(): Toolchain | null {
  for (const root of candidateRoots()) {
    const python = path.join(root, ".venv-adt/bin/python");
    const script = path.join(root, "scripts/transcribe/chart_from_audio.py");
    if (fs.existsSync(python) && fs.existsSync(script)) return { python, script };
  }
  return null;
}

export const SETUP_HELP =
  "Chart generation needs a one-time Python setup that is too large to ship " +
  "inside the app (~2GB of model tooling).\n\n" +
  "In the drum-trainer repo:\n" +
  "  /opt/homebrew/bin/python3.11 -m venv .venv-adt\n" +
  '  .venv-adt/bin/pip install "git+https://github.com/MZehren/ADTOF" tf_keras demucs\n\n' +
  "See scripts/transcribe/README.md.";

/**
 * Generate a chart from a song's audio.
 *
 * @param onProgress Receives the script's stage lines, so a long job can say
 *   what it is doing. Separation alone can take a minute.
 */
export async function transcribeFromAudio(
  audioPath: string,
  onProgress: (stage: string) => void,
): Promise<TranscriptionResult> {
  const toolchain = findToolchain();
  if (!toolchain) throw new Error(SETUP_HELP);

  if (!fs.existsSync(audioPath)) {
    throw new Error(`Could not read the audio file "${path.basename(audioPath)}".`);
  }

  // Output lands beside the app's data, not next to the user's music, so a
  // failed run never litters their Downloads folder.
  const outDir = path.join(app.getPath("userData"), "transcriptions", String(Date.now()));
  await fs.promises.mkdir(outDir, { recursive: true });

  logger.info("transcribe", "Starting", { audio: path.basename(audioPath), outDir });

  return new Promise<TranscriptionResult>((resolve, reject) => {
    const child = spawn(toolchain.python, [toolchain.script, audioPath, outDir]);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      // The script logs "[stage] message" lines; forward them verbatim.
      for (const line of text.split("\n")) {
        const match = /^\[(\w+)\]\s*(.+)$/.exec(line.trim());
        if (match) onProgress(match[2]);
      }
    });

    child.on("error", (error) =>
      reject(new Error(`Could not run the transcription toolchain: ${error.message}`)),
    );

    child.on("close", (code) => {
      if (code !== 0) {
        logger.error("transcribe", "Script failed", { code, stderr: stderr.slice(-800) });
        // The script's own sys.exit messages are written for humans; prefer
        // them over a bare exit code.
        const last = stderr.trim().split("\n").filter(Boolean).pop();
        reject(new Error(last ? last : `Transcription failed (exit ${code}).`));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim()) as TranscriptionResult;
        logger.info("transcribe", "Done", {
          noteCount: result.noteCount,
          gated: result.gated,
        });
        resolve(result);
      } catch {
        logger.error("transcribe", "Unparseable output", { stdout: stdout.slice(0, 400) });
        reject(new Error("The transcription script returned something unexpected."));
      }
    });
  });
}

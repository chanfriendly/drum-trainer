/**
 * `song-audio://` — streams a song's audio file to the renderer's <audio>
 * element without shipping the bytes over IPC.
 *
 * URL shape: song-audio://audio?id=<songId>&file=<audioFileName>
 * Served from `<userData>/songs/`, with containment checks so a request can
 * never escape that root.
 *
 * PORTING NOTE: Glaze provided `protocol.createFileResponse({root})`, which
 * handled Range requests and path containment for us. Electron has no
 * equivalent, so both are implemented here. Range support is not optional —
 * without a 206 response the <audio> element cannot seek, and gameplay that
 * starts anywhere but 0:00 silently fails to scrub. That makes this the one
 * place where getting "just serve the file" wrong costs a debugging session.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";

import { app, protocol } from "electron";

import { logger } from "../logger.js";

const SCHEME = "song-audio";

const MIME_BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};

/** `app.getPath` is SYNCHRONOUS in Electron — the Glaze sources awaited it. */
function songsRoot(): string {
  return path.join(app.getPath("userData"), "songs");
}

/**
 * Must run at module scope, before `app.whenReady()`. `stream: true` is what
 * lets the response body be a stream rather than a buffered blob; `standard`
 * is what makes `new URL()` parse the host/query at all.
 */
export function registerSongAudioScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

function textResponse(status: number, message: string): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain" } });
}

/**
 * Resolve `<root>/<id>/<file>`, refusing anything that escapes the root.
 * Returns null if the request is not safe.
 */
function resolveWithinRoot(id: string, file: string): string | null {
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return null;
  if (file.includes("/") || file.includes("\\") || file.includes("..")) return null;

  const root = path.resolve(songsRoot());
  const resolved = path.resolve(root, id, file);
  // Belt and braces: even with the checks above, confirm containment.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/** Parse a single `bytes=start-end` range. Multi-range is not supported. */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;

  if (rawStart === "") {
    // Suffix form: `bytes=-500` means the LAST 500 bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start < 0 || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

function fileStream(filePath: string, start: number, end: number): ReadableStream<Uint8Array> {
  const node = fs.createReadStream(filePath, { start, end });
  return Readable.toWeb(node) as ReadableStream<Uint8Array>;
}

export function handleSongAudioRequests(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const file = url.searchParams.get("file");

    if (!id || !file) return textResponse(400, "Missing id or file");

    const filePath = resolveWithinRoot(id, file);
    if (!filePath) {
      logger.warn("protocol", "Rejected unsafe song-audio path", { id, file });
      return textResponse(400, "Invalid path");
    }

    let size: number;
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) return textResponse(404, "Not found");
      size = stat.size;
    } catch {
      logger.warn("protocol", "song-audio file not found", { id, file });
      return textResponse(404, "Not found");
    }

    const contentType = MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const rangeHeader = request.headers.get("Range");

    if (!rangeHeader) {
      return new Response(fileStream(filePath, 0, size - 1), {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(size),
          // Advertise range support so the media element knows it may seek.
          "Accept-Ranges": "bytes",
        },
      });
    }

    const range = parseRange(rangeHeader, size);
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}`, "Content-Type": contentType },
      });
    }

    const { start, end } = range;
    return new Response(fileStream(filePath, start, end), {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
      },
    });
  });

  logger.info("protocol", "Registered song-audio protocol handler");
}

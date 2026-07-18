/**
 * Gameplay — scrolling lanes, live judging against the audio clock.
 *
 * THE CLOCK RULE (CLAUDE.md → Principles): judging reads `audioEl.currentTime`
 * at the instant a note-on arrives, minus `latencyOffsetMs`. The backend's MIDI
 * timestamp is never compared to audio time — the two clocks share no origin.
 * All transport lag is absorbed by the calibration offset.
 *
 * TWO CORRECTIONS, DIFFERENT JOBS — do not merge them:
 *   song.alignment      — where the CHART sits in the RECORDING (per song).
 *                         Applied once here, up front: every note's `audioTime`
 *                         is precomputed, so the rest of this file compares
 *                         audio time to audio time and never thinks about it again.
 *   latencyOffsetMs     — HARDWARE lag (global, from calibration). Applied at
 *                         judge time to the incoming hit.
 *
 * This is a raw <canvas> on requestAnimationFrame. Per-frame note movement
 * through a React tree is the wrong tool; nothing here uses the component set.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2Icon, PauseIcon, PlayIcon, XIcon } from "lucide-react";

import type {
  DrumType,
  HitWindows,
  Judgment,
  JudgmentBreakdown,
  ResultInput,
  SongWithChart,
} from "../../shared/types.js";
import { Button, useToast } from "../components/ui.js";
import { DRUM_COLORS, DRUM_COLORS_DIM, DRUM_LABELS, DRUM_TYPES } from "../lib/drums.js";
import { chartTimeToAudioTime } from "../lib/alignment.js";
import { songAudioUrl } from "../lib/audio.js";
import { loadSettings } from "../lib/settings.js";

const JUDGMENT_COLORS: Record<Judgment, string> = {
  perfect: "#facc15",
  good: "#22c55e",
  early: "#60a5fa",
  late: "#a78bfa",
  miss: "#ef4444",
};

/** Base points. Tuned values — see CLAUDE.md → Conventions. */
const JUDGMENT_SCORE: Record<Judgment, number> = {
  perfect: 100,
  good: 60,
  early: 30,
  late: 30,
  miss: 0,
};

/** Seconds of chart visible above the hit line. */
const LOOKAHEAD_SEC = 2.0;
const HIT_LINE_FRAC = 0.82;

interface NoteState {
  /** Time in AUDIO seconds — alignment already applied. */
  audioTime: number;
  drumType: DrumType;
  judged: boolean;
  judgment: Judgment | null;
}

function blankBreakdown(): JudgmentBreakdown {
  return { perfect: 0, good: 0, early: 0, late: 0, miss: 0 };
}

function buildPerDrum(): Record<DrumType, JudgmentBreakdown> {
  return {
    kick: blankBreakdown(),
    snare: blankBreakdown(),
    hihat: blankBreakdown(),
    tom: blankBreakdown(),
    crash: blankBreakdown(),
    ride: blankBreakdown(),
  };
}

/**
 * Bucket a timing error into a judgment. `diffMs` is (hit time − note time), so
 * negative is EARLY.
 *
 * Extracted from the render path deliberately: these windows are tuned values,
 * and this is the one part of judging that assertions can prove. Returns null
 * for a hit outside every window — a stray, which is not a miss and scores
 * nothing.
 */
export function judgeTiming(diffMs: number, windows: HitWindows): Judgment | null {
  const abs = Math.abs(diffMs);
  if (abs <= windows.perfectMs) return "perfect";
  if (abs <= windows.goodMs) return "good";
  if (abs <= windows.edgeMs) return diffMs < 0 ? "early" : "late";
  return null;
}

/** Score for one hit. Combo multiplier is tuned — see CLAUDE.md → Conventions. */
export function scoreForHit(judgment: Judgment, comboAfterHit: number): number {
  return Math.round(JUDGMENT_SCORE[judgment] * (1 + comboAfterHit / 25));
}

/** The spec's accuracy formula. Denominator is EVERY mapped note in the song. */
export function finalAccuracy(b: JudgmentBreakdown, totalNotes: number): number {
  if (totalNotes <= 0) return 0;
  const weighted = b.perfect * 1 + b.good * 0.6 + (b.early + b.late) * 0.3;
  return Math.min(100, (weighted / totalNotes) * 100);
}

/**
 * Running accuracy for the HUD — over notes RESOLVED so far, not the whole song.
 *
 * These are deliberately different. The saved result must use the spec formula
 * (denominator = every note), but showing that live reads as broken: one Perfect
 * into a 316-note song is 0.3%, and the number crawls up all song. A player
 * reading "0.3%" concludes the app is misjudging them. The HUD answers "how am I
 * doing?", the result answers "how did I do?".
 */
export function runningAccuracy(b: JudgmentBreakdown): number {
  const resolved = b.perfect + b.good + b.early + b.late + b.miss;
  if (resolved === 0) return 100;
  const weighted = b.perfect * 1 + b.good * 0.6 + (b.early + b.late) * 0.3;
  return Math.min(100, (weighted / resolved) * 100);
}

export function GameplayView() {
  const { songId } = useParams({ from: "/gameplay/$songId" });
  const navigate = useNavigate();

  const songQuery = useQuery({
    queryKey: ["song", songId],
    queryFn: () => window.drumTrainer.songs.get(songId),
  });

  if (songQuery.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-surface">
        <p className="text-sm text-drum-snare">{songQuery.error.message}</p>
        <Button onClick={() => void navigate({ to: "/" })}>Back to Library</Button>
      </div>
    );
  }
  if (!songQuery.data) {
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <Loader2Icon className="size-8 animate-spin text-text-muted" />
      </div>
    );
  }

  return <GameplayCanvas song={songQuery.data} />;
}

function GameplayCanvas({ song }: { song: SongWithChart }) {
  const navigate = useNavigate();
  const toast = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);

  // Settings are read ONCE per session: changing hit windows mid-song would
  // silently rescore the half already played.
  const settingsRef = useRef(loadSettings());
  const { midiMapping, hitWindows, latencyOffsetMs, selectedDeviceIndex } = settingsRef.current;

  const [phase, setPhase] = useState<"countdown" | "playing" | "paused" | "ended">("countdown");
  const [countdown, setCountdown] = useState(3);
  const [displayScore, setDisplayScore] = useState(0);
  const [displayCombo, setDisplayCombo] = useState(0);
  const [displayAccuracy, setDisplayAccuracy] = useState(100);

  const scoreRef = useRef(0);
  const comboRef = useRef(0);
  const maxComboRef = useRef(0);
  const overallRef = useRef<JudgmentBreakdown>(blankBreakdown());
  const perDrumRef = useRef<Record<DrumType, JudgmentBreakdown>>(buildPerDrum());
  const endedRef = useRef(false);
  const laneFlashRef = useRef<Partial<Record<DrumType, { judgment: Judgment; expireAt: number }>>>({});
  const floatsRef = useRef<{ drumType: DrumType; judgment: Judgment; born: number }[]>([]);

  /**
   * Notes in AUDIO time, sorted. Unmapped notes are DROPPED here, not scored as
   * misses — an unmapped note means the app doesn't know this kit, and the
   * player shouldn't be punished for that. They're excluded from totals too.
   */
  const notesRef = useRef<NoteState[]>([]);
  const totalNotes = useMemo(() => {
    notesRef.current = song.chart
      .filter((n) => n.midiNote in midiMapping)
      .map((n) => ({
        audioTime: chartTimeToAudioTime(n.time, song.alignment),
        drumType: midiMapping[n.midiNote],
        judged: false,
        judgment: null as Judgment | null,
      }))
      .sort((a, b) => a.audioTime - b.audioTime);
    return notesRef.current.length;
  }, [song.chart, song.alignment, midiMapping]);

  /**
   * Cursor into notesRef: everything before it is resolved and in the past.
   * The chart is sorted, so both miss detection and hit matching only ever look
   * at a small live window instead of rescanning thousands of notes each frame.
   */
  const cursorRef = useRef(0);

  // ── Warn if this song was never synced ──────────────────────────────
  useEffect(() => {
    if (song.alignment.source === "none") {
      toast.error(
        `“${song.name}” hasn't been synced, so the chart may not line up with the audio. Judging will look wrong — sync it from the Library first.`,
      );
    }
  }, [song.alignment.source, song.name, toast]);

  // ── MIDI device ─────────────────────────────────────────────────────
  useEffect(() => {
    if (selectedDeviceIndex === null) {
      toast.error("No MIDI device selected — pick your kit in Settings. Nothing will be judged.");
      return;
    }
    // One attempt, one message. Retrying a device that isn't there just floods
    // the screen; the player needs to leave and fix it in Settings either way.
    window.drumTrainer.midi.openDevice(selectedDeviceIndex).catch(() => {
      toast.error(
        "Couldn't open your MIDI device — it may have been unplugged. Nothing will be judged. Check it in Settings.",
      );
    });
    return () => {
      void window.drumTrainer.midi.closeDevice().catch(() => undefined);
    };
  }, [selectedDeviceIndex, toast]);

  // ── Countdown ───────────────────────────────────────────────────────
  useEffect(() => {
    let n = 3;
    const id = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(id);
        setPhase("playing");
        void audioRef.current?.play().catch(() => {
          toast.error("Audio failed to play.");
        });
      } else {
        setCountdown(n);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [toast]);

  const syncDisplay = useCallback(() => {
    setDisplayScore(scoreRef.current);
    setDisplayCombo(comboRef.current);
    setDisplayAccuracy(runningAccuracy(overallRef.current));
  }, []);

  // ── Judging ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "playing") return;

    return window.drumTrainer.midi.onNote((event) => {
      if (endedRef.current) return;

      const drumType = midiMapping[event.note];
      if (!drumType) return; // unmapped → ignored, never a miss

      const audio = audioRef.current;
      if (!audio) return;

      // THE CLOCK READ. Audio time at this instant, corrected for hardware lag.
      const hitMs = audio.currentTime * 1000 - latencyOffsetMs;

      // Only notes in this lane within the widest window can match. Scan the
      // live window around the cursor rather than the whole chart.
      let bestIdx = -1;
      let bestDiff = Infinity;
      for (let i = cursorRef.current; i < notesRef.current.length; i++) {
        const ns = notesRef.current[i];
        const noteMs = ns.audioTime * 1000;
        if (noteMs > hitMs + hitWindows.edgeMs) break; // sorted: nothing later can match
        if (ns.judged || ns.drumType !== drumType) continue;
        const diff = Math.abs(hitMs - noteMs);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) return;

      const ns = notesRef.current[bestIdx];
      const diff = hitMs - ns.audioTime * 1000;

      const judgment = judgeTiming(diff, hitWindows);
      if (judgment === null) return; // a stray hit: not a judgement, not a miss

      ns.judged = true;
      ns.judgment = judgment;

      comboRef.current += 1;
      maxComboRef.current = Math.max(maxComboRef.current, comboRef.current);
      scoreRef.current += scoreForHit(judgment, comboRef.current);
      overallRef.current[judgment] += 1;
      perDrumRef.current[drumType][judgment] += 1;

      laneFlashRef.current[drumType] = { judgment, expireAt: performance.now() + 200 };
      floatsRef.current.push({ drumType, judgment, born: performance.now() });
      syncDisplay();
    });
  }, [phase, midiMapping, hitWindows, latencyOffsetMs, syncDisplay]);

  // ── Miss detection + render loop ────────────────────────────────────
  useEffect(() => {
    if (phase !== "playing" && phase !== "paused") return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const tick = (now: number) => {
      if (endedRef.current) return;
      const currentTime = audioRef.current?.currentTime ?? 0;

      if (phase === "playing") {
        let missed = false;
        // Advance the cursor past everything now unreachable.
        while (cursorRef.current < notesRef.current.length) {
          const ns = notesRef.current[cursorRef.current];
          if (ns.audioTime * 1000 >= currentTime * 1000 - hitWindows.edgeMs) break;
          if (!ns.judged) {
            ns.judged = true;
            ns.judgment = "miss";
            overallRef.current.miss += 1;
            perDrumRef.current[ns.drumType].miss += 1;
            missed = true;
          }
          cursorRef.current += 1;
        }
        if (missed) {
          comboRef.current = 0;
          syncDisplay();
        }
      }

      floatsRef.current = floatsRef.current.filter((f) => now - f.born < 600);
      draw(ctx, canvas, currentTime, now);
      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, hitWindows, syncDisplay]);

  const draw = (
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    currentTime: number,
    now: number,
  ) => {
    const W = canvas.width;
    const H = canvas.height;
    const laneW = W / DRUM_TYPES.length;
    const hitY = H * HIT_LINE_FRAC;

    ctx.fillStyle = "#0a0a0f";
    ctx.fillRect(0, 0, W, H);

    DRUM_TYPES.forEach((dt, i) => {
      const x = i * laneW;
      ctx.fillStyle = DRUM_COLORS_DIM[dt];
      ctx.fillRect(x, 0, laneW, H);
      if (i > 0) {
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.fillRect(x, 0, 1, H);
      }
      const flash = laneFlashRef.current[dt];
      if (flash && flash.expireAt > now) {
        const alpha = (flash.expireAt - now) / 200;
        ctx.fillStyle = DRUM_COLORS[dt] + toHexAlpha(alpha * 0.25);
        ctx.fillRect(x, 0, laneW, H);
      }
    });

    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(0, hitY - 1, W, 2);

    DRUM_TYPES.forEach((dt, i) => {
      const x = i * laneW + laneW * 0.15;
      const flash = laneFlashRef.current[dt];
      const alpha = flash && flash.expireAt > now ? (flash.expireAt - now) / 200 : 0.4;
      const grad = ctx.createLinearGradient(x, hitY - 8, x, hitY + 8);
      grad.addColorStop(0, "transparent");
      grad.addColorStop(0.5, DRUM_COLORS[dt] + toHexAlpha(alpha));
      grad.addColorStop(1, "transparent");
      ctx.fillStyle = grad;
      ctx.fillRect(x, hitY - 8, laneW * 0.7, 16);
    });

    // Only the live window is on screen; start from the cursor, stop once past
    // the lookahead. Drawing all 316+ notes every frame would be pure waste.
    for (let i = cursorRef.current; i < notesRef.current.length; i++) {
      const ns = notesRef.current[i];
      const dt = ns.audioTime - currentTime;
      if (dt > LOOKAHEAD_SEC) break;
      if (ns.judged) continue;
      if (dt < -0.1) continue;

      const laneIdx = DRUM_TYPES.indexOf(ns.drumType);
      const x = laneIdx * laneW + laneW * 0.1;
      const y = hitY - (dt / LOOKAHEAD_SEC) * hitY;
      const color = DRUM_COLORS[ns.drumType];

      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x, y - 5, laneW * 0.8, 10, 4);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    DRUM_TYPES.forEach((dt, i) => {
      ctx.fillStyle = DRUM_COLORS[dt] + "cc";
      ctx.font = "bold 11px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(DRUM_LABELS[dt], i * laneW + laneW / 2, H - 10);
    });

    floatsRef.current.forEach((f) => {
      const elapsed = (now - f.born) / 600;
      const laneIdx = DRUM_TYPES.indexOf(f.drumType);
      ctx.globalAlpha = Math.max(0, 1 - elapsed);
      ctx.fillStyle = JUDGMENT_COLORS[f.judgment];
      ctx.font = "bold 13px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(f.judgment.toUpperCase(), laneIdx * laneW + laneW / 2, hitY - 30 - elapsed * 40);
      ctx.globalAlpha = 1;
    });
  };

  const finish = useCallback(async () => {
    if (endedRef.current) return;
    endedRef.current = true;
    cancelAnimationFrame(frameRef.current);
    setPhase("ended");

    // Anything never reached is a miss.
    for (const ns of notesRef.current) {
      if (!ns.judged) {
        ns.judged = true;
        ns.judgment = "miss";
        overallRef.current.miss += 1;
        perDrumRef.current[ns.drumType].miss += 1;
      }
    }

    const input: ResultInput = {
      songId: song.id,
      score: scoreRef.current,
      // The SAVED accuracy uses the spec formula (over every note), not the HUD's.
      accuracy: finalAccuracy(overallRef.current, totalNotes),
      maxCombo: maxComboRef.current,
      totalNotes,
      overall: { ...overallRef.current },
      perDrum: { ...perDrumRef.current },
    };

    try {
      await window.drumTrainer.results.save(input);
    } catch (error) {
      toast.error(`Couldn't save your result: ${error instanceof Error ? error.message : error}`);
    }
    await window.drumTrainer.midi.closeDevice().catch(() => undefined);
    void navigate({ to: "/results/$songId", params: { songId: song.id } });
  }, [song.id, totalNotes, navigate, toast]);

  const quit = async () => {
    endedRef.current = true;
    cancelAnimationFrame(frameRef.current);
    audioRef.current?.pause();
    await window.drumTrainer.midi.closeDevice().catch(() => undefined);
    void navigate({ to: "/" });
  };

  /**
   * Pause/resume. The original had a pause button and no way back — audio
   * stopped, the loop kept running against a frozen clock, and the only exit was
   * quitting. Judging is disabled while paused so a stray pad hit can't score.
   */
  const togglePause = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (phase === "playing") {
      audio.pause();
      setPhase("paused");
    } else if (phase === "paused") {
      void audio.play().catch(() => toast.error("Couldn't resume audio."));
      setPhase("playing");
    }
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const resize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      // Backing store in device pixels; CSS keeps the layout size. Without the
      // DPR scale the lanes are soft on a Retina display.
      const dpr = window.devicePixelRatio || 1;
      canvas.width = el.clientWidth * dpr;
      canvas.height = el.clientHeight * dpr;
      canvas.style.width = `${el.clientWidth}px`;
      canvas.style.height = `${el.clientHeight}px`;
    };
    resize();
    const obs = new ResizeObserver(resize);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="titlebar-drag flex shrink-0 items-center justify-between px-4 pb-3 pt-10">
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => void quit()} aria-label="Quit">
            <XIcon className="size-4" />
          </Button>
          <Button
            variant="ghost"
            onClick={togglePause}
            aria-label={phase === "paused" ? "Resume" : "Pause"}
            disabled={phase === "countdown" || phase === "ended"}
          >
            {phase === "paused" ? <PlayIcon className="size-4" /> : <PauseIcon className="size-4" />}
          </Button>
          <span className="max-w-40 truncate text-sm text-text-muted">{song.name}</span>
        </div>
        <div className="flex items-center gap-6">
          <Stat label="COMBO" value={`${displayCombo}x`} />
          <Stat label="ACCURACY" value={`${displayAccuracy.toFixed(1)}%`} />
          <Stat label="SCORE" value={displayScore.toLocaleString()} />
        </div>
      </div>

      <div ref={containerRef} className="relative flex-1 overflow-hidden">
        <canvas ref={canvasRef} className="absolute inset-0" />

        {phase === "countdown" && (
          <Overlay>
            <span className="text-[120px] font-black leading-none tabular-nums">{countdown}</span>
          </Overlay>
        )}
        {phase === "paused" && (
          <Overlay>
            <div className="flex flex-col items-center gap-4">
              <span className="text-3xl font-bold">Paused</span>
              <Button variant="accent" onClick={togglePause}>
                <PlayIcon className="size-4" />
                Resume
              </Button>
            </div>
          </Overlay>
        )}
        {phase === "ended" && (
          <Overlay>
            <div className="flex flex-col items-center gap-3">
              <p className="text-2xl font-bold">Saving…</p>
              <Loader2Icon className="size-8 animate-spin text-text-muted" />
            </div>
          </Overlay>
        )}
      </div>

      <audio
        ref={audioRef}
        src={songAudioUrl(song)}
        onEnded={() => void finish()}
        onError={() => toast.error("Audio failed to load.")}
        style={{ display: "none" }}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="text-[10px] tracking-wide text-text-muted">{label}</div>
      <div className="text-xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/65">{children}</div>
  );
}

/** 0-1 alpha → two-digit hex suffix for a #rrggbb colour. */
function toHexAlpha(alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  return Math.round(clamped * 255)
    .toString(16)
    .padStart(2, "0");
}

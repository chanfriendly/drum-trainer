/**
 * Calibration — tap along to a metronome, derive `latencyOffsetMs`.
 *
 * CLOCK ASSUMPTION, STATED OUT LOUD. Gameplay judges against an <audio>
 * element's `currentTime`; this screen schedules clicks on an AudioContext and
 * reads `ctx.currentTime` when a hit arrives. Those are two different playback
 * paths, and if their output latencies differ, the offset measured here is wrong
 * by that difference. They share an output device so they should agree closely,
 * but "should" is doing work — this is untested without hardware, and it is the
 * first thing to suspect if calibration produces a number that feels wrong in
 * play. AudioContext is used anyway because it can schedule a click to the
 * sample, which an <audio> element cannot.
 *
 * The offset this produces is a STARTING POINT, not a verdict. The real oracle
 * is gameplay: if hits still read consistently Early or Late, nudge the number
 * in Settings. That's not a workaround — it's the only test that matters.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, PlayIcon, SquareIcon } from "lucide-react";

import { Button, useToast } from "../components/ui.js";
import {
  clickSchedule,
  matchTapsToClicks,
  summarize,
  type CalibrationSummary,
} from "../lib/calibration.js";
import { loadSettings, updateSettings } from "../lib/settings.js";

const BPM = 100;
const BEATS = 16; // ~9.6s at 100bpm — long enough to average, short enough to hold focus
const LEAD_IN_SEC = 1.0;

export function CalibrationView() {
  const navigate = useNavigate();
  const toast = useToast();

  const [running, setRunning] = useState(false);
  const [beat, setBeat] = useState(0);
  const [tapCount, setTapCount] = useState(0);
  const [result, setResult] = useState<CalibrationSummary | null>(null);
  const [current, setCurrent] = useState(() => loadSettings().latencyOffsetMs);

  const ctxRef = useRef<AudioContext | null>(null);
  const clicksRef = useRef<number[]>([]);
  const tapsRef = useRef<number[]>([]);
  const runningRef = useRef(false);

  const stop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    void ctxRef.current?.close();
    ctxRef.current = null;
  }, []);

  useEffect(() => () => stop(), [stop]);

  // Capture taps for the whole session; only the run window is used.
  useEffect(() => {
    return window.drumTrainer.midi.onNote(() => {
      const ctx = ctxRef.current;
      if (!ctx || !runningRef.current) return;
      // THE CLOCK READ: same shape as gameplay's — read the audio clock at the
      // instant the note arrives, never a timestamp carried from the backend.
      tapsRef.current.push(ctx.currentTime);
      setTapCount(tapsRef.current.length);
    });
  }, []);

  const finish = useCallback(() => {
    const samples = matchTapsToClicks(tapsRef.current, clicksRef.current);
    const summary = summarize(samples);
    setResult(summary);
    stop();
  }, [stop]);

  const start = useCallback(async () => {
    const settings = loadSettings();
    if (settings.selectedDeviceIndex === null) {
      toast.error("Pick your kit in Settings first — there's nothing to listen to.");
      return;
    }
    await window.drumTrainer.midi.openDevice(settings.selectedDeviceIndex).catch(() => {
      toast.error("Could not open the MIDI device.");
    });

    setResult(null);
    setTapCount(0);
    setBeat(0);
    tapsRef.current = [];

    const ctx = new AudioContext();
    ctxRef.current = ctx;
    runningRef.current = true;
    setRunning(true);

    const clicks = clickSchedule(BPM, BEATS, ctx.currentTime + LEAD_IN_SEC);
    clicksRef.current = clicks;

    clicks.forEach((at, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      // Accent the downbeat so the bar is audible and taps don't drift a beat.
      osc.frequency.value = i % 4 === 0 ? 1600 : 1100;
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(i % 4 === 0 ? 0.4 : 0.25, at);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
      osc.start(at);
      osc.stop(at + 0.06);
    });

    // Drive the beat counter off the audio clock, not a timer — setInterval
    // drifts against the clicks the player is actually hearing.
    const tick = () => {
      if (!runningRef.current || !ctxRef.current) return;
      const elapsed = ctxRef.current.currentTime;
      const n = clicks.filter((c) => c <= elapsed).length;
      setBeat(n);
      if (n >= BEATS) {
        // A moment's grace for the final tap to arrive.
        setTimeout(() => runningRef.current && finish(), 400);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [toast, finish]);

  const save = () => {
    if (!result) return;
    const rounded = Math.round(result.offsetMs);
    updateSettings({ latencyOffsetMs: rounded });
    setCurrent(rounded);
    toast.success(`Latency offset set to ${rounded}ms`);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="titlebar-drag flex h-13 shrink-0 items-center gap-3 border-b border-border-subtle pl-20 pr-3">
        <Button variant="ghost" onClick={() => void navigate({ to: "/settings" })}>
          <ArrowLeftIcon className="size-4" />
          Settings
        </Button>
        <span className="text-sm font-semibold">Calibration</span>
      </header>

      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-xl space-y-6 p-6">
          <p className="text-sm text-text-muted">
            Hitting a pad and the app hearing it aren&apos;t simultaneous — your kit, the USB trip,
            and the audio output all add a few milliseconds. Tap along with the click and this
            measures the gap, so your timing is judged on when you actually played.
          </p>

          <div className="rounded-xl border border-border-subtle bg-surface-raised p-6 text-center">
            <div className="flex items-center justify-center gap-2">
              {Array.from({ length: BEATS }, (_, i) => (
                <span
                  key={i}
                  className="size-2 rounded-full transition-colors"
                  style={{
                    backgroundColor:
                      i < beat ? (i % 4 === 0 ? "#facc15" : "#8b8b9a") : "#26262f",
                  }}
                />
              ))}
            </div>

            <div className="mt-6 text-4xl font-black tabular-nums">
              {running ? `${beat} / ${BEATS}` : result ? "Done" : "Ready"}
            </div>
            <div className="mt-1 text-xs text-text-muted">
              {running
                ? `${tapCount} taps — keep going`
                : "Hit any pad on every click. Aim for the sound, not the screen."}
            </div>

            <div className="mt-6">
              {running ? (
                <Button onClick={stop}>
                  <SquareIcon className="size-4" />
                  Stop
                </Button>
              ) : (
                <Button variant="accent" onClick={() => void start()}>
                  <PlayIcon className="size-4" />
                  {result ? "Try again" : "Start"}
                </Button>
              )}
            </div>
          </div>

          {result && (
            <div className="rounded-xl border border-border-subtle bg-surface-raised p-5">
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
                <div>
                  <div className="text-xs text-text-muted">Measured offset</div>
                  <div className="font-mono text-2xl tabular-nums">
                    {result.offsetMs.toFixed(0)}ms
                  </div>
                </div>
                <div>
                  <div className="text-xs text-text-muted">Consistency</div>
                  <div
                    className="font-mono text-2xl tabular-nums"
                    style={{ color: result.spreadMs <= 20 ? "#22c55e" : result.usable ? "#f97316" : "#ef4444" }}
                  >
                    ±{result.spreadMs.toFixed(0)}ms
                  </div>
                </div>
                <div>
                  <div className="text-xs text-text-muted">Taps used</div>
                  <div className="font-mono text-2xl tabular-nums">{result.sampleCount}</div>
                </div>
              </div>

              <p className="mt-3 text-sm text-text-muted">{result.verdict}</p>

              {/* Consistency is the honest number: a confident-looking offset
                  built from scattered taps is worse than no offset at all. */}
              {result.usable && result.spreadMs > 20 && (
                <p className="mt-2 text-xs text-drum-crash">
                  Your taps varied by more than the Perfect window, so this offset is a rough
                  starting point. Re-running it usually tightens up.
                </p>
              )}

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button variant="accent" onClick={save} disabled={!result.usable}>
                  Use this offset
                </Button>
                <span className="text-xs text-text-muted">
                  Current: <span className="font-mono">{current}ms</span>
                </span>
              </div>
            </div>
          )}

          <p className="text-xs leading-relaxed text-text-muted">
            This measures you as well as your gear — everyone taps slightly early against a
            metronome, and that tendency belongs in the number, because the point is judging{" "}
            <em>your</em> playing fairly. It&apos;s per-player, so redo it if someone else sits
            down. The real test is a song: if hits still read consistently Early or Late, nudge
            the offset in Settings.
          </p>
        </div>
      </main>
    </div>
  );
}

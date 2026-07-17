/**
 * Sync — line a song's chart up with its audio.
 *
 * WHY THIS SCREEN EXISTS AT ALL. A MIDI transcription and a commercial
 * recording share no master, so the chart both starts at the wrong place and
 * drifts (the first real pair drifts ~600ms, enough to auto-Miss ~64% of the
 * song). See SongAlignment in shared/types.ts.
 *
 * WHY IT ISN'T JUST A BUTTON. Auto-alignment cannot pick the right BAR — a
 * groove looks identical shifted a bar, so the correlator has no way to choose.
 * Only a human ear can. So the estimate is a starting point, the preview is the
 * verdict, and the ±1 bar nudge is the fix. Confidence means "locked onto the
 * groove", NOT "found the right bar" — the UI has to say so, or a high number
 * will be read as "it's correct".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon, PlayIcon, SquareIcon, WandSparklesIcon } from "lucide-react";

import type { SongWithChart } from "../../shared/types.js";
import { Button, Spinner, useToast } from "../components/ui.js";
import { estimateAlignment, onsetEnvelope } from "../lib/alignment.js";
import { AlignmentPreview, loadAnalysisPcm } from "../lib/audio.js";

/** Beat-carrying notes — what the preview clicks on. Hats would be a blur. */
const BEAT_NOTES = new Set([35, 36, 38, 40]);

export function SyncView() {
  const { songId } = useParams({ from: "/sync/$songId" });
  const navigate = useNavigate();
  const toast = useToast();

  const songQuery = useQuery({
    queryKey: ["song", songId],
    queryFn: () => window.drumTrainer.songs.get(songId),
  });

  if (songQuery.isError) {
    return (
      <Chrome title="Sync">
        <p className="p-8 text-sm text-drum-snare">{songQuery.error.message}</p>
      </Chrome>
    );
  }
  // `isLoading` alone doesn't narrow `data` for TS — check the value itself.
  if (!songQuery.data) {
    return (
      <Chrome title="Sync">
        <Spinner label="Loading song…" />
      </Chrome>
    );
  }

  return <SyncEditor song={songQuery.data} onDone={() => void navigate({ to: "/" })} toast={toast} />;
}

function Chrome({ title, children }: { title: string; children: React.ReactNode }) {
  const navigate = useNavigate();
  return (
    <div className="flex h-full flex-col">
      <header className="titlebar-drag flex h-13 shrink-0 items-center gap-3 border-b border-border-subtle pl-20 pr-3">
        <Button variant="ghost" onClick={() => void navigate({ to: "/" })}>
          <ArrowLeftIcon className="size-4" />
          Library
        </Button>
        <span className="text-sm font-semibold">{title}</span>
      </header>
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}

function SyncEditor({
  song,
  onDone,
  toast,
}: {
  song: SongWithChart;
  onDone: () => void;
  toast: { success: (m: string) => void; error: (m: string) => void };
}) {
  const [offsetMs, setOffsetMs] = useState(song.alignment.offsetMs);
  const [tempoScale, setTempoScale] = useState(song.alignment.tempoScale);
  const [confidence, setConfidence] = useState(song.alignment.confidence);
  const [analyzing, setAnalyzing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  // Tracked separately, because they mean different things when saved:
  // `estimated` = the machine had a go; `nudged` = a human overrode it.
  const [estimated, setEstimated] = useState(false);
  const [nudged, setNudged] = useState(false);

  const preview = useRef(new AlignmentPreview());
  useEffect(() => {
    const p = preview.current;
    return () => p.stop(); // never leave audio playing behind a route change
  }, []);

  const beatTimes = useMemo(
    () => song.chart.filter((n) => BEAT_NOTES.has(n.midiNote)).map((n) => n.time),
    [song.chart],
  );

  // A bar is the natural nudge unit because the ambiguity IS bar-shaped.
  // Without a tempo we can't size one, so fall back to a beat-ish 500ms and say so.
  const barSeconds = song.bpm ? (4 * 60) / song.bpm : 0.5;
  const lastNote = song.chart.length > 0 ? song.chart[song.chart.length - 1].time : 0;
  const driftMs = lastNote * (1 - tempoScale) * 1000;

  const runAutoAlign = useCallback(async () => {
    setAnalyzing(true);
    try {
      const pcm = await loadAnalysisPcm(song);
      const env = onsetEnvelope(pcm);
      const est = estimateAlignment(env, song.chart);
      setOffsetMs(est.offsetMs);
      setTempoScale(est.tempoScale);
      setConfidence(est.confidence);
      setEstimated(true);
      toast.success(
        `Estimated offset ${(est.offsetMs / 1000).toFixed(3)}s, tempo ${(est.tempoScale * 100).toFixed(2)}% — now check it by ear.`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setAnalyzing(false);
    }
  }, [song, toast]);

  const togglePreview = async () => {
    if (playing) {
      preview.current.stop();
      setPlaying(false);
      return;
    }
    try {
      // Start a little before the first charted note so the lead-in is audible.
      const firstAudioTime = (song.chart[0]?.time ?? 0) * tempoScale + offsetMs / 1000;
      const from = Math.max(0, firstAudioTime - 1);
      setPlaying(true);
      await preview.current.play(song, beatTimes, { offsetMs, tempoScale }, from, 12);
      setTimeout(() => setPlaying(false), 12_000);
    } catch (error) {
      setPlaying(false);
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await window.drumTrainer.songs.setAlignment(song.id, {
        offsetMs,
        tempoScale,
        // "manual" ONLY if a human actually moved it — that is the signal that
        // someone chose the bar, which the estimator cannot do. Saving straight
        // after auto-align is "auto": the machine's guess, accepted as-is.
        source: nudged ? "manual" : estimated ? "auto" : song.alignment.source,
        confidence,
      });
      toast.success(`Synced “${song.name}”`);
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const nudge = (deltaMs: number) => {
    setOffsetMs((o) => o + deltaMs);
    setNudged(true);
  };

  return (
    <Chrome title={`Sync — ${song.name}`}>
      <div className="mx-auto max-w-2xl space-y-6 p-6">
        <p className="text-sm text-text-muted">
          A MIDI chart and a recording rarely share a clock: the chart can start in the wrong place
          and drift as the song plays. Line them up here once, and gameplay judges against the right
          times.
        </p>

        <section className="rounded-xl border border-border-subtle bg-surface-raised p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium">Estimate automatically</div>
              <p className="mt-1 text-xs text-text-muted">
                Matches the chart against the audio&apos;s drum hits.
              </p>
            </div>
            <Button variant="accent" onClick={() => void runAutoAlign()} disabled={analyzing}>
              <WandSparklesIcon className="size-4" />
              {analyzing ? "Analysing…" : "Auto-align"}
            </Button>
          </div>

          {confidence > 0 && (
            <div className="mt-4 rounded-lg bg-surface p-3 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-text-muted">Confidence</span>
                <span
                  className="font-mono font-medium"
                  style={{ color: confidence > 1.5 ? "#22c55e" : "#f97316" }}
                >
                  {confidence.toFixed(2)}
                </span>
                <span className="text-text-muted">
                  {confidence > 1.5 ? "locked onto the groove" : "weak — check carefully"}
                </span>
              </div>
              {/* The single most important sentence on this screen. */}
              <p className="mt-2 text-text-muted">
                This does <strong className="text-text-primary">not</strong> mean the bar is right.
                Every bar of a groove looks alike, so the estimate can be a whole bar off. Preview it
                and nudge until the clicks land on the drums.
              </p>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-border-subtle bg-surface-raised p-5">
          <div className="text-sm font-medium">Check it by ear</div>
          <p className="mt-1 text-xs text-text-muted">
            Plays 12s with a click on every kick and snare in the chart. If the clicks sit on the
            drums, it&apos;s aligned. If they&apos;re consistently between them, nudge by a bar.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button onClick={() => void togglePreview()}>
              {playing ? <SquareIcon className="size-4" /> : <PlayIcon className="size-4" />}
              {playing ? "Stop" : "Preview"}
            </Button>
            <div className="mx-2 h-6 w-px bg-border-subtle" />
            <Button onClick={() => nudge(-barSeconds * 1000)}>
              −1 {song.bpm ? "bar" : "½s"}
            </Button>
            <Button onClick={() => nudge(barSeconds * 1000)}>+1 {song.bpm ? "bar" : "½s"}</Button>
            <Button onClick={() => nudge(-10)}>−10ms</Button>
            <Button onClick={() => nudge(10)}>+10ms</Button>
          </div>
          {!song.bpm && (
            <p className="mt-3 text-xs text-drum-crash">
              This MIDI declares no tempo, so a bar&apos;s length is unknown — nudging by ½s instead.
            </p>
          )}
        </section>

        <section className="rounded-xl border border-border-subtle bg-surface-raised p-5">
          <div className="text-sm font-medium">Values</div>
          <dl className="mt-3 grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-xs text-text-muted">Offset</dt>
              <dd className="font-mono tabular-nums">{(offsetMs / 1000).toFixed(3)}s</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Tempo scale</dt>
              <dd className="font-mono tabular-nums">
                {(tempoScale * 100).toFixed(3)}%
                {song.bpm && (
                  <span className="ml-2 text-xs text-text-muted">
                    {(song.bpm * tempoScale).toFixed(2)} bpm vs {song.bpm.toFixed(2)} charted
                  </span>
                )}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs text-text-muted">Drift across the song</dt>
              <dd className="font-mono tabular-nums">
                {driftMs.toFixed(0)}ms
                <span
                  className="ml-2 font-sans text-xs"
                  style={{ color: Math.abs(driftMs) > 100 ? "#f97316" : "#8b8b9a" }}
                >
                  {Math.abs(driftMs) > 100
                    ? "the chart's tempo differs from the recording — without this correction the end of the song would auto-Miss"
                    : "tempo matches the recording"}
                </span>
              </dd>
            </div>
          </dl>
        </section>

        <div className="flex justify-end gap-2 pb-6">
          <Button onClick={onDone}>Cancel</Button>
          <Button variant="accent" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save alignment"}
          </Button>
        </div>
      </div>
    </Chrome>
  );
}

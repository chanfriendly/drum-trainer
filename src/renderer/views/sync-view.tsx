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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, FileAudioIcon, PlayIcon, SquareIcon, WandSparklesIcon } from "lucide-react";

import type { SongWithChart } from "../../shared/types.js";
import { Button, Spinner, useToast } from "../components/ui.js";
import {
  analyzeAlignment,
  describeShift,
  onsetEnvelope,
  type AlignmentAnalysis,
} from "../lib/alignment.js";
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
  const [analysis, setAnalysis] = useState<AlignmentAnalysis | null>(null);
  const [chosen, setChosen] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  // Tracked separately, because they mean different things when saved:
  // `estimated` = the machine had a go; `nudged` = a human overrode it.
  const [estimated, setEstimated] = useState(false);
  const [nudged, setNudged] = useState(false);
  const [settingStem, setSettingStem] = useState(false);
  const queryClient = useQueryClient();

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
      const result = analyzeAlignment(env, song.chart, { bpm: song.bpm });
      const best = result.candidates[0];

      setAnalysis(result);
      setChosen(0);
      setOffsetMs(best.offsetMs);
      setTempoScale(best.tempoScale);
      setConfidence(best.f1);
      setEstimated(true);

      toast.success(
        result.confident
          ? "One option fits clearly better — check it by ear, then save."
          : "Several options fit almost equally well. Preview each and pick the one that lands on the drums.",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setAnalyzing(false);
    }
  }, [song, toast]);

  // Attach (or remove) an isolated drum stem for the estimator to analyse.
  // Invalidate rather than track locally: the song prop re-renders with the
  // new analysisAudioFile, and the next Auto-align picks it up in loadAnalysisPcm.
  const setStem = async (pick: boolean) => {
    setSettingStem(true);
    try {
      let stemPath: string | null = null;
      if (pick) {
        stemPath = await window.drumTrainer.songs.pickAudio();
        if (!stemPath) return; // dialog cancelled — not an error, change nothing
      }
      await window.drumTrainer.songs.setAnalysisAudio(song.id, stemPath);
      await queryClient.invalidateQueries({ queryKey: ["song", song.id] });
      toast.success(
        pick
          ? "Stem attached. Run Auto-align again — it will analyse the stem now."
          : "Stem removed. Auto-align will analyse the full recording.",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSettingStem(false);
    }
  };

  const pickCandidate = (index: number) => {
    const c = analysis?.candidates[index];
    if (!c) return;
    setChosen(index);
    setOffsetMs(c.offsetMs);
    setTempoScale(c.tempoScale);
    setConfidence(c.f1);
    // Choosing from the ranked list is still the machine's answer, not a human
    // override — only a manual nudge counts as "manual".
    setEstimated(true);
  };

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

          {/* Guitar, bass and vocals all produce onsets; on a full mix the
              estimator locks onto all of them. An isolated drum stem gives it
              only drums to match — measured 4.7× the lock strength on the same
              song. Playback is untouched: the stem feeds analysis only. */}
          <div className="mt-4 flex items-center justify-between gap-4 rounded-lg bg-surface p-3">
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <FileAudioIcon className="size-4 shrink-0 text-text-muted" />
              {song.analysisAudioFile ? (
                <span className="truncate">
                  Analysing a <span className="font-medium text-drum-tom">drum stem</span>
                  <span className="text-text-muted"> — locks on much better than the full mix</span>
                </span>
              ) : (
                <span className="text-text-muted">
                  Analysing the full recording. Got an isolated drum stem (Fadr, Demucs)? Attaching
                  it gives the estimator only drums to lock onto.
                </span>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button onClick={() => void setStem(true)} disabled={settingStem || analyzing}>
                {song.analysisAudioFile ? "Replace stem…" : "Use a drum stem…"}
              </Button>
              {song.analysisAudioFile && (
                <Button onClick={() => void setStem(false)} disabled={settingStem || analyzing}>
                  Remove
                </Button>
              )}
            </div>
          </div>

          {analysis && (
            <div className="mt-4 space-y-3">
              <div className="rounded-lg bg-surface p-3 text-xs">
                {analysis.confident ? (
                  <p>
                    <span className="font-medium text-drum-tom">One clear winner.</span>{" "}
                    <span className="text-text-muted">
                      It fits better than the alternatives below — still worth one preview.
                    </span>
                  </p>
                ) : (
                  <p>
                    <span className="font-medium text-drum-crash">Too close to call.</span>{" "}
                    <span className="text-text-muted">
                      These fit almost equally well, because every bar of a groove looks alike.
                      Preview them and pick the one whose clicks land on the drums — your ear can
                      settle this and the maths can&apos;t.
                    </span>
                  </p>
                )}
              </div>

              <div className="space-y-1">
                {analysis.candidates.slice(0, 4).map((c, i) => (
                  <button
                    key={c.beatsFromSeed}
                    onClick={() => pickCandidate(i)}
                    className={`titlebar-no-drag flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs transition ${
                      i === chosen
                        ? "bg-drum-hihat/15 outline outline-1 outline-drum-hihat"
                        : "bg-surface hover:bg-surface-hover"
                    }`}
                  >
                    <span className="w-16 shrink-0 font-medium">
                      {describeShift(c.beatsFromSeed)}
                    </span>
                    <span className="w-20 shrink-0 font-mono text-text-muted">
                      {(c.offsetMs / 1000).toFixed(3)}s
                    </span>
                    {/* Fit bar: the comparison is the point, so show it visually
                        rather than making anyone read four decimals. */}
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-border-subtle">
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${c.f1 * 100}%`,
                          backgroundColor: i === 0 ? "#facc15" : "#8b8b9a",
                        }}
                      />
                    </span>
                    <span className="w-10 shrink-0 text-right font-mono text-text-muted">
                      {(c.f1 * 100).toFixed(0)}%
                    </span>
                  </button>
                ))}
              </div>

              {analysis.breathes && (
                <div className="rounded-lg border border-drum-crash/40 bg-drum-crash/10 p-3 text-xs">
                  <span className="font-medium text-drum-crash">
                    This recording doesn&apos;t hold one tempo.
                  </span>{" "}
                  <span className="text-text-muted">
                    Even at its best fit, parts of the song drift about{" "}
                    {analysis.residualMs.toFixed(0)}ms away — more than a Perfect window. Expect the
                    middle of the song to judge as Early/Late even when you play it right. Fixing it
                    properly means conforming the MIDI to the recording&apos;s real tempo in a DAW
                    (Logic&apos;s Smart Tempo) and re-importing.
                  </span>
                </div>
              )}
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
            {/* Beat nudges: the estimator's ambiguity is BEAT-shaped, not just
                bar-shaped (measured on a real pair — every ranked candidate sat
                on a beat grid). A one-beat miss must not take 48 ±10ms clicks. */}
            {song.bpm && (
              <>
                <Button onClick={() => nudge((-barSeconds * 1000) / 4)}>−1 beat</Button>
                <Button onClick={() => nudge((barSeconds * 1000) / 4)}>+1 beat</Button>
              </>
            )}
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

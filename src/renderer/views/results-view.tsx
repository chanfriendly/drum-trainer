/**
 * Results — per-song history, newest first.
 *
 * Read-only: gameplay writes these, this reads them. The per-drum breakdown is
 * the point — a single accuracy number tells you that you did badly, the
 * breakdown tells you it was the ride, which is the thing you can act on.
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon, PlayIcon } from "lucide-react";

import type { DrumType, JudgmentBreakdown, SongResult } from "../../shared/types.js";
import { Button, EmptyState, Spinner } from "../components/ui.js";
import { DRUM_COLORS, DRUM_LABELS, DRUM_TYPES } from "../lib/drums.js";

const JUDGMENT_COLORS = {
  perfect: "#facc15",
  good: "#22c55e",
  early: "#60a5fa",
  late: "#a78bfa",
  miss: "#ef4444",
} as const;

const JUDGMENT_ORDER = ["perfect", "good", "early", "late", "miss"] as const;

function formatWhen(ms: number): string {
  const date = new Date(ms);
  const now = Date.now();
  const mins = Math.round((now - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ResultsView() {
  const { songId } = useParams({ from: "/results/$songId" });
  const navigate = useNavigate();

  const songQuery = useQuery({
    queryKey: ["song", songId],
    queryFn: () => window.drumTrainer.songs.get(songId),
  });
  const resultsQuery = useQuery({
    queryKey: ["results", songId],
    queryFn: () => window.drumTrainer.results.list(songId),
  });

  const results = resultsQuery.data ?? [];
  const best = results.reduce<SongResult | null>(
    (acc, r) => (acc === null || r.score > acc.score ? r : acc),
    null,
  );

  return (
    <div className="flex h-full flex-col">
      <header className="titlebar-drag flex h-13 shrink-0 items-center gap-3 border-b border-border-subtle pl-20 pr-3">
        <Button variant="ghost" onClick={() => void navigate({ to: "/" })}>
          <ArrowLeftIcon className="size-4" />
          Library
        </Button>
        <span className="truncate text-sm font-semibold">
          {songQuery.data?.name ?? "Results"}
        </span>
        <div className="ml-auto">
          <Button
            variant="accent"
            onClick={() => void navigate({ to: "/gameplay/$songId", params: { songId } })}
          >
            <PlayIcon className="size-4" />
            Play again
          </Button>
        </div>
      </header>

      <main className="flex-1 overflow-auto">
        {resultsQuery.isLoading ? (
          <Spinner label="Loading history…" />
        ) : results.length === 0 ? (
          <EmptyState
            title="No attempts yet"
            description="Play the song and your score, accuracy, and per-drum breakdown will show up here."
            action={
              <Button
                variant="accent"
                onClick={() => void navigate({ to: "/gameplay/$songId", params: { songId } })}
              >
                <PlayIcon className="size-4" />
                Play
              </Button>
            }
          />
        ) : (
          <div className="mx-auto max-w-3xl space-y-4 p-6">
            {results.map((result) => (
              <ResultCard
                key={result.id}
                result={result}
                isBest={best !== null && result.id === best.id && results.length > 1}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function ResultCard({ result, isBest }: { result: SongResult; isBest: boolean }) {
  return (
    <article className="rounded-xl border border-border-subtle bg-surface-raised p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-2xl font-bold tabular-nums">{result.score.toLocaleString()}</span>
          {isBest && (
            <span className="rounded-full border border-drum-hihat/40 bg-drum-hihat/15 px-2 py-0.5 text-xs font-medium text-drum-hihat">
              Best
            </span>
          )}
        </div>
        <span className="text-xs text-text-muted">{formatWhen(result.playedAt)}</span>
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-4 text-sm">
        <Metric label="Accuracy" value={`${result.accuracy.toFixed(1)}%`} />
        <Metric label="Max combo" value={`${result.maxCombo}x`} />
        <Metric label="Notes" value={String(result.totalNotes)} />
      </dl>

      <div className="mt-4">
        <Bar breakdown={result.overall} total={result.totalNotes} />
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {JUDGMENT_ORDER.map((j) => (
            <span key={j} className="flex items-center gap-1.5 text-xs">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: JUDGMENT_COLORS[j] }}
              />
              <span className="text-text-muted capitalize">{j}</span>
              <span className="font-mono tabular-nums">{result.overall[j]}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="mt-5">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">Per drum</h3>
        <div className="mt-2 space-y-1.5">
          {DRUM_TYPES.map((drum) => {
            const b = result.perDrum[drum];
            const total = b.perfect + b.good + b.early + b.late + b.miss;
            // A lane the chart never uses isn't a failure — say nothing about it.
            if (total === 0) return null;
            return (
              <div key={drum} className="flex items-center gap-3">
                <span
                  className="w-14 shrink-0 text-xs font-medium"
                  style={{ color: DRUM_COLORS[drum] }}
                >
                  {DRUM_LABELS[drum]}
                </span>
                <div className="flex-1">
                  <Bar breakdown={b} total={total} />
                </div>
                <span className="w-20 shrink-0 text-right font-mono text-xs tabular-nums text-text-muted">
                  {total - b.miss}/{total}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="font-mono text-lg tabular-nums">{value}</dd>
    </div>
  );
}

/** Stacked proportion bar. `total` is passed in because it differs per context. */
function Bar({ breakdown, total }: { breakdown: JudgmentBreakdown; total: number }) {
  if (total <= 0) return null;
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-surface">
      {JUDGMENT_ORDER.map((j) => {
        const pct = (breakdown[j] / total) * 100;
        if (pct <= 0) return null;
        return (
          <div
            key={j}
            style={{ width: `${pct}%`, backgroundColor: JUDGMENT_COLORS[j] }}
            title={`${j}: ${breakdown[j]}`}
          />
        );
      })}
    </div>
  );
}

export type { DrumType };

/**
 * Library — the song list. Import, play, delete.
 *
 * Ported from the Glaze build with @glaze/core/components swapped for local
 * Tailwind primitives, and two additions the original couldn't have:
 *  - file pickers go through IPC (the renderer has no filesystem access here)
 *  - each row shows whether the song is SYNCED, because an unaligned song judges
 *    as gibberish and the player needs to know that before blaming their playing
 */

import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MusicIcon, PlayIcon, PlusIcon, SettingsIcon, SlidersHorizontalIcon, Trash2Icon } from "lucide-react";

import type { Difficulty, SongMeta, SongResult } from "../../shared/types.js";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  InfoTip,
  Spinner,
  useToast,
} from "../components/ui.js";
import { formatDuration } from "../lib/drums.js";

const DIFFICULTY_COLOR: Record<Difficulty, string> = {
  Easy: "#22c55e",
  Medium: "#06b6d4",
  Hard: "#f97316",
  Expert: "#ef4444",
};

function useSongs() {
  return useQuery({
    queryKey: ["songs"],
    queryFn: () => window.drumTrainer.songs.list(),
  });
}

/** Best score per song, for the list. One results:list call per song. */
function useBestResults(songIds: string[]) {
  return useQuery({
    queryKey: ["best-results", songIds],
    enabled: songIds.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        songIds.map(async (id): Promise<[string, SongResult | null]> => {
          const list = await window.drumTrainer.results.list(id);
          const best = list.reduce<SongResult | null>(
            (acc, r) => (acc === null || r.score > acc.score ? r : acc),
            null,
          );
          return [id, best];
        }),
      );
      return Object.fromEntries(entries);
    },
  });
}

export function LibraryView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [pendingDelete, setPendingDelete] = useState<SongMeta | null>(null);

  const songsQuery = useSongs();
  const songs = songsQuery.data ?? [];
  const bestResults = useBestResults(songs.map((s) => s.id));

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["songs"] });
    void queryClient.invalidateQueries({ queryKey: ["best-results"] });
  };

  const importMutation = useMutation({
    mutationFn: async () => {
      // Two dialogs, audio then MIDI. Cancelling either aborts cleanly —
      // `null` is a user decision, not an error to report.
      const audioPath = await window.drumTrainer.songs.pickAudio();
      if (!audioPath) return null;
      const midiPath = await window.drumTrainer.songs.pickMidi();
      if (!midiPath) return null;
      return window.drumTrainer.songs.import({ audioPath, midiPath });
    },
    onSuccess: (meta) => {
      if (!meta) return; // cancelled
      toast.success(`Imported “${meta.name}” — ${meta.noteCount} notes, ${meta.difficulty}`);
      refresh();
    },
    onError: (error: Error) => {
      // The backend's messages are written for humans ("No drum notes found in
      // that MIDI file..."), so show them rather than a generic failure.
      toast.error(error.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (song: SongMeta) => window.drumTrainer.songs.delete(song.id),
    onSuccess: (_result, song) => {
      toast.success(`Deleted “${song.name}”`);
      refresh();
    },
    onError: (error: Error) => toast.error(`Delete failed: ${error.message}`),
  });

  return (
    <div className="flex h-full flex-col">
      <header className="titlebar-drag flex h-13 shrink-0 items-center justify-between border-b border-border-subtle pl-20 pr-3">
        <span className="text-sm font-semibold">Drum Trainer</span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            onClick={() => void navigate({ to: "/settings" })}
            aria-label="Settings"
          >
            <SettingsIcon className="size-4" />
          </Button>
          <InfoTip label="What makes a good import">
            <div className="space-y-2.5">
              <p className="font-medium text-text-primary">A song is two files: audio + MIDI.</p>
              <p>
                The MIDI holds the drum chart — the app never guesses notes from audio, so the
                chart is only as good as the MIDI you give it.
              </p>
              <ul className="space-y-1.5">
                <li>
                  <span className="text-text-primary">Audio:</span> mp3, m4a, wav, aac, ogg, or
                  flac. Lossless (flac/wav) is best, but any of these work.
                </li>
                <li>
                  <span className="text-text-primary">MIDI:</span> a .mid with a real drum track.
                  No standalone .mid? Export one from{" "}
                  <span className="text-text-primary">MuseScore or Guitar Pro</span> — digital
                  sheet music exports MIDI directly.
                </li>
              </ul>
              <p>
                <span className="text-text-primary">Then sync it.</span> A recording and a
                transcription rarely share a clock, so every song needs the Sync step before the
                chart lines up with what you hear. Songs recorded to a click (most modern music)
                sync in seconds; older or live takes may drift — the Sync screen tells you which.
              </p>
              <p className="text-text-muted/80">
                Scanned/paper sheet music won&apos;t work — only digital scores export to MIDI.
              </p>
            </div>
          </InfoTip>
          <Button
            variant="accent"
            onClick={() => importMutation.mutate()}
            disabled={importMutation.isPending}
          >
            <PlusIcon className="size-4" />
            {importMutation.isPending ? "Importing…" : "Import Song"}
          </Button>
        </div>
      </header>

      <main className="flex-1 overflow-auto">
        {songsQuery.isLoading ? (
          <Spinner label="Loading library…" />
        ) : songsQuery.isError ? (
          <EmptyState
            title="Couldn't load your library"
            description={songsQuery.error.message}
            action={<Button onClick={() => void songsQuery.refetch()}>Retry</Button>}
          />
        ) : songs.length === 0 ? (
          <EmptyState
            icon={<MusicIcon className="size-10" />}
            title="No songs yet"
            description="A song is an audio file plus a MIDI file containing its drum track. Import a pair to start training."
            action={
              <Button variant="accent" onClick={() => importMutation.mutate()}>
                <PlusIcon className="size-4" />
                Import Song
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {songs.map((song) => (
              <SongRow
                key={song.id}
                song={song}
                best={bestResults.data?.[song.id] ?? null}
                onPlay={() =>
                  void navigate({ to: "/gameplay/$songId", params: { songId: song.id } })
                }
                onResults={() =>
                  void navigate({ to: "/results/$songId", params: { songId: song.id } })
                }
                onSync={() => void navigate({ to: "/sync/$songId", params: { songId: song.id } })}
                onDelete={() => setPendingDelete(song)}
              />
            ))}
          </ul>
        )}
      </main>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete “${pendingDelete?.name}”?`}
        description="This permanently removes the song, its copied audio, and its entire results history. This cannot be undone."
        confirmLabel="Delete"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) deleteMutation.mutate(pendingDelete);
          setPendingDelete(null);
        }}
      />
    </div>
  );
}

function SongRow({
  song,
  best,
  onPlay,
  onResults,
  onSync,
  onDelete,
}: {
  song: SongMeta;
  best: SongResult | null;
  onPlay: () => void;
  onResults: () => void;
  onSync: () => void;
  onDelete: () => void;
}) {
  const synced = song.alignment.source !== "none";

  return (
    <li className="flex items-center gap-3 px-4 py-3 transition hover:bg-surface-hover">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-raised">
        <MusicIcon className="size-5 text-text-muted" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{song.name}</span>
          <Badge color={DIFFICULTY_COLOR[song.difficulty]}>{song.difficulty}</Badge>
          {!synced && (
            // Clickable: a warning the player can't act on is just nagging.
            <button onClick={onSync} className="titlebar-no-drag">
              <Badge
                color="#f97316"
                title="The chart hasn't been lined up with the audio yet, so notes may not match what you hear. Click to sync."
              >
                Not synced
              </Badge>
            </button>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-text-muted tabular-nums">
          <span>{formatDuration(song.duration)}</span>
          <span>{song.noteCount} notes</span>
          {best ? (
            <button onClick={onResults} className="hover:text-text-primary hover:underline">
              Best {best.score.toLocaleString()} ({best.accuracy.toFixed(1)}%)
            </button>
          ) : (
            <span>No attempts yet</span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" onClick={onSync} aria-label={`Sync ${song.name}`} title="Sync chart to audio">
          <SlidersHorizontalIcon className="size-4" />
        </Button>
        <Button variant="accent" onClick={onPlay}>
          <PlayIcon className="size-4" />
          Play
        </Button>
        <Button variant="ghost" onClick={onDelete} aria-label={`Delete ${song.name}`}>
          <Trash2Icon className="size-4 text-drum-snare" />
        </Button>
      </div>
    </li>
  );
}

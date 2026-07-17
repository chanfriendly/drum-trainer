/**
 * Placeholder screens.
 *
 * These exist so the router resolves and the Library's navigation is really
 * exercised rather than pointing at nothing. Each is replaced by its real port —
 * see PROGRESS.md for the order. They deliberately say what's missing instead of
 * rendering a blank panel, so a half-built app is never mistaken for a broken one.
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";

import { Button } from "../components/ui.js";

function Placeholder({ title, detail }: { title: string; detail: string }) {
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
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="text-lg font-medium text-text-muted">{title} — not built yet</div>
        <p className="max-w-md text-sm text-text-muted">{detail}</p>
      </div>
    </div>
  );
}

export function ResultsView() {
  const { songId } = useParams({ from: "/results/$songId" });
  return (
    <Placeholder
      title="Results"
      detail={`Song ${songId}. Per-song history, newest first: accuracy, per-drum breakdown, max combo, score.`}
    />
  );
}

export function SettingsView() {
  return (
    <Placeholder
      title="Settings"
      detail="MIDI device picker, the note→drum mapping with per-drum Learn capture, hit windows, and the latency offset."
    />
  );
}

export function CalibrationView() {
  return (
    <Placeholder
      title="Calibration"
      detail="Tap along to a metronome for ~10s to derive the latency offset. That offset is hardware lag only — song alignment is separate."
    />
  );
}

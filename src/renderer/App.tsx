/**
 * SCAFFOLD / SMOKE TEST — temporary.
 *
 * This is deliberately not the real app. It exists to prove the riskiest thing
 * in the build works before there is any app around it: that @julusian/midi
 * loads and enumerates CoreMIDI devices from inside a PACKAGED .dmg, where the
 * native binary has to be found in app.asar.unpacked. That failure mode does
 * not reproduce in dev, so it gets tested here, while the surface area is small
 * enough to debug.
 *
 * Replaced by the router + Library view in the next task.
 */

import { useCallback, useEffect, useState } from "react";

import type { MidiDevice, MidiNoteEvent } from "../shared/types.js";

export function App(): React.JSX.Element {
  const [devices, setDevices] = useState<MidiDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [lastNote, setLastNote] = useState<MidiNoteEvent | null>(null);
  const [noteCount, setNoteCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [list, open] = await Promise.all([
        window.drumTrainer.midi.listDevices(),
        window.drumTrainer.midi.getOpenDevice(),
      ]);
      setDevices(list);
      setOpenIndex(open);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live note-ons. Summarized on screen rather than logged per event — a kit
  // produces a flood, and CLAUDE.md → Principles says don't stream that anywhere.
  useEffect(() => {
    return window.drumTrainer.midi.onNote((event) => {
      setLastNote(event);
      setNoteCount((n) => n + 1);
    });
  }, []);

  const open = async (index: number) => {
    try {
      setError(null);
      await window.drumTrainer.midi.openDevice(index);
      setOpenIndex(index);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full flex-col bg-surface text-text-primary">
      <header className="titlebar-drag flex h-12 shrink-0 items-center justify-center border-b border-border-subtle">
        <span className="text-sm font-medium text-text-muted">Drum Trainer — scaffold</span>
      </header>

      <main className="flex-1 overflow-auto p-8">
        <h1 className="text-2xl font-semibold">MIDI smoke test</h1>
        <p className="mt-2 max-w-prose text-sm text-text-muted">
          Proves the native CoreMIDI addon loads and enumerates devices. Run this from the packaged
          app, not just <code className="text-text-primary">npm run dev</code> — that is the case
          that actually breaks.
        </p>

        {error && (
          <div className="mt-6 rounded-lg border border-drum-snare/40 bg-drum-snare/10 p-4 text-sm">
            <div className="font-medium text-drum-snare">MIDI error</div>
            <div className="mt-1 font-mono text-xs text-text-muted">{error}</div>
          </div>
        )}

        <section className="mt-8">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-medium uppercase tracking-wide text-text-muted">
              Input devices
            </h2>
            <button
              onClick={() => void refresh()}
              className="titlebar-no-drag rounded-md border border-border-subtle px-2 py-1 text-xs hover:bg-surface-hover"
            >
              Refresh
            </button>
          </div>

          {devices === null && <p className="mt-3 text-sm text-text-muted">Loading…</p>}

          {devices?.length === 0 && (
            <p className="mt-3 text-sm text-text-muted">
              No CoreMIDI inputs found. Connect an e-kit — an empty list is a valid result here, but
              it does not prove the addon works.
            </p>
          )}

          <ul className="mt-3 space-y-2">
            {devices?.map((device) => (
              <li
                key={device.index}
                className="flex items-center justify-between rounded-lg border border-border-subtle bg-surface-raised px-4 py-3"
              >
                <span className="text-sm">
                  <span className="text-text-muted">{device.index}</span> {device.name}
                </span>
                <button
                  onClick={() => void open(device.index)}
                  disabled={openIndex === device.index}
                  className="rounded-md border border-border-subtle px-3 py-1 text-xs hover:bg-surface-hover disabled:opacity-50"
                >
                  {openIndex === device.index ? "Listening" : "Listen"}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-8">
          <h2 className="text-sm font-medium uppercase tracking-wide text-text-muted">Note-ons</h2>
          <p className="mt-3 text-sm">
            {noteCount === 0 ? (
              <span className="text-text-muted">
                None yet. Open a device above, then hit a pad.
              </span>
            ) : (
              <>
                <span className="font-mono text-drum-tom">{noteCount}</span> received. Last: note{" "}
                <span className="font-mono text-drum-hihat">{lastNote?.note}</span>, velocity{" "}
                <span className="font-mono text-drum-hihat">{lastNote?.velocity}</span>
              </>
            )}
          </p>
        </section>
      </main>
    </div>
  );
}

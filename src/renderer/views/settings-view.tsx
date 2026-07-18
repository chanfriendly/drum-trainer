/**
 * Settings — MIDI device, note→drum mapping, hit windows, latency offset.
 *
 * This screen is what makes the app usable with a real kit at all: without a
 * selected device nothing is ever judged. It was the last thing standing between
 * a working build and a practice session.
 *
 * The input monitor is not in the spec and earns its place: when a kit doesn't
 * work, the questions are always "is anything arriving?" and "what note is this
 * pad?". Without it the answer is a silent screen, and the player can't tell a
 * dead cable from a wrong mapping. It also makes Learn self-explanatory — you
 * can see the note land.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ActivityIcon, ArrowLeftIcon, RotateCcwIcon } from "lucide-react";

import type { AppSettings, DrumType, MidiNoteEvent } from "../../shared/types.js";
import { Button, useToast } from "../components/ui.js";
import { DEFAULT_MIDI_MAPPING, DRUM_COLORS, DRUM_LABELS, DRUM_TYPES } from "../lib/drums.js";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../lib/settings.js";

export function SettingsView() {
  const navigate = useNavigate();
  const toast = useToast();

  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [learning, setLearning] = useState<DrumType | null>(null);
  const [lastNote, setLastNote] = useState<MidiNoteEvent | null>(null);
  const [noteCount, setNoteCount] = useState(0);

  const devicesQuery = useQuery({
    queryKey: ["midi:listDevices"],
    queryFn: () => window.drumTrainer.midi.listDevices(),
  });

  const persist = useCallback((next: AppSettings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  /**
   * Is the saved device actually present right now? A kit that has been
   * unplugged leaves its index in localStorage, and the list comes back empty.
   */
  const devices = devicesQuery.data;
  const savedDeviceMissing =
    settings.selectedDeviceIndex !== null &&
    devices !== undefined &&
    !devices.some((d) => d.index === settings.selectedDeviceIndex);

  // Open the selected device on arrival so the monitor and Learn actually
  // receive anything. Deliberately NOT closed on unmount: gameplay reopens it,
  // quit cleans it up, and closing here would make Learn work only while the
  // screen is mounted for reasons a reader would have to guess at.
  //
  // Only attempt when the device is genuinely in the list. Opening a stale index
  // throws every time, and a failure that repeats is a failure worth preventing
  // rather than reporting — the unplugged-kit case is exactly this.
  useEffect(() => {
    if (settings.selectedDeviceIndex === null) return;
    if (devices === undefined || savedDeviceMissing) return;
    window.drumTrainer.midi.openDevice(settings.selectedDeviceIndex).catch(() => {
      toast.error("Could not open that MIDI device. Is it still connected?");
    });
  }, [settings.selectedDeviceIndex, devices, savedDeviceMissing, toast]);

  // Live input monitor + Learn capture share one subscription.
  useEffect(() => {
    return window.drumTrainer.midi.onNote((event) => {
      setLastNote(event);
      setNoteCount((n) => n + 1);

      if (!learning) return;
      // Capture: the note this pad sends now means this drum.
      const next: AppSettings = {
        ...settings,
        midiMapping: { ...settings.midiMapping, [event.note]: learning },
      };
      persist(next);
      setLearning(null);
      toast.success(`Note ${event.note} → ${DRUM_LABELS[learning]}`);
    });
  }, [learning, settings, persist, toast]);

  const mappedNotes = useMemo(() => {
    const byDrum: Record<DrumType, number[]> = {
      kick: [], snare: [], hihat: [], tom: [], crash: [], ride: [],
    };
    for (const [note, drum] of Object.entries(settings.midiMapping)) {
      byDrum[drum]?.push(Number(note));
    }
    for (const drum of DRUM_TYPES) byDrum[drum].sort((a, b) => a - b);
    return byDrum;
  }, [settings.midiMapping]);

  const setWindow = (key: keyof AppSettings["hitWindows"], value: number) => {
    persist({ ...settings, hitWindows: { ...settings.hitWindows, [key]: value } });
  };

  const lastNoteDrum = lastNote ? settings.midiMapping[lastNote.note] : undefined;

  return (
    <div className="flex h-full flex-col">
      <header className="titlebar-drag flex h-13 shrink-0 items-center gap-3 border-b border-border-subtle pl-20 pr-3">
        <Button variant="ghost" onClick={() => void navigate({ to: "/" })}>
          <ArrowLeftIcon className="size-4" />
          Library
        </Button>
        <span className="text-sm font-semibold">Settings</span>
      </header>

      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-2xl space-y-6 p-6">
          {/* ── Device ─────────────────────────────────────────── */}
          <Section
            title="MIDI input"
            description="Your electronic kit. Nothing is judged until a device is selected."
          >
            {savedDeviceMissing && (
              // Inline, not a toast: this is a persistent state, and a toast
              // that must be re-shown is a toast that gets shown in a loop.
              <p className="mb-3 rounded-lg border border-drum-crash/40 bg-drum-crash/10 p-3 text-xs text-text-muted">
                <span className="font-medium text-drum-crash">
                  Your saved MIDI device isn&apos;t connected.
                </span>{" "}
                Plug the kit back in and press Refresh, or pick another device below. Nothing will
                be judged until one is selected.
              </p>
            )}
            {devicesQuery.isLoading ? (
              <p className="text-sm text-text-muted">Looking for devices…</p>
            ) : devicesQuery.data?.length === 0 ? (
              <div className="space-y-2">
                <p className="text-sm text-drum-crash">No MIDI inputs found.</p>
                <p className="text-xs text-text-muted">
                  Connect your kit over USB, then Refresh. To test without hardware, enable the IAC
                  Driver in Audio MIDI Setup and drive it with{" "}
                  <code className="text-text-primary">npm run midi-sim</code>.
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={settings.selectedDeviceIndex ?? "none"}
                  onChange={(e) =>
                    persist({
                      ...settings,
                      selectedDeviceIndex: e.target.value === "none" ? null : Number(e.target.value),
                    })
                  }
                  className="titlebar-no-drag rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm"
                >
                  <option value="none">None selected</option>
                  {devicesQuery.data?.map((d) => (
                    <option key={d.index} value={d.index}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <Button onClick={() => void devicesQuery.refetch()}>Refresh</Button>
              </div>
            )}
          </Section>

          {/* ── Input monitor ──────────────────────────────────── */}
          <Section
            title="Input monitor"
            description="Hit a pad. If nothing appears here, the app isn't receiving from your kit — check the cable and the device above before touching the mapping."
          >
            <div className="flex items-center gap-4 rounded-lg bg-surface p-4">
              <ActivityIcon
                className={`size-5 ${noteCount > 0 ? "text-drum-tom" : "text-text-muted"}`}
              />
              {lastNote ? (
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
                  <span>
                    <span className="text-text-muted">note </span>
                    <span className="font-mono font-medium">{lastNote.note}</span>
                  </span>
                  <span>
                    <span className="text-text-muted">velocity </span>
                    <span className="font-mono">{lastNote.velocity}</span>
                  </span>
                  <span>
                    <span className="text-text-muted">→ </span>
                    {lastNoteDrum ? (
                      <span style={{ color: DRUM_COLORS[lastNoteDrum] }}>
                        {DRUM_LABELS[lastNoteDrum]}
                      </span>
                    ) : (
                      <span className="text-drum-crash">unmapped (ignored, never a miss)</span>
                    )}
                  </span>
                  <span className="text-xs text-text-muted">{noteCount} received</span>
                </div>
              ) : (
                <span className="text-sm text-text-muted">Waiting for a hit…</span>
              )}
            </div>
          </Section>

          {/* ── Mapping ────────────────────────────────────────── */}
          <Section
            title="Drum mapping"
            description="Which MIDI notes belong to which lane. Press Learn, then hit the pad — whatever it sends gets mapped. Notes not listed here are ignored during play, never counted as misses."
          >
            <div className="space-y-2">
              {DRUM_TYPES.map((drum) => (
                <div
                  key={drum}
                  className="flex items-center gap-3 rounded-lg bg-surface px-3 py-2"
                  style={learning === drum ? { outline: `1px solid ${DRUM_COLORS[drum]}` } : undefined}
                >
                  <span
                    className="w-16 shrink-0 text-sm font-medium"
                    style={{ color: DRUM_COLORS[drum] }}
                  >
                    {DRUM_LABELS[drum]}
                  </span>
                  <span className="flex-1 truncate font-mono text-xs text-text-muted">
                    {mappedNotes[drum].length > 0 ? mappedNotes[drum].join(", ") : "— none —"}
                  </span>
                  <Button
                    variant={learning === drum ? "accent" : "neutral"}
                    onClick={() => setLearning(learning === drum ? null : drum)}
                  >
                    {learning === drum ? "Hit a pad…" : "Learn"}
                  </Button>
                </div>
              ))}
            </div>
            <Button
              onClick={() => {
                persist({ ...settings, midiMapping: { ...DEFAULT_MIDI_MAPPING } });
                toast.success("Mapping reset to General MIDI defaults");
              }}
            >
              <RotateCcwIcon className="size-4" />
              Reset to GM defaults
            </Button>
          </Section>

          {/* ── Hit windows ────────────────────────────────────── */}
          <Section
            title="Hit windows"
            description="How close a hit must be to count. Wider is more forgiving. These are tuned defaults — change them only if the judging feels wrong to you, not to chase a score."
          >
            <div className="grid grid-cols-3 gap-3">
              <NumberField
                label="Perfect"
                suffix="ms"
                value={settings.hitWindows.perfectMs}
                onChange={(v) => setWindow("perfectMs", v)}
              />
              <NumberField
                label="Good"
                suffix="ms"
                value={settings.hitWindows.goodMs}
                onChange={(v) => setWindow("goodMs", v)}
              />
              <NumberField
                label="Edge"
                suffix="ms"
                value={settings.hitWindows.edgeMs}
                onChange={(v) => setWindow("edgeMs", v)}
              />
            </div>
            {(settings.hitWindows.perfectMs > settings.hitWindows.goodMs ||
              settings.hitWindows.goodMs > settings.hitWindows.edgeMs) && (
              // The windows nest; out of order they'd make later buckets dead code.
              <p className="text-xs text-drum-snare">
                These should widen outward: Perfect ≤ Good ≤ Edge. As set, some judgments can never
                occur.
              </p>
            )}
          </Section>

          {/* ── Latency ────────────────────────────────────────── */}
          <Section
            title="Latency offset"
            description="Compensates for lag between hitting a pad and the app hearing it — your kit, the USB trip, and audio output. This is about HARDWARE, and applies to every song. A song whose chart doesn't line up with its recording is a different problem: sync it from the Library."
          >
            <div className="flex flex-wrap items-end gap-3">
              <NumberField
                label="Offset"
                suffix="ms"
                value={settings.latencyOffsetMs}
                onChange={(v) => persist({ ...settings, latencyOffsetMs: v })}
              />
              <Button onClick={() => void navigate({ to: "/calibration" })}>
                Calibrate by tapping
              </Button>
            </div>
          </Section>

          <div className="pb-6">
            <Button
              onClick={() => {
                persist({ ...DEFAULT_SETTINGS, selectedDeviceIndex: settings.selectedDeviceIndex });
                toast.success("Settings reset (device kept)");
              }}
            >
              Reset all settings
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-xl border border-border-subtle bg-surface-raised p-5">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="mt-1 text-xs leading-relaxed text-text-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

function NumberField({
  label,
  suffix,
  value,
  onChange,
}: {
  label: string;
  suffix: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">
        {label} ({suffix})
      </span>
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          // An empty or garbage field yields NaN, which would poison every
          // comparison downstream and silently judge nothing.
          if (Number.isFinite(next)) onChange(next);
        }}
        className="titlebar-no-drag w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 font-mono text-sm tabular-nums"
      />
    </label>
  );
}

/**
 * Local UI primitives — the replacement for `@glaze/core/components`.
 *
 * Deliberately small and in one file: this app has five screens, and a
 * component library's worth of abstraction would be more code than the app.
 * Add pieces here as screens need them; don't build them speculatively.
 *
 * The gameplay canvas uses NONE of this — it's a raw <canvas> on rAF.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { XIcon } from "lucide-react";

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ── Button ────────────────────────────────────────────────────────────

type ButtonVariant = "accent" | "neutral" | "ghost" | "danger";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  accent: "bg-drum-hihat text-black hover:brightness-110 font-medium",
  neutral: "bg-surface-raised border border-border-subtle hover:bg-surface-hover",
  ghost: "hover:bg-surface-hover",
  danger: "bg-drum-snare text-white hover:brightness-110 font-medium",
};

export function Button({
  variant = "neutral",
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition",
        "disabled:pointer-events-none disabled:opacity-40",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-drum-hihat",
        // Buttons inside the draggable titlebar must opt out of dragging or
        // they never receive clicks.
        "titlebar-no-drag",
        BUTTON_VARIANTS[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

// ── Badge ─────────────────────────────────────────────────────────────

export function Badge({
  children,
  color = "#8b8b9a",
  title,
}: {
  children: ReactNode;
  color?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ color, backgroundColor: `${color}1f`, border: `1px solid ${color}40` }}
    >
      {children}
    </span>
  );
}

// ── Empty / loading / error states ────────────────────────────────────

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
      {icon && <div className="text-text-muted">{icon}</div>}
      <div className="text-lg font-medium">{title}</div>
      <p className="max-w-sm text-sm text-text-muted">{description}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-sm text-text-muted">
      <span className="size-4 animate-spin rounded-full border-2 border-border-subtle border-t-text-muted" />
      {label}
    </div>
  );
}

// ── Confirm dialog ────────────────────────────────────────────────────

/**
 * Confirmation for destructive actions. Deleting a song removes its audio and
 * its whole results history from disk with no undo, so it gets a speed bump.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Escape should always back out of a destructive prompt.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-border-subtle bg-surface-raised p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="text-base font-medium">{title}</div>
        <p className="mt-2 text-sm text-text-muted">{description}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} autoFocus>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Toasts ────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  message: string;
  tone: "success" | "error";
}

const ToastContext = createContext<{
  success: (message: string) => void;
  error: (message: string) => void;
} | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: Toast["tone"]) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    // Errors linger: an import failure explains WHY it failed and the player
    // needs time to read it. Successes are just acknowledgement.
    const ttl = tone === "error" ? 8000 : 3000;
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttl);
  }, []);

  const api = {
    success: useCallback((m: string) => push(m, "success"), [push]),
    error: useCallback((m: string) => push(m, "error"), [push]),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex w-full max-w-md -translate-x-1/2 flex-col gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              "pointer-events-auto flex items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-xl",
              t.tone === "error"
                ? "border-drum-snare/40 bg-drum-snare/15 text-text-primary"
                : "border-drum-tom/40 bg-drum-tom/15 text-text-primary",
            )}
          >
            <span className="flex-1 whitespace-pre-wrap">{t.message}</span>
            <button
              onClick={() => setToasts((list) => list.filter((x) => x.id !== t.id))}
              className="text-text-muted hover:text-text-primary"
              aria-label="Dismiss"
            >
              <XIcon className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

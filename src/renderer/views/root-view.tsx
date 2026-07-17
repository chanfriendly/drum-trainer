import { useEffect } from "react";
import { Outlet, useNavigate } from "@tanstack/react-router";

/**
 * Root layout. Owns the one piece of global wiring: the menu → route bridge.
 *
 * The "Settings…" menu item (⌘,) is built in the main process, which has no
 * router. It broadcasts `nav:goto` with a path; this translates that into a
 * navigation. Without this the menu item silently does nothing.
 */
export function RootView() {
  const navigate = useNavigate();

  useEffect(() => {
    return window.drumTrainer.onNavigate((path) => {
      void navigate({ to: path });
    });
  }, [navigate]);

  return (
    <div className="h-full bg-surface text-text-primary">
      <Outlet />
    </div>
  );
}

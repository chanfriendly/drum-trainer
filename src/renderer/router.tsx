/**
 * Routes.
 *
 * MEMORY history, not hash or browser history. In a packaged app the renderer is
 * loaded from `file://`, which has no server to resolve paths — but more to the
 * point, there is no URL bar, so a URL is pure overhead. Memory history keeps
 * navigation entirely in-process. (An earlier draft of the docs said "hash
 * history"; memory is strictly simpler and is what the Glaze build used too.)
 */

import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { RootView } from "./views/root-view.js";
import { LibraryView } from "./views/library-view.js";
import { SyncView } from "./views/sync-view.js";
import { GameplayView } from "./views/gameplay-view.js";
import { CalibrationView, ResultsView, SettingsView } from "./views/placeholders.js";

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootView,
  notFoundComponent: () => (
    <div className="flex h-full items-center justify-center text-sm text-text-muted">
      Route not found
    </div>
  ),
});

const libraryRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: LibraryView });

const gameplayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/gameplay/$songId",
  component: GameplayView,
});

const resultsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/results/$songId",
  component: ResultsView,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsView,
});

const calibrationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/calibration",
  component: CalibrationView,
});

const syncRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sync/$songId",
  component: SyncView,
});

const routeTree = rootRoute.addChildren([
  libraryRoute,
  gameplayRoute,
  resultsRoute,
  settingsRoute,
  calibrationRoute,
  syncRoute,
]);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Local IPC, not a network: refetching on window focus buys nothing and
      // would re-read the library every time the player alt-tabs back.
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

export const router = createRouter({
  routeTree,
  history: createMemoryHistory(),
  context: { queryClient },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

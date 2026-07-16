/**
 * Main process entry point.
 *
 * BOOTSTRAP ORDER IS LOAD-BEARING (CLAUDE.md → Architecture):
 *   1. `protocol.registerSchemesAsPrivileged` at MODULE SCOPE — Electron
 *      requires it before `app.whenReady()`. Moving it inside whenReady makes
 *      `song-audio://` a non-privileged scheme, which silently loses streaming
 *      and fetch support, and audio seeking breaks rather than errors.
 *   2. `nativeTheme.themeSource = "dark"` before any window exists — otherwise
 *      first paint flashes light.
 *   3. IPC handlers + `protocol.handle` before the first BrowserWindow — a
 *      window that loads before its handlers exist races them.
 */

import { fileURLToPath } from "node:url";
import * as path from "node:path";

import { app, BrowserWindow, Menu, nativeTheme, shell } from "electron";

import { logger } from "./logger.js";
import { registerHandlers, cleanupHandlers } from "./ipc/index.js";
import { registerSongAudioScheme, handleSongAudioRequests } from "./protocol/song-audio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 1. Privileged scheme (module scope — before app ready) ────────────
registerSongAudioScheme();

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    logger.debug("main", "Main window already exists, skipping creation");
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    title: "Drum Trainer",
    show: false,
    // Opaque, not vibrancy. Translucent vibrancy washes out to gray — see
    // CLAUDE.md → Conventions and PROGRESS.md → Failed approaches.
    backgroundColor: "#0a0a0f",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // External links go to the real browser, never to an in-app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  logger.info("main", "Main window created", { dev: !app.isPackaged });
}

function setupApplicationMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: "Drum Trainer",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "Command+,",
          // Every screen is an in-app route, so this navigates the existing
          // window rather than opening a second one.
          click: () => mainWindow?.webContents.send("nav:goto", "/settings"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]);
  Menu.setApplicationMenu(menu);
}

app.on("window-all-closed", () => {
  // macOS convention: the app stays alive with no windows.
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  else mainWindow?.show();
});

app.on("before-quit", () => {
  logger.info("main", "Quitting — releasing MIDI device");
  cleanupHandlers();
});

app.whenReady().then(() => {
  // ── 2. Force dark before any window exists ──────────────────────────
  nativeTheme.themeSource = "dark";

  // ── 3. Protocol handler + IPC before the window ─────────────────────
  handleSongAudioRequests();
  registerHandlers();

  setupApplicationMenu();
  createMainWindow();
});

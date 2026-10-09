import { BrowserWindow, app, dialog, ipcMain, session, shell } from 'electron';
import { join } from 'node:path';
import { closeDatabase, getDb, migrationResult, openDatabase } from './db/connection.js';
import { createBackup } from './services/backupService.js';
import { startUpdateChecks, stopUpdateChecks } from './services/updateService.js';
import { startSyncScheduler, stopSyncScheduler } from './services/syncScheduler.js';
import { registerAllOps } from './ipc/ops/index.js';
import { contentSecurityPolicy } from './security.js';
import { callOp, registeredOps } from './ipc/router.js';
import { clearSession } from './session.js';

/**
 * Main process entry point.
 *
 * Order matters here: the database is opened and migrated before any window
 * exists, so a schema problem shows the owner a clear dialog instead of a blank
 * screen with a console error nobody at the counter will ever read.
 */

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7f9',
    title: 'Al Hamza POS',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The renderer is treated as untrusted: no Node, no direct IPC surface,
      // no access to anything but the single bridged `call` function.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // Show only once painted, so the shop never sees a white flash on a slow PC.
  mainWindow.on('ready-to-show', () => mainWindow?.show());

  // Forward page errors into the main log. Without this, a renderer crash on the
  // shop PC leaves nothing behind to diagnose — the window simply goes blank.
  mainWindow.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      console.log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] process gone:', details.reason);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Anything trying to open a new window or navigate away goes to the system
  // browser instead. This app has exactly one page.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL'];
    if (!devServer || !url.startsWith(devServer)) event.preventDefault();
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function startDatabase(): boolean {
  try {
    openDatabase();
    const result = migrationResult();
    if (result && result.applied.length > 0) {
      console.log(
        `[db] migrated ${result.from} -> ${result.to}: ${result.applied.join(', ')}` +
          (result.backupPath ? ` (backup: ${result.backupPath})` : ''),
      );
    }
    return true;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    dialog.showErrorBox(
      'Al Hamza POS could not start',
      `The shop database could not be opened.\n\n${detail}\n\n` +
        `Do not reinstall or delete anything — the data is still on this computer. ` +
        `Show this message to whoever set up the system.`,
    );
    return false;
  }
}

// One instance only: two copies of the app writing to the same SQLite file is a
// corruption risk, and two counters open at once is a support call waiting to happen.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    if (!startDatabase()) {
      app.quit();
      return;
    }

    applyContentSecurityPolicy();
    void backupQuietly('startup');

    registerAllOps();
    console.log(`[ipc] ${registeredOps().length} operations registered`);

    ipcMain.handle('pos:call', async (_event, request: unknown) => {
      const { op, payload } = (request ?? {}) as { op?: unknown; payload?: unknown };
      return callOp(op, payload);
    });

    createWindow();
    startUpdateChecks();
    startSyncScheduler();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

/**
 * Lock the renderer down to its own bundled files.
 *
 * The page needs no network at all: fonts are bundled, data comes over IPC.
 * Applied as a response header rather than a meta tag so it also covers the
 * dev server, where a meta tag would break hot reloading.
 */
function applyContentSecurityPolicy(): void {
  // The dev server needs two relaxations the shipped app must not have; the
  // policy itself lives in security.ts, where both modes are covered by tests.
  const policy = contentSecurityPolicy(Boolean(process.env['ELECTRON_RENDERER_URL']));

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });
}

/**
 * Back up on the way in and on the way out.
 *
 * A failure here is logged and otherwise ignored: the shop must still be able
 * to open the till when the backup folder is full or on a disconnected drive.
 */
async function backupQuietly(reason: 'startup' | 'shutdown'): Promise<void> {
  try {
    const result = await createBackup(getDb(), reason);
    console.log(`[backup] ${reason}: ${result.name} (${Math.round(result.sizeBytes / 1024)} KB)`);
  } catch (cause) {
    console.error(`[backup] ${reason} backup failed:`, cause);
  }
}

let shuttingDown = false;

app.on('before-quit', (event) => {
  if (shuttingDown) return;

  // Take the closing backup before the database is shut. The quit is held back
  // for it, because a backup that runs after the connection closes is a backup
  // of nothing — and this is the copy that captures the day's takings.
  event.preventDefault();
  shuttingDown = true;

  stopUpdateChecks();
  stopSyncScheduler();

  void backupQuietly('shutdown').finally(() => {
    // Drop the session first: if the app is reopened, nobody is silently still
    // signed in as whoever used it last.
    clearSession();
    closeDatabase();
    app.exit(0);
  });
});

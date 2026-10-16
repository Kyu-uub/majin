/* Majin — desktop (Electron).
   This is the packaging layer, not a rewrite: it boots the exact same Express +
   tools.js server that `node server.js` runs, in-process, then shows the browser
   UI in a real native window with its own taskbar icon. One codebase, three ways
   to open it: the browser (Majin.vbs / --app=), `npm start`, or `npm run app`.

   Everything the assistant can do lives on the server; this file only owns the
   window (and lets the UI open independent second chats as extra windows). */
import { app, BrowserWindow, Menu, Tray, shell, dialog, session, desktopCapturer, screen, nativeImage } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { initAutoUpdater } from './updater.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Tray + lifecycle state shared across the window helpers below.
let tray = null;              // null until a tray is successfully created
let isQuitting = false;       // set only by the tray "Quit" (lets close-to-tray distinguish hide vs quit)
let primaryWin = null;        // the main chat window (the one that hides to tray on close)
let visionWin = null;         // the tray-opened Vision overlay (so we don't stack duplicates)
let appPort = Number(process.env.PORT) || 3000;
let updater = { checkNow() {} };

// Own taskbar / notification identity on Windows.
app.setAppUserModelId('com.majin.assistant');

// A single Majin, no matter how many times the icon is double-clicked.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { showMainWindow(); });
}

let PORT = Number(process.env.PORT) || 3000;

// Start the assistant server in-process (import runs server.js top-to-bottom,
// which binds 127.0.0.1:PORT). Fall back to a free port if 3000 is already taken
// by a browser-launched instance, so the desktop app never deadlocks against it.
async function bootServer() {
  // When installed, server.js lives in a read-only asar — keep its .env in AppData
  // so saved API keys/settings persist per user. In dev we leave it next to server.js.
  if (app.isPackaged) process.env.MAJIN_CONFIG_DIR = app.getPath('userData');
  if (await portFree(PORT)) {
    process.env.PORT = String(PORT);
  } else {
    PORT = await findFreePort(PORT);
    process.env.PORT = String(PORT);
  }
  await import('../server.js'); // side effect: express starts listening
  return PORT;
}

function portFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}
function findFreePort(from) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(findFreePort(from + 1)));
    srv.once('listening', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.listen(0, '127.0.0.1');
  });
}

async function waitForReady(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (r.ok) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 120));
  }
  return false;
}

function windowOpenRouter(win, port) {
  if (!win || !win.webContents || typeof win.webContents.setWindowOpenHandler !== 'function') return;
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (/^majin:close/i.test(url)) { try { win.close(); } catch (e) {} return { action: 'deny' }; }
      const u = new URL(url);
      if (u.protocol === 'http:' && u.hostname === '127.0.0.1') {
        if (/vision\.html/i.test(u.pathname) || /[?&]overlay=1/.test(u.search)) createWindow(port, { overlay: true });
        else createWindow(port);
        return { action: 'deny' };
      }
      shell.openExternal(url);
      return { action: 'deny' };
    } catch (_) {
      return { action: 'deny' };
    }
  });
}

function positionOverlay(win) {
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    const [w, h] = win.getSize();
    win.setBounds({
      x: Math.round(wa.x + (wa.width - w) / 2),
      y: Math.round(wa.y + wa.height - h - 16),
      width: w, height: h
    });
  } catch (e) {}
}

function createWindow(port, opts) {
  opts = opts || {};
  const isOverlay = !!opts.overlay;
  let ovW = 600;
  if (isOverlay) { try { ovW = Math.max(360, Math.min(600, screen.getPrimaryDisplay().workArea.width - 40)); } catch (e) {} }
  const win = new BrowserWindow({
    width: isOverlay ? ovW : 1280,
    height: isOverlay ? 440 : 860,
    minWidth: isOverlay ? 360 : 820,
    minHeight: isOverlay ? 120 : 560,
    title: isOverlay ? 'Majin Vision' : 'Majin',
    // A transparent window only paints where the page draws opaque pixels, so the
    // area around the bar / answer card stays click-through to whatever is beneath.
    backgroundColor: isOverlay ? '#00000000' : '#070b14',
    transparent: isOverlay,
    hasShadow: !isOverlay,
    icon: path.join(here, 'majin.ico'),
    show: false,
    autoHideMenuBar: true,
    frame: !isOverlay,
    // On Windows, frameless windows still draw a "thick frame" edge and Win11 rounds the
    // corners with a border line — both look like a box around a transparent overlay.
    thickFrame: !isOverlay,
    roundedCorners: !isOverlay,
    resizable: !isOverlay,
    maximizable: !isOverlay,
    fullscreenable: !isOverlay,
    alwaysOnTop: isOverlay,
    skipTaskbar: isOverlay,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  if (isOverlay) { try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (e) {} positionOverlay(win); }
  const target = isOverlay
    ? `http://127.0.0.1:${port}/vision.html`
    : `http://127.0.0.1:${port}/`;
  win.loadURL(target);
  let shown = false;
  const showWin = () => { if (shown) return; shown = true; if (isOverlay) positionOverlay(win); try { win.show(); } catch (e) {} };
  win.once('ready-to-show', showWin);
  try { win.webContents.once('did-finish-load', () => setTimeout(showWin, 120)); } catch (e) {}
  setTimeout(showWin, 1200);   // last-resort so a transparent overlay never hangs invisible
  windowOpenRouter(win, port);
  return win;
}

function showMainWindow() {
  try {
    if (primaryWin && !primaryWin.isDestroyed()) {
      if (primaryWin.isMinimized()) primaryWin.restore();
      if (!primaryWin.isVisible()) primaryWin.show();
      primaryWin.focus();
      return;
    }
  } catch (e) {}
  try { primaryWin = createWindow(appPort); attachCloseToTray(primaryWin); } catch (e) {}
}

function openVision() {
  try {
    if (visionWin && !visionWin.isDestroyed()) { visionWin.show(); visionWin.focus(); return; }
  } catch (e) {}
  try {
    visionWin = createWindow(appPort, { overlay: true });
    visionWin.on('closed', () => { visionWin = null; });
  } catch (e) {}
}

// The primary window hides to the tray instead of quitting when its ✕ is clicked —
// unless we're genuinely quitting (tray Quit) or no tray exists.
function attachCloseToTray(win) {
  if (!win) return;
  win.on('close', (e) => {
    if (!isQuitting && tray) { e.preventDefault(); try { win.hide(); } catch (x) {} }
  });
}

function createTray() {
  try {
    let img = nativeImage.createFromPath(path.join(here, 'majin.ico'));
    if (!img || img.isEmpty()) return;             // no usable icon → skip the tray (never crash)
    tray = new Tray(img);
    tray.setToolTip('Majin');
    const menu = Menu.buildFromTemplate([
      { label: 'Open Majin', click: () => showMainWindow() },
      { label: 'Vision pill', click: () => openVision() },
      { type: 'separator' },
      { label: 'Check for updates…', click: () => { try { updater.checkNow(); } catch (e) {} } },
      { type: 'separator' },
      { label: 'Quit Majin', click: () => { isQuitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(menu);
    tray.on('click', () => {
      try {
        const visible = primaryWin && !primaryWin.isDestroyed() && primaryWin.isVisible() && !primaryWin.isMinimized();
        if (visible) primaryWin.hide(); else showMainWindow();
      } catch (e) {}
    });
  } catch (e) {
    console.error('[tray] could not create:', (e && (e.message || e)));
    tray = null;
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  // Vision (screen share): two things are required in Electron.
  // 1) Grant the media/display-capture permissions (getUserMedia/getDisplayMedia).
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(['media', 'audioCapture', 'videoCapture', 'display-capture'].includes(permission));
  });
  // 2) Supply a capture source for getDisplayMedia(). Electron does NOT show a picker
  // on its own: the renderer's request calls this handler, and it MUST invoke callback
  // with a source or the getDisplayMedia() promise hangs forever. We hand back the
  // primary screen via desktopCapturer — the canonical, version-independent pattern.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
      .then(sources => {
        const screen = sources.find(s => s.display_id && s.display_id !== '') || sources[0];
        callback(screen ? { video: screen, audio: false } : {});
      })
      .catch(() => callback({}));
  });
  let port;
  try {
    port = await bootServer();
  } catch (e) {
    dialog.showErrorBox('Majin could not start', String((e && (e.stack || e.message)) || e));
    app.quit();
    return;
  }
  const ok = await waitForReady(port);
  if (!ok) {
    dialog.showErrorBox('Majin could not start',
      'The assistant server did not come online on 127.0.0.1:' + port +
      '.\nRun `npm install` once, then try again.');
    app.quit();
    return;
  }
  appPort = port;
  primaryWin = createWindow(port);
  attachCloseToTray(primaryWin);
  try { updater = await initAutoUpdater(); } catch (e) {}
  createTray();

  app.on('activate', () => {                 // macOS: reopen on dock click
    if (BrowserWindow.getAllWindows().length === 0) showMainWindow();
  });
});

app.on('before-quit', () => { isQuitting = true; });   // a real quit must not be blocked by close-to-tray

app.on('window-all-closed', () => {
  // With a tray present, closing every window keeps Majin reachable in the background.
  if (process.platform === 'darwin') return;
  if (tray && !isQuitting) return;
  app.quit();
});

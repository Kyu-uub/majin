/* Majin — auto-update (electron-updater).
   Only meaningful in a PACKAGED build: under `npm run app` there is no update feed and
   electron-updater throws, so everything is gated on app.isPackaged. The publish target
   (GitHub Releases or a generic URL) lives in package.json > build.publish; electron-builder
   writes an app-update.yml beside the installed app from it, and electron-updater reads
   that at runtime — so this file never hard-codes a host.

   Behaviour: check once a few seconds after boot, and let the tray re-check on demand. A
   found update downloads silently; a native notification then offers "restart to apply".
   Every path is defensive — a missing module or a failed check must never stop Majin. */
import { app, Notification } from 'electron';

// The handle main.js keeps and the tray menu calls. A no-op until we're packaged + wired.
let api = { checkNow() {} };

function notify(title, body, onClick) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body: body || '' });
    if (onClick) n.on('click', onClick);
    n.show();
  } catch (e) { /* notifications are best-effort */ }
}

export async function initAutoUpdater() {
  if (!app.isPackaged) return api;                 // dev: no feed, nothing to do
  let autoUpdater;
  try {
    // electron-updater is CommonJS; dynamic import keeps a missing/failing module from
    // taking down app startup. Named export or default.module.exports, both handled.
    const mod = await import('electron-updater');
    autoUpdater = mod && (mod.autoUpdater || (mod.default && mod.default.autoUpdater));
  } catch (e) {
    console.error('[updater] electron-updater unavailable:', (e && (e.message || e)));
    return api;
  }
  if (!autoUpdater) return api;

  let manual = false;                              // only surface "up to date" when the user asked
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', err => { console.error('[updater]', (err && (err.message || err))); });
  autoUpdater.on('update-available', () => notify('Majin update', 'Downloading the latest version…'));
  autoUpdater.on('update-not-available', () => { if (manual) notify('Majin is up to date', 'You are running the latest version.'); });
  autoUpdater.on('update-downloaded', () =>
    notify('Update ready', 'Restart Majin to apply it.', () => { try { autoUpdater.quitAndInstall(); } catch (e) {} }));

  api = { checkNow() { manual = true; try { autoUpdater.checkForUpdates(); } catch (e) {} } };
  setTimeout(() => { try { autoUpdater.checkForUpdatesAndNotify(); } catch (e) {} }, 8000);
  return api;
}

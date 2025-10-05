const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let musicWindow = null;

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function getStorePath() {
  const dir = path.join(app.getPath('userData'), 'geomusic');
  ensureDir(dir);
  return {
    dir,
    libraryDir: path.join(dir, 'library'),
    libraryIndex: path.join(dir, 'library.json')
  };
}
function readJsonArray(file) {
  if (!fs.existsSync(file)) return [];
  try { const raw = fs.readFileSync(file,'utf-8'); const j=JSON.parse(raw); return Array.isArray(j)?j:[]; }
  catch { return []; }
}
function writeJsonArray(file, arr) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf-8');
  return true;
}

function createMainWindow () {
  mainWindow = new BrowserWindow({
    width: 1260,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createMusicWindow() {
  if (musicWindow) { musicWindow.focus(); return; }
  musicWindow = new BrowserWindow({
    width: 560,
    height: 720,
    title: 'Music Library',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  musicWindow.loadFile('music.html');
  musicWindow.on('closed', () => { musicWindow = null; });
}

app.whenReady().then(() => {
  try {
    globalShortcut.register('CommandOrControl+L', () => {
      try { if (BrowserWindow.getFocusedWindow()) { createMusicWindow(); } else { createMusicWindow(); } } catch {}
    });
  } catch {}

  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// IPC for library
ipcMain.handle('open-music-window', () => { createMusicWindow(); return { ok: true }; });
ipcMain.handle('music-list', () => {
  const { libraryIndex } = getStorePath();
  return readJsonArray(libraryIndex);
});
ipcMain.handle('music-save', (evt, { id, name, ext, data }) => {
  const { libraryDir, libraryIndex } = getStorePath();
  ensureDir(libraryDir);
  let list = readJsonArray(libraryIndex);
  if (id && list.find(x => x.id === id)) {
    return { ok: true, id, filePath: list.find(x=>x.id===id).filePath };
  }
  const safeName = (name || 'track').replace(/[^\w\-. ]+/g, '_');
  const filename = `${(id || ('track_'+Date.now()))}_${safeName}.${ext || 'bin'}`;
  const filePath = path.join(libraryDir, filename);
  const buf = Buffer.from(data);
  fs.writeFileSync(filePath, buf);
  const entry = { id: id || path.parse(filename).name.split('_')[0], name: name || 'track', filePath, favorite: false, addedAt: new Date().toISOString() };
  list.unshift(entry);
  writeJsonArray(libraryIndex, list);
  return { ok: true, id: entry.id, filePath };
});
ipcMain.handle('music-delete', (evt, id) => {
  const { libraryIndex } = getStorePath();
  let list = readJsonArray(libraryIndex);
  const item = list.find(x => x.id === id);
  if (item && fs.existsSync(item.filePath)) {
    try { fs.unlinkSync(item.filePath); } catch {}
  }
  list = list.filter(x => x.id !== id);
  writeJsonArray(libraryIndex, list);
  return { ok: true };
});
ipcMain.handle('music-open', (evt, id) => {
  const { libraryIndex } = getStorePath();
  const item = readJsonArray(libraryIndex).find(x => x.id === id);
  if (!item) return { ok:false, error:'Not found' };
  return { ok:true, filePath: item.filePath, name: item.name, id: item.id };
});

ipcMain.handle('music-apply-to-selected', (evt, payload) => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('apply-track-to-selected', payload);
      return { ok: true };
    }
    return { ok:false, error:'Main window not available' };
  } catch (e) {
    return { ok:false, error: String(e) };
  }
});


const crypto = require('crypto');

function normalizeFileUrl(u) {
  try {
    // Use WHATWG URL for robust parsing
    const { URL } = require('url');
    const url = new URL(u.startsWith('file://') ? u : ('file://' + u));
    let p = url.pathname || '';
    // On Windows, pathname like /C:/path -> C:/path
    if (process.platform === 'win32' && p.startsWith('/')) p = p.slice(1);
    return decodeURIComponent(p);
  } catch {
    return u.replace(/^file:\/\//, '');
  }
}

function sha1FileSync(filePath) {
  const hash = crypto.createHash('sha1');
  const fs = require('fs');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

ipcMain.handle('music-save-path', (evt, { path: p, name }) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const { libraryDir, libraryIndex } = getStorePath();
    ensureDir(libraryDir);
    const list = readJsonArray(libraryIndex);
    const id = sha1FileSync(normalizeFileUrl(p));
    if (list.find(x => x.id === id)) return { ok:true, id };
    const ext = (path.extname(normalizeFileUrl(p)) || '.bin').slice(1);
    const safeName = (name || path.basename(p)).replace(/[^\w\-. ]+/g, '_').replace(/\.[^/.]+$/, '');
    const filename = `${id}_${safeName}.${ext}`;
    const dest = path.join(libraryDir, filename);
    fs.copyFileSync(normalizeFileUrl(p), dest);
    const entry = { id, name: safeName, filePath: dest, favorite:false, addedAt: new Date().toISOString() };
    writeJsonArray(libraryIndex, [entry, ...list]);
    return { ok:true, id };
  } catch (e) {
    return { ok:false, error: String(e) };
  }
});

ipcMain.handle('music-toggle-fav', (evt, id) => {
  const { libraryIndex } = getStorePath();
  const list = readJsonArray(libraryIndex);
  const it = list.find(x => x.id === id);
  if (!it) return { ok:false };
  it.favorite = !it.favorite;
  writeJsonArray(libraryIndex, list);
  return { ok:true, favorite: it.favorite };
});

app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });
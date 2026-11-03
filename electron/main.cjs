// Electron main process (Windows EXE shell): window, menu, native dialogs and
// the streaming ZIP writer the renderer exports into.

const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWindow = null;
/** file the OS asked us to open, delivered once the renderer is ready */
let pendingOpenFile = null;

// Headless self-test:
//   PSD-Combo-Exporter.exe --self-test <file.psd> [--self-test-export <dir>]
// Loads the real bundle, imports the PSD, optionally exports every
// combination as a ZIP into <dir>, prints a JSON report and exits.
const SELF_TEST = process.argv.includes('--self-test');
const SELF_TEST_EXPORT = process.argv.includes('--self-test-export');
let selfTestPath = null;
let selfTestOutDir = null;

const PSD_RE = /\.(psd|psb|ipv)$/i;

function readFilePayload(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return { name: path.basename(filePath), data: buf };
  } catch (err) {
    return { name: path.basename(filePath), error: String(err) };
  }
}

function sendOpenFile(filePath) {
  const payload = readFilePayload(filePath);
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingOpenFile = payload;
    return;
  }
  mainWindow.webContents.send('psd:open-file', payload);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

async function openDialog() {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '打开 PSD',
    filters: [{ name: 'PSD / 爱笔思画作品', extensions: ['psd', 'psb', 'ipv'] }],
    properties: ['openFile'],
  });
  if (!res.canceled && res.filePaths[0]) sendOpenFile(res.filePaths[0]);
}

const SELF_TEST_SCRIPT = (doExport) => `(async () => {
  const out = { electron: window.psdExportNative?.isElectron === true };
  const bytes = await window.psdExportNativeTestFile();
  if (!bytes) return out;
  const t0 = performance.now();
  await window.psdExportApp.importBuffer('self-test.psd', bytes);
  const app = window.psdExportApp;
  const s = app.state();
  out.import = { ms: Math.round(performance.now() - t0), size: [s.project.width, s.project.height], layers: s.project.layers.length, rules: s.project.rules.length };
  if (s.project.rules.length === 0) {
    // untagged PSD: build a small product from the first two groups with several children
    const groups = s.project.layers.filter((l) => l.kind === 'group' && l.children.length > 1).slice(0, 2);
    for (const g of groups) app.debug.ruleFromGroup(g.name, 'optional');
  }
  out.combos = app.state().result.combos.length;
  out.compare = await app.debug.compare();
  if (${doExport}) out.export = await app.debug.exportWithPlatformTarget();
  return out;
})()`;

function runSelfTest(win) {
  return new Promise((resolve) => {
    win.webContents.once('did-finish-load', async () => {
      try {
        const report = await win.webContents.executeJavaScript(SELF_TEST_SCRIPT(SELF_TEST_EXPORT));
        console.log('SELF_TEST ' + JSON.stringify(report));
        resolve(report.electron && (!report.export || report.export.ok) ? 0 : 1);
      } catch (err) {
        console.log('SELF_TEST_ERROR ' + String(err));
        resolve(1);
      }
    });
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  });
}

function createWindow(opts = {}) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e0e12',
    show: false,
    autoHideMenuBar: true,
    title: 'PSD 组合导出',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // keep timers running when hidden (headless self-test, long exports while minimised)
      backgroundThrottling: false,
    },
  });
  if (opts.show !== false) mainWindow.once('ready-to-show', () => mainWindow.show());
  if (!opts.noLoad) mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  return mainWindow;
}

/* ---------------- IPC bridge ---------------- */

ipcMain.handle('psd:self-test-file', async () => {
  if (!SELF_TEST || !selfTestPath) return null;
  const buf = fs.readFileSync(selfTestPath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle('psd:choose-zip', async (_e, suggestedName) => {
  const name = String(suggestedName || 'psd-export.zip').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  if (SELF_TEST && selfTestOutDir) return { ok: true, path: path.join(selfTestOutDir, name) };
  const res = await dialog.showSaveDialog(mainWindow, {
    title: '导出为 ZIP',
    defaultPath: path.join(app.getPath('pictures'), name),
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
    buttonLabel: '导出',
  });
  if (res.canceled || !res.filePath) return { ok: false, error: '已取消导出' };
  const file = /\.zip$/i.test(res.filePath) ? res.filePath : `${res.filePath}.zip`;
  return { ok: true, path: file };
});

ipcMain.handle('psd:choose-folder', async (_e, suggestedName) => {
  if (SELF_TEST && selfTestOutDir) return { ok: true, path: selfTestOutDir };
  const res = await dialog.showOpenDialog(mainWindow, {
    title: `选择导出文件夹${suggestedName ? `（${suggestedName}）` : ''}`,
    defaultPath: app.getPath('pictures'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return { ok: false, error: '已取消导出' };
  return { ok: true, path: res.filePaths[0] };
});

/* ---------------- config files ---------------- */

ipcMain.handle('psd:save-text', async (_e, suggestedName, text) => {
  try {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '保存配置',
      defaultPath: path.join(app.getPath('documents'), String(suggestedName || 'config.json')),
      filters: [{ name: '导出配置', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, error: '已取消' };
    fs.writeFileSync(res.filePath, String(text), 'utf8');
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('psd:open-text', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '导入配置',
    filters: [{ name: '导出配置', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return { ok: false };
  return { ok: true, name: path.basename(res.filePaths[0]), text: fs.readFileSync(res.filePaths[0], 'utf8') };
});

/* ---------------- streaming ZIP ---------------- */
// The renderer streams the archive in order, so the whole ZIP never has to be
// in memory. It is written to "<name>.part" and renamed when complete, so a
// cancelled or failed export never leaves a broken ZIP under the real name.

let archive = null; // { fd, path, tmp, bytes }
let folderExport = null; // { path, entries, bytes }

function closeArchive(remove) {
  if (!archive) return;
  try {
    fs.closeSync(archive.fd);
  } catch {
    /* ignore */
  }
  if (remove) {
    try {
      fs.unlinkSync(archive.tmp);
    } catch {
      /* ignore */
    }
  }
  archive = null;
}

ipcMain.handle('psd:begin-archive', async (_e, target) => {
  try {
    closeArchive(true);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.part`;
    const fd = fs.openSync(tmp, 'w');
    archive = { fd, path: target, tmp, bytes: 0 };
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('psd:append-archive', async (_e, chunk) => {
  try {
    if (!archive) return { ok: false, error: '压缩包未打开' };
    const buf = Buffer.from(chunk.buffer ?? chunk, chunk.byteOffset ?? 0, chunk.byteLength ?? chunk.length);
    fs.writeSync(archive.fd, buf);
    archive.bytes += buf.length;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('psd:finish-archive', async () => {
  try {
    if (!archive) return { ok: false, error: '压缩包未打开' };
    fs.closeSync(archive.fd);
    fs.rmSync(archive.path, { force: true });
    fs.renameSync(archive.tmp, archive.path);
    const done = { path: archive.path, bytes: archive.bytes };
    archive = null;
    return { ok: true, ...done };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('psd:abort-archive', async () => {
  closeArchive(true);
  return { ok: true };
});

function safeFolderPath(root, relative) {
  const parts = String(relative || '').replace(/\\/g, '/').split('/').filter((p) => p && p !== '.' && p !== '..');
  if (!parts.length) throw new Error('导出文件名为空');
  const target = path.resolve(root, ...parts);
  const base = path.resolve(root) + path.sep;
  if (!target.startsWith(base)) throw new Error('导出路径无效');
  return target;
}

ipcMain.handle('psd:begin-folder', async (_e, target) => {
  try {
    if (!target) return { ok: false, error: '未选择导出文件夹' };
    if (folderExport) folderExport = null;
    fs.mkdirSync(target, { recursive: true });
    folderExport = { path: path.resolve(target), entries: 0, bytes: 0 };
    return { ok: true, path: folderExport.path };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('psd:write-folder-file', async (_e, relative, data) => {
  try {
    if (!folderExport) return { ok: false, error: '导出文件夹未打开' };
    const target = safeFolderPath(folderExport.path, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const buf = Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
    fs.writeFileSync(target, buf);
    folderExport.entries++;
    folderExport.bytes += buf.length;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('psd:finish-folder', async () => {
  if (!folderExport) return { ok: false, error: '导出文件夹未打开' };
  const done = { path: folderExport.path, entries: folderExport.entries, bytes: folderExport.bytes };
  folderExport = null;
  return { ok: true, ...done };
});

ipcMain.handle('psd:abort-folder', async () => {
  folderExport = null;
  return { ok: true };
});

ipcMain.handle('psd:reveal-folder', async (_e, folder) => {
  if (SELF_TEST) return true;
  if (folder && fs.existsSync(folder)) shell.openPath(folder);
  return true;
});

ipcMain.handle('psd:reveal-file', async (_e, file) => {
  if (SELF_TEST) return true; // never pop Explorer during a headless run
  if (file && fs.existsSync(file)) shell.showItemInFolder(file);
  return true;
});

ipcMain.on('psd:ready', () => {
  if (pendingOpenFile) {
    mainWindow?.webContents.send('psd:open-file', pendingOpenFile);
    pendingOpenFile = null;
  }
});

/* ---------------- menu ---------------- */

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [
          { label: '打开 PSD…', accelerator: 'CmdOrCtrl+O', click: openDialog },
          { type: 'separator' },
          { role: 'quit', label: '退出' },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '重新载入' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '全屏' },
        ],
      },
    ]),
  );
}

/* ---------------- lifecycle ---------------- */

const gotLock = SELF_TEST || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const file = argv.find((a) => PSD_RE.test(a));
    if (file && fs.existsSync(file)) sendOpenFile(file);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.cromachina.psdexport');
    buildMenu();

    if (SELF_TEST) {
      const target = process.argv[process.argv.indexOf('--self-test') + 1];
      selfTestPath = target && fs.existsSync(target) ? target : null;
      const outIdx = process.argv.indexOf('--self-test-export');
      if (outIdx >= 0) {
        selfTestOutDir = process.argv[outIdx + 1] || null;
        if (selfTestOutDir) fs.mkdirSync(selfTestOutDir, { recursive: true });
      }
      const win = createWindow({ show: false, noLoad: true });
      runSelfTest(win).then((code) => app.exit(code));
      return;
    }

    const fileArg = process.argv.slice(1).find((a) => PSD_RE.test(a) && fs.existsSync(a));
    if (fileArg) pendingOpenFile = readFilePayload(fileArg);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

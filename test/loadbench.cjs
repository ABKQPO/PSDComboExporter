// Import timing breakdown:  electron test/loadbench.cjs <file> [workers]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const [file, workers = ''] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(__dirname, '..', 'electron', 'preload.cjs') } });
  const kill = setTimeout(() => (console.log('TIMEOUT'), app.exit(3)), 200000);
  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  await win.webContents.executeJavaScript(`localStorage.clear(); ${workers ? `window.__psdForceLanes = { workers: ${Number(workers)}, encoders: 1 };` : ''}`);
  const b64 = fs.readFileSync(file).toString('base64');
  const res = await win.webContents.executeJavaScript(`(async () => {
    const bin = atob(${JSON.stringify(b64)}); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await window.psdExportApp.importBuffer(${JSON.stringify(path.basename(file))}, bytes.buffer);
    const s = window.__psdLoadStats;
    return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Math.round(v)]));
  })()`);
  clearTimeout(kill);
  console.log(`${path.basename(file)} workers=${workers || 'default'}`, JSON.stringify(res));
  app.exit(0);
});

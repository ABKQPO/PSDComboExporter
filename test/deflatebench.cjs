// electron test/deflatebench.cjs <file> : deflate back ends + filter on real pictures
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(__dirname, '..', 'electron', 'preload.cjs') } });
  const kill = setTimeout(() => (console.log('TIMEOUT'), app.exit(3)), 200000);
  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  await win.webContents.executeJavaScript('localStorage.clear()');
  const b64 = fs.readFileSync(file).toString('base64');
  const res = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const bin = atob(${JSON.stringify(b64)}); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const app = window.psdExportApp;
    await app.importBuffer(${JSON.stringify(path.basename(file))}, bytes.buffer);
    const s = app.state();
    for (let i = 0; i < 100 && (s.previewBusy || !s.previewSize); i++) await sleep(100);
    app.debug.applySuggest();
    await sleep(500);
    try { return await app.debug.deflateBench(3); } catch (e) { return { error: String(e && e.stack || e) }; }
  })()`);
  clearTimeout(kill);
  console.log('BENCH ' + path.basename(file), JSON.stringify(res));
  app.exit(0);
});

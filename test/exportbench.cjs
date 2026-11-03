// Export speed + exactness, simulating a phone (1 render worker [+ 1 encoder]):
//   electron test/exportbench.cjs <file> [--old]   (--old = no encoder worker)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const old = process.argv.includes('--old');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(__dirname, '..', 'electron', 'preload.cjs') } });
  const kill = setTimeout(() => (console.log('TIMEOUT'), app.exit(3)), 400000);
  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  await win.webContents.executeJavaScript(`localStorage.clear(); window.__psdForceLanes = ${process.env.DESK ? 'undefined' : `{ workers: ${Number(process.env.WK || 1)}, encoders: ${old ? 0 : Number(process.env.ENC || 1)} }`};`);
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
    const out = { combos: s.result.combos.length };
    if (!${old}) out.exact = await app.debug.exportExactCheck(8);
    out.perImage = await app.debug.exportTiming(4);
    const t0 = performance.now();
    const z = await app.debug.exportZipInMemory(20);
    out.zip20 = { seconds: +((performance.now() - t0) / 1000).toFixed(1), entries: z && z.entries };
    return out;
  })()`);
  clearTimeout(kill);
  console.log((old ? 'OLD ' : 'NEW ') + path.basename(file), JSON.stringify(res));
  app.exit(0);
});

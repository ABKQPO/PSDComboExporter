// Main-thread responsiveness of common clicks:  electron test/perf.cjs <file> [width]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const [file, w = '1280'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: Number(w), height: 844, webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(__dirname, '..', 'electron', 'preload.cjs') } });
  const kill = setTimeout(() => (console.log('TIMEOUT'), app.exit(3)), 90000);
  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  await win.webContents.executeJavaScript('localStorage.clear()');
  const run = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
  const b64 = fs.readFileSync(file).toString('base64');
  const res = await run(`
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const bin = atob(${JSON.stringify(b64)}); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const app = window.psdExportApp;
    await app.importBuffer(${JSON.stringify(path.basename(file))}, bytes.buffer);
    const s = app.state();
    for (let i = 0; i < 100 && (s.previewBusy || !s.previewSize); i++) await sleep(100);
    const big = ${JSON.stringify(process.argv.includes('--all'))};
    const sug = big ? app.debug.applyAllSuggest() : null;
    if (!big) for (const g of s.project.layers.filter((l) => l.kind === 'group' && l.children.length > 1).slice(0, 3)) app.debug.ruleFromGroup(g.name, 'exclusive');
    await sleep(1500);
    const t0 = performance.now(); const r = await app.debug.perfCheck(); r.combos = s.result.combos.length; r.raw = s.result.rawCount; r.truncated = s.result.truncated; return r;
  `);
  clearTimeout(kill);
  console.log(path.basename(file), JSON.stringify(res));
  app.exit(0);
});

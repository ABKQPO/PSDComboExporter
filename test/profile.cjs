// CPU profile of one click on a phone-like (throttled) renderer.
//   electron test/profile.cjs <file> <dist-dir> [cpuSlowdown=6] [selector=.tree-row]
// Prints wall time until the UI updated and the top functions by self time.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [file, dist = 'dist', rate = '6', selector = '.tree-row'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: process.argv.includes('--show'), x: 0, y: 0, width: 390, height: 844, webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(__dirname, '..', 'electron', 'preload.cjs') } });
  const kill = setTimeout(() => (console.log('TIMEOUT'), app.exit(3)), 150000);
  await win.loadFile(path.join(__dirname, '..', dist, 'index.html'));
  await win.webContents.executeJavaScript('localStorage.clear()');
  const run = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
  const b64 = fs.readFileSync(file).toString('base64');
  await run(`
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const bin = atob(${JSON.stringify(b64)}); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const app = window.psdExportApp;
    await app.importBuffer(${JSON.stringify(path.basename(file))}, bytes.buffer);
    const s = app.state();
    for (let i = 0; i < 100 && (s.previewBusy || !s.previewSize); i++) await sleep(100);
    if (${JSON.stringify(process.argv.includes('--all'))}) { app.debug.applyAllSuggest(); await sleep(1500); }
    app.debug.openTab('layers');
    await sleep(800);
  `);
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Profiler.enable');
  await dbg.sendCommand('Profiler.setSamplingInterval', { interval: 200 });
  if (process.argv.includes('--dpr3')) {
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await dbg.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true });
    await new Promise((r) => setTimeout(r, 1500));
  }
  await dbg.sendCommand('Emulation.setCPUThrottlingRate', { rate: Number(rate) });
  await dbg.sendCommand('Profiler.start');
  const trace = [];
  dbg.on('message', (_e, method, params) => {
    if (method === 'Tracing.dataCollected') trace.push(...params.value);
  });
  const traceDone = new Promise((r) => dbg.on('message', (_e, method) => method === 'Tracing.tracingComplete' && r()));
  await dbg.sendCommand('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
  const res = await run(`
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { error: 'no element' };
    const before = document.querySelector('.tab-panel');
    const t0 = performance.now();
    el.click();
    const sync = performance.now() - t0;
    // updated = the panel was rebuilt (or the row changed)
    for (let i = 0; i < 2000 && document.querySelector('.tab-panel') === before && !el.classList.contains('checked'); i++) await sleep(5);
    const ui = performance.now() - t0;
    // two painted frames after the update
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const painted = performance.now() - t0;
    await sleep(1500);
    return { sync: Math.round(sync), ui: Math.round(ui), painted: Math.round(painted) };
  `);
  const { profile } = await dbg.sendCommand('Profiler.stop');
  await dbg.sendCommand('Tracing.end');
  await traceDone;
  const phases = new Map();
  for (const e of trace) if (e.ph === 'X' && e.dur) phases.set(e.name, (phases.get(e.name) || 0) + e.dur / 1000);
  console.log('trace phases (ms, nested phases overlap):');
  for (const [k, ms] of [...phases.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`  ${ms.toFixed(0).padStart(6)}  ${k}`);
  await dbg.sendCommand('Emulation.setCPUThrottlingRate', { rate: 1 });
  // self time per function
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]);
    const f = n.callFrame;
    const key = `${f.functionName || '(anon)'} ${path.basename(f.url || '')}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + (dt[i] || 0) / 1000);
  }
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log(`click ${selector}: sync ${res.sync} ms, UI updated after ${res.ui} ms, painted after ${res.painted} ms (CPU ×${rate})`, res.error || '');
  for (const [k, ms] of top) console.log(`  ${ms.toFixed(0).padStart(6)} ms  ${k}`);
  clearTimeout(kill);
  app.exit(0);
});

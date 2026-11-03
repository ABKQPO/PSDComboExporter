// Generic UI smoke test for any PSD files, in the real Electron renderer:
//   electron test/smoke.cjs <file.psd>...
// Imports each file, waits for the preview, makes an option group from the
// first group, previews and exports one combination, and fails on any error
// toast ("preview failed" etc.) or console error.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const files = process.argv.slice(2).filter((f) => /\.(psd|psb|ipv)$/i.test(f));
if (!files.length) {
  console.error('usage: electron test/smoke.cjs <file.psd>...');
  process.exit(2);
}

app.disableHardwareAcceleration();
// windows are opened and closed per file; don't quit in between
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  let failed = 0;
  for (const file of files) {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 860,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(__dirname, '..', 'electron', 'preload.cjs') },
    });
    const errors = [];
    win.webContents.on('console-message', (_e, level, msg) => {
      if (level >= 3) errors.push(msg);
    });
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    await win.webContents.executeJavaScript('localStorage.clear()');
    const run = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
    const b64 = fs.readFileSync(file).toString('base64');
    const t0 = Date.now();
    let res;
    try {
      res = await run(`
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const seen = [];
        const watch = setInterval(() => { for (const t of document.querySelectorAll('.toast.bad')) seen.push(t.textContent); }, 50);
        const bin = atob(${JSON.stringify(b64)}); const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const app = window.psdExportApp;
        await app.importBuffer(${JSON.stringify(path.basename(file))}, bytes.buffer);
        const s = app.state();
        if (!s.project) { clearInterval(watch); return { ok: false, seen }; }
        for (let i = 0; i < 100 && (s.previewBusy || !s.previewSize); i++) await sleep(100);
        const g = s.project.layers.find((l) => l.kind === 'group' && l.children.length > 1);
        if (g) app.debug.ruleFromGroup(g.name, 'optional');
        for (let i = 0; i < 100 && (s.previewBusy || !s.previewSize); i++) await sleep(100);
        const combos = s.result.combos.length;
        const sel = app.debug.selectionCheck();
        const selectionOk = sel.full === sel.total && sel.minusOne === Math.max(0, sel.total - 1) && sel.inverted === Math.min(1, sel.total) && sel.restored === sel.total;
        const sug = app.debug.applySuggest();
        for (let i = 0; i < 100 && (s.previewBusy || !s.previewSize); i++) await sleep(100);
        const feat = await app.debug.featureCheck();
        feat.suggest = sug;
        if (sug.applied && !(sug.got > 0 && sug.got <= sug.expected)) feat.ok = false;
        // exported PNGs (pipeline + reused tiles) must equal a fresh full render
        const eye = await app.debug.eyeOptionCheck();
        feat.eyeOption = eye;
        if (!eye.skipped && (!eye.switched || eye.insideOk === false)) feat.ok = false;
        const ex = await app.debug.exportExactCheck(3);
        feat.exact = ex.identical + '/' + ex.checked;
        if (ex.identical !== ex.checked) feat.ok = false;
        const png = combos ? await app.debug.exportPng(0) : null;
        await sleep(300);
        clearInterval(watch);
        return { ok: selectionOk && feat.ok, selection: selectionOk ? 'ok' : sel, feat, profile: s.calibration && s.calibration.profile, firstLayer: s.project.layers[0].cleanName, layers: s.project.layers.length, size: [s.project.width, s.project.height], preview: s.previewSize, combos, pngBytes: png ? png.length : 0, seen: [...new Set(seen)] };
      `);
    } catch (err) {
      res = { ok: false, error: String(err) };
    }
    const good = res.ok && res.preview && res.seen.length === 0 && errors.length === 0 && (!res.combos || res.pngBytes > 0);
    if (!good) failed++;
    console.log(`${good ? 'ok  ' : 'FAIL'} ${path.basename(file)} ${((Date.now() - t0) / 1000).toFixed(1)}s ${JSON.stringify({ ...res, consoleErrors: errors.slice(0, 3) })}`);
    win.destroy();
  }
  console.log(failed ? `${failed} file(s) failed` : 'all files passed');
  app.exit(failed ? 1 : 0);
});

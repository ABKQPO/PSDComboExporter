// Node editor under Android-like mobile emulation (viewport meta, text autosizing, DPR):
//   electron test/nodes-mobile.cjs <file> <outDir>
// Measures edges in SCREEN space through the SVG's own CTM and takes screenshots.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [file, outDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!process.argv.includes('--gpu')) app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
console.log('start', file, outDir);
app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const kill = setTimeout(() => (console.log('TIMEOUT'), app.exit(3)), 90000);
  const W = 390;
  const H = 860;
  const win = new BrowserWindow({
    show: true,
    x: 0,
    y: 0,
    width: W,
    height: H,
    useContentSize: true,
    webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(__dirname, '..', 'electron', 'preload.cjs') },
  });
  console.log('loading');
  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  await win.webContents.executeJavaScript('localStorage.clear()');
  win.webContents.enableDeviceEmulation({ screenPosition: 'mobile', screenSize: { width: W, height: H }, viewSize: { width: W, height: H }, deviceScaleFactor: 2.19, scale: 1 });
  console.log('emulating');
  await win.webContents.reload();
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  const b64 = fs.readFileSync(file).toString('base64');
  const measure = `(() => {
    const out = []; const svg = document.querySelector('.ne-edges');
    const ctm = svg.getScreenCTM();
    for (const p of svg.querySelectorAll('path.ne-edge')) {
      const L = p.getTotalLength(); const a = p.getPointAtLength(0); const b = p.getPointAtLength(L);
      const sa = new DOMPoint(a.x, a.y).matrixTransform(ctm); const sb = new DOMPoint(b.x, b.y).matrixTransform(ctm);
      const c = (k) => { const e = document.querySelector('[data-port="' + k + '"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
      const pa = c(p.dataset.from); const pb = c(p.dataset.to);
      if (!pa || !pb) continue;
      out.push({ e: p.dataset.from + '>' + p.dataset.to, da: Math.round(Math.hypot(sa.x - pa.x, sa.y - pa.y)), db: Math.round(Math.hypot(sb.x - pb.x, sb.y - pb.y)) });
    }
    const n = document.querySelector('.ne-node');
    return { dpr: devicePixelRatio, iw: innerWidth, vv: visualViewport && visualViewport.scale, fs: getComputedStyle(n).fontSize, maxErr: Math.max(0, ...out.map((o) => Math.max(o.da, o.db))), bad: out.filter((o) => o.da > 2 || o.db > 2).slice(0, 6) };
  })()`;
  const res = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const bin = atob(${JSON.stringify(b64)}); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const app = window.psdExportApp;
    await app.importBuffer(${JSON.stringify(path.basename(file))}, bytes.buffer);
    const s = app.state();
    for (let i = 0; i < 100 && (s.previewBusy || !s.previewSize); i++) await sleep(100);
    app.debug.applySuggest();
    await sleep(300);
    app.debug.openNodes();
    await sleep(900);
    return ${measure};
  })()`);
  console.log('suggested', JSON.stringify(res));
  fs.writeFileSync(path.join(outDir, 'm-suggested.png'), (await win.webContents.capturePage()).toPNG());
  // the user's case: a fresh project, two new groups, a folder dropped into one
  const res2 = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = window.psdExportApp;
    app.debug.userCase();
    await sleep(900);
    return ${measure};
  })()`);
  console.log('usercase', JSON.stringify(res2));
  fs.writeFileSync(path.join(outDir, 'm-usercase.png'), (await win.webContents.capturePage()).toPNG());
  clearTimeout(kill);
  app.exit(0);
}).catch((e) => (console.log("ERR", e && e.stack || e), app.exit(2)));

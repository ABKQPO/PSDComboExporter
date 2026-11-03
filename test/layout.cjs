// Phone layout check: opens a file at phone width, visits every tab and
// reports elements that stick out past the right edge; saves screenshots.
//   electron test/layout.cjs <file> <outDir> [width]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [file, outDir, w = '390'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const width = Number(w);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width,
    height: 844,
    useContentSize: true,
    webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(__dirname, '..', 'electron', 'preload.cjs') },
  });
  const kill = setTimeout(() => (console.log('TIMEOUT'), app.exit(3)), 90000);
  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  await win.webContents.executeJavaScript('localStorage.clear()');
  await win.webContents.insertCSS('*{transition:none!important;animation:none!important}.toasts{display:none!important}');
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
    const g = s.project.layers.find((l) => l.kind === 'group' && l.children.length > 1);
    if (g) app.debug.ruleFromGroup(g.name, 'optional');
    app.debug.addMutex({ kind: 'layer' }, { kind: 'layer' });
    await sleep(500);
  `);
  const g = await run('return window.psdExportApp.debug.gestureCheck()');
  // translate(-50%,-50%) is part of the matrix: compare the pan relative to the reset position
  const gOk = Math.abs(g.pan[0] - g.reset.x - 40) <= 1 && Math.abs(g.pan[1] - g.reset.y - 30) <= 1 && Math.abs(g.pinch.zoom - 2) < 0.02 && Math.abs(g.pinch.angle - 30) < 0.5 && g.reset.zoom === 1 && g.reset.angle === 0;
  console.log(`${gOk ? 'ok      ' : 'GESTURE '} gestures ${JSON.stringify(g)}`);
  fs.mkdirSync(outDir, { recursive: true });
  let bad = gOk ? 0 : 1;
  for (const tab of ['', 'layers', 'rules', 'constraints', 'combos', 'export']) {
    const res = await run(`
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const app = window.psdExportApp;
      if (${JSON.stringify(tab)}) app.debug.openTab(${JSON.stringify(tab)});
      if (${JSON.stringify(tab)} === 'layers') {
        app.debug.expandPart('鱼尾');
        await sleep(200);
        const fish = [...document.querySelectorAll('.tree-row')].find((r) => r.textContent.includes('鱼尾'));
        if (fish) fish.scrollIntoView({ block: 'start' });
      }
      await sleep(400);
      const W = document.documentElement.clientWidth;
      const out = [];
      const scrollW = document.documentElement.scrollWidth;
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (!r.width || r.right <= W + 1) continue;
        // only report the outermost offender
        const p = el.parentElement && el.parentElement.getBoundingClientRect();
        if (p && p.right > W + 1) continue;
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' && cs.transform !== 'none' && r.left >= W) continue; // off-screen sheet
        out.push(el.tagName.toLowerCase() + '.' + [...el.classList].join('.') + ' right=' + Math.round(r.right) + ' w=' + Math.round(r.width) + ' "' + (el.textContent || '').trim().slice(0, 40) + '"');
      }
      return { W, scrollW, panelScrollW: (document.querySelector('.tab-panel') || {}).scrollWidth, out: out.slice(0, 12) };
    `);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${tab || 'main'}-${width}.png`), img.toPNG());
    if (res.out.length || res.scrollW > res.W) bad++;
    console.log(`${res.out.length || res.scrollW > res.W ? 'OVERFLOW' : 'ok      '} ${tab || 'main'} W=${res.W} scrollW=${res.scrollW} panel=${res.panelScrollW}`);
    for (const o of res.out) console.log('    ' + o);
  }
  clearTimeout(kill);
  console.log(bad ? `${bad} view(s) overflow` : 'layout ok');
  app.exit(bad ? 1 : 0);
});

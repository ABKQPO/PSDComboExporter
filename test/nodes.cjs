// Node editor check + screenshots:  electron test/nodes.cjs <file> <outDir>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [file, outDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const kill = setTimeout(() => (console.log('TIMEOUT'), app.exit(3)), 190000);
  let bad = 0;
  for (const width of [1280, 390]) {
    const win = new BrowserWindow({
      show: process.argv.includes('--shot'),
      x: 0,
      y: 0,
      width,
      height: 844,
      useContentSize: true,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(__dirname, '..', 'electron', 'preload.cjs') },
    });
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    await win.webContents.executeJavaScript('localStorage.clear()');
    await win.webContents.insertCSS('*{transition:none!important}.toasts{display:none!important}');
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
      await sleep(400);
      if (${JSON.stringify(process.argv.includes('--shot'))}) {
        app.debug.applyAllSuggest();
        await sleep(400);
        s.nodeEditorOpen = true;
        app.debug.openTab('rules');
        s.sheetOpen = false;
        await sleep(600);
        document.querySelector('.ne-bar .btn[title^="打开图层列表"]').click();
        await sleep(600);
        return { ok: true, shot: true };
      }
      try {
        const a = await app.debug.nodeEditorCheck();
        const b = await app.debug.nodeExtrasCheck();
        return { ...a, extras: b, ok: !!(a.ok && b.ok) };
      } catch (e) {
        return { ok: false, error: String(e && e.stack || e) };
      }
    })()`);
    // hidden windows don't repaint by themselves: force a fresh frame
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 600));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `nodes-${width}.png`), img.toPNG());
    if (!res.ok) bad++;
    console.log(`${res.ok ? 'ok  ' : 'FAIL'} ${width}px ${JSON.stringify(res)}`);
    win.destroy();
  }
  clearTimeout(kill);
  app.exit(bad ? 1 : 0);
});

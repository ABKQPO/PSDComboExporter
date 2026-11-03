// Dump a document's layer tree as the app sees it:  electron test/tree.cjs <file>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(__dirname, '..', 'electron', 'preload.cjs') } });
  const kill = setTimeout(() => (console.log('TIMEOUT'), app.exit(3)), 60000);
  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  await win.webContents.executeJavaScript('localStorage.clear()');
  const b64 = fs.readFileSync(file).toString('base64');
  const out = await win.webContents.executeJavaScript(`(async () => { try {
    const bin = atob(${JSON.stringify(b64)}); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const app = window.psdExportApp;
    await app.importBuffer(${JSON.stringify(path.basename(file))}, bytes.buffer);
    return app.debug.dumpTree();
  } catch (e) { return 'ERR ' + e.stack; } })()`);
  clearTimeout(kill);
  fs.writeFileSync(process.argv[process.argv.length - 1].endsWith('.txt') ? process.argv[process.argv.length - 1] : 'tree.txt', out);
  app.exit(0);
});

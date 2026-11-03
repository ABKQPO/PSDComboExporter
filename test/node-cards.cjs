// Node card title-plate check + screenshot.
//   electron test/node-cards.cjs <psd> <outDir>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [psd, outDir = path.join(__dirname, '..', 'test-out', 'nodes')] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    useContentSize: true,
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  await sleep(300);

  const ok = [];
  const bad = [];
  const check = (name, cond, detail) => {
    (cond ? ok : bad).push(name);
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ' -> ' + JSON.stringify(detail) : ''}`);
  };

  if (psd && fs.existsSync(psd)) {
    const b64 = JSON.stringify(fs.readFileSync(psd).toString('base64'));
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const bin = atob(${b64});
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await window.psdExportApp.importBuffer('demo.psd', bytes.buffer);
      await sleep(2200);
      const dbg = window.psdExportApp.debug;
      if (dbg.ruleFromGroup) {
        const groups = window.psdExportApp.state().project.layers
          .filter((l) => l.kind === 'group' && l.children.length >= 2)
          .slice(0, 4);
        for (const g of groups) dbg.ruleFromGroup(g.name, 'optional');
      }
      await sleep(900);
    })()`);
  }
  await sleep(600);

  const report = await win.webContents.executeJavaScript(`(() => {
    const nodes = [...document.querySelectorAll('.ne-node')];
    const samples = nodes.slice(0, 12).map((n) => {
      const head = n.querySelector(':scope > .ne-head');
      const card = n.getBoundingClientRect();
      const hr = head ? head.getBoundingClientRect() : null;
      const cs = head ? getComputedStyle(head) : null;
      return {
        cls: n.className.replace('ne-node', '').trim(),
        hasHead: !!head,
        radius: cs ? cs.borderRadius : null,
        shadow: cs ? cs.boxShadow !== 'none' : null,
        headNearTop: hr ? hr.top < card.top + card.height / 2 : null,
      };
    });
    const withHead = nodes.filter((n) => n.querySelector(':scope > .ne-head')).length;
    return {
      editorVisible: !!document.querySelector('.node-editor'),
      totalNodes: nodes.length,
      nodesWithHead: withHead,
      samples,
      platesRounded: samples.every((s) => !s.hasHead || s.radius !== '0px'),
      platesShadowed: samples.every((s) => !s.hasHead || s.shadow === true),
    };
  })()`);

  console.log(JSON.stringify(report, null, 1));
  check('node editor is open by default', report.editorVisible === true);
  check('every card has a title plate', report.totalNodes > 0 && report.nodesWithHead === report.totalNodes, {
    nodes: report.totalNodes,
    withHead: report.nodesWithHead,
  });
  check('plates are rounded', report.platesRounded === true);
  check('plates drop a shadow', report.platesShadowed === true);
  check('plates sit at the top of the card', report.samples.every((s) => !s.hasHead || s.headNearTop === true));

  fs.mkdirSync(outDir, { recursive: true });
  await win.webContents.executeJavaScript(
    'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))',
  );
  await sleep(500);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'node-editor.png'), img.toPNG());
  console.log('  saved ' + path.join(outDir, 'node-editor.png'));

  console.log(`\n${bad.length === 0 ? 'PASS' : 'FAIL'}  ${ok.length} passed, ${bad.length} failed\n`);
  app.exit(bad.length === 0 ? 0 : 1);
});

app.on('window-all-closed', () => app.quit());

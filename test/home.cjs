// Home screen check: renders the start view at desktop and phone widths,
// reports layout facts and saves screenshots.
//   electron test/home.cjs <psd> <outDir>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [psd, outDir = path.join(__dirname, '..', 'test-out')] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
app.disableHardwareAcceleration();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win = null;

async function open(width, height) {
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      webPreferences: { contextIsolation: true, backgroundThrottling: false },
    });
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    await sleep(300);
  } else {
    win.setContentSize(width, height);
  }
  await sleep(150);
}

/** Seed history, go back to the home screen, measure and screenshot. */
async function shoot(width, height, name, opts) {
  await open(width, height);
  const b64 = psd ? JSON.stringify(fs.readFileSync(psd).toString('base64')) : '""';
  await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    localStorage.clear();
    ${opts.seed ? `
      const bin = atob(${b64});
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await window.psdExportApp.importBuffer('示例.psd', bytes.buffer);
      await sleep(1900);
      const st = window.psdExportApp.state();
      const base = st.recent[0];
      st.recent = Array.from({ length: ${opts.seed} }, (_, i) => ({
        ...base,
        key: base.key + '-seed-' + i,
        name: 'variant-' + (i + 1) + '.psd',
        openedAt: Date.now() - i * 3600000,
      }));
      st.prefs.recentCount = ${opts.limit};
      localStorage.setItem('psd-export:recent', JSON.stringify(st.recent));
      window.psdExportApp.debug.closeToHome();
    ` : `
      window.psdExportApp.debug.closeToHome();
    `}
    await sleep(400);
  })()`);
  await sleep(250);

  const report = await win.webContents.executeJavaScript(`(() => {
    const W = document.documentElement.clientWidth;
    const home = document.querySelector('.home');
    const list = document.querySelector('.home-list');
    const items = document.querySelectorAll('.recent-item');
    const brand = document.querySelector('.home-brand');
    const recentCol = document.querySelector('.home-recent');
    const over = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || r.right <= W + 1) continue;
      const p = el.parentElement && el.parentElement.getBoundingClientRect();
      if (p && p.right > W + 1) continue;
      over.push((el.className || el.tagName) + ' right=' + Math.round(r.right));
    }
    const br = brand && brand.getBoundingClientRect();
    const rr = recentCol && recentCol.getBoundingClientRect();
    const logo = document.querySelector('.home-logo');
    return {
      hasHome: !!home,
      logoLoaded: logo ? logo.naturalWidth : 0,
      W,
      items: items.length,
      brandIsLeftOfRecent: br && rr ? br.right <= rr.left : null,
      listScrollable: list ? list.scrollHeight > list.clientHeight + 1 : null,
      scrollH: list ? list.scrollHeight : null,
      clientH: list ? list.clientHeight : null,
      overflow: over.slice(0, 6),
      scrollW: document.documentElement.scrollWidth,
    };
  })()`);

  fs.mkdirSync(outDir, { recursive: true });
  // capturePage() can return the previously painted frame; wait for two
  // animation frames plus a settle delay so the home screen is what is drawn.
  await win.webContents.executeJavaScript(
    `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`,
  );
  await sleep(600);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
  return report;
}

app.whenReady().then(async () => {
  const ok = [];
  const bad = [];
  const check = (n, c, d) => {
    (c ? ok : bad).push(n);
    console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${d !== undefined ? ' -> ' + JSON.stringify(d) : ''}`);
  };

  console.log('\n# desktop, 14 entries, limit 10');
  const desktop = await shoot(1440, 900, 'home-desktop', { seed: 14, limit: 10 });
  console.log('  ' + JSON.stringify(desktop));
  check('home screen rendered', desktop.hasHome === true);
  check('app icon loaded', desktop.logoLoaded > 0, desktop.logoLoaded);
  check('icon column is left of the recent list', desktop.brandIsLeftOfRecent === true);
  check('shows exactly the configured count', desktop.items === 10, desktop.items);
  check('list scrolls when entries overflow', desktop.listScrollable === true, {
    scrollH: desktop.scrollH,
    clientH: desktop.clientH,
  });
  check('no horizontal overflow', desktop.overflow.length === 0 && desktop.scrollW <= desktop.W, desktop.overflow);

  console.log('\n# desktop, limit raised to 20');
  const wide = await shoot(1440, 900, 'home-desktop-20', { seed: 14, limit: 20 });
  check('respects a larger configured count', wide.items === 14, wide.items);

  console.log('\n# phone');
  const phone = await shoot(390, 844, 'home-phone', { seed: 6, limit: 10 });
  console.log('  ' + JSON.stringify(phone));
  check('phone keeps the home screen', phone.hasHome === true);
  check('phone stacks the columns', phone.brandIsLeftOfRecent === false);
  check('phone has no horizontal overflow', phone.overflow.length === 0, phone.overflow);

  console.log('\n# empty history');
  const empty = await shoot(1440, 900, 'home-empty', {});
  check('empty state rendered', empty.hasHome === true && empty.items === 0, empty.items);
  check('empty state has no overflow', empty.overflow.length === 0, empty.overflow);

  console.log(`\n${bad.length === 0 ? 'PASS' : 'FAIL'}  ${ok.length} passed, ${bad.length} failed\n`);
  app.exit(bad.length === 0 ? 0 : 1);
});

app.on('window-all-closed', () => app.quit());

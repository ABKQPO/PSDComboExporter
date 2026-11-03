// End-to-end test in a real Electron renderer (same bundle as the EXE):
//   electron test/e2e.cjs <file.psd> [outDir]
// Imports the PSD, builds option groups + a cross-group rule through the
// real store, checks the render against the PSD's merged image, exports a ZIP,
// verifies every PNG in it, and saves UI screenshots (desktop + phone size).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const psdPath = process.argv[2];
const outDir = process.argv[3] || path.join(__dirname, '..', 'test-out', 'e2e');
if (!psdPath || !fs.existsSync(psdPath)) {
  console.error('usage: electron test/e2e.cjs <file.psd> [outDir]');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

let failed = 0;
const check = (name, cond, detail) => {
  if (!cond) failed++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ' -> ' + JSON.stringify(detail) : ''}`);
};

/** Minimal ZIP reader for STORE archives. */
function readZip(buf) {
  const entries = [];
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(off + 28);
    const extra = buf.readUInt16LE(off + 30);
    const comment = buf.readUInt16LE(off + 32);
    const size = buf.readUInt32LE(off + 20);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const lName = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    const start = local + 30 + lName + lExtra;
    entries.push({ name, crc: buf.readUInt32LE(off + 16), data: buf.slice(start, start + size) });
    off += 46 + nameLen + extra + comment;
  }
  return entries;
}

/** Decode an 8-bit RGB/RGBA non-interlaced PNG (enough for our encoder's output). */
function decodePng(buf) {
  let p = 8;
  let w = 0, h = 0, type = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const t = buf.slice(p + 4, p + 8).toString('ascii');
    const d = buf.slice(p + 8, p + 8 + len);
    if (t === 'IHDR') {
      w = d.readUInt32BE(0);
      h = d.readUInt32BE(4);
      type = d[9];
    } else if (t === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < bpp; c++) out[(y * w + x) * 4 + c] = cur[x * bpp + c];
      if (bpp === 3) out[(y * w + x) * 4 + 3] = 255;
    }
    cur.copy(prev);
  }
  return { w, h, data: out };
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 920,
    webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(__dirname, '..', 'electron', 'preload.cjs') },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 3) errors.push(msg);
  });
  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  // start clean: rules saved by an earlier run would be restored on import
  await win.webContents.executeJavaScript('localStorage.clear()');
  const run = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
  const shot = async (name) => fs.writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await shot('0-start.png');
  console.log('\n# import');
  const b64 = fs.readFileSync(psdPath).toString('base64');
  const imp = await run(`
    const bin = atob(${JSON.stringify(b64)}); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const t0 = performance.now();
    const r = await window.psdExportApp.importBuffer(${JSON.stringify(path.basename(psdPath))}, bytes.buffer);
    const s = window.psdExportApp.state();
    return { ...r, ms: Math.round(performance.now() - t0), size: [s.project.width, s.project.height], warnings: s.warnings };
  `);
  console.log(JSON.stringify(imp));
  check('PSD imported', imp.layers > 0);
  for (let i = 0; i < 100 && (await run('return !!window.psdExportApp.state().busy')); i++) await sleep(100);
  await sleep(2000);
  await run(`document.querySelector('.tab:nth-child(1)').click(); return true;`);
  await sleep(1500);
  await shot('1-layers.png');

  console.log('\n# fidelity');
  const cmp = await run(`return await window.psdExportApp.debug.compare();`);
  console.log(JSON.stringify(cmp));
  if (cmp.available) {
    check('artwork matches the PSD merged image (≥99.9% identical, ≥99.99% within ±2)', cmp.same > 0.999 && cmp.near > 0.9999, cmp);
    if (cmp.effectPixels) check('scaled pattern overlay stays within the known approximation (max < 64)', cmp.effectMax < 64, cmp.effectMax);
  }

  console.log('\n# rules');
  const rules = await run(`
    const d = window.psdExportApp.debug;
    const hair = d.ruleFromGroup('头发', 'exclusive');
    const tail = d.ruleFromGroup('尾巴', 'exclusive');
    const face = d.ruleFromGroup('表情', 'exclusive');
    const before = d.summary();
    // conditional exclusion: these two layers may not appear together
    d.addMutex({ kind: 'option', optionId: d.optionId(hair, '长发') }, { kind: 'option', optionId: d.optionId(tail, '鱼尾') });
    const after = d.summary();
    const s = window.psdExportApp.state();
    s.tab = 'rules'; window.psdExportApp.state().sheetOpen = true;
    return { before, after, rules: s.project.rules.map(r => [r.name, r.kind, r.options.map(o => o.name)]) };
  `);
  console.log(JSON.stringify(rules.rules));
  check('three option groups created', rules.rules.length >= 3);
  check('product counted', rules.before.raw === rules.before.combos + rules.before.rejected, rules.before);
  check('conditional exclusion removed combos', rules.after.combos < rules.before.combos, [rules.before.combos, rules.after.combos]);
  check('no excluded combo survives', !rules.after.labels.some((l) => l.includes('长发') && l.includes('鱼尾')));
  await run(`window.psdExportApp.state().tab = 'rules'; return true;`);
  await run(`document.querySelector('.tab:nth-child(2)').click(); return true;`);
  await sleep(1200);
  await shot('2-rules.png');
  await run(`document.querySelector('.tab:nth-child(3)').click(); return true;`);
  await sleep(500);
  await shot('3-constraints.png');
  await run(`document.querySelector('.tab:nth-child(4)').click(); return true;`);
  await sleep(4000);
  await shot('4-combos.png');

  console.log('\n# export');
  const t0 = Date.now();
  const zipB64 = await run(`
    const r = await window.psdExportApp.debug.exportZipInMemory();
    let s = ''; const b = r.bytes;
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  `);
  const zip = Buffer.from(zipB64, 'base64');
  fs.writeFileSync(path.join(outDir, 'export.zip'), zip);
  const entries = readZip(zip);
  console.log(`  ${entries.length} entries, ${(zip.length / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  check('ZIP holds one PNG per combination', entries.length === rules.after.combos, [entries.length, rules.after.combos]);
  const names = new Set(entries.map((e) => e.name));
  check('file names are unique', names.size === entries.length);
  const first = decodePng(entries[0].data);
  check('PNGs are full size', first.w === imp.size[0] && first.h === imp.size[1], [first.w, first.h]);
  const sigs = new Set(entries.map((e) => e.crc));
  check('every exported picture is different', sigs.size === entries.length);
  fs.writeFileSync(path.join(outDir, entries[0].name.replace(/[\\/]/g, '_')), entries[0].data);

  // the exported PNG must equal the engine's raw full-size render of the same combination
  const raw = await run(`
    const s = window.psdExportApp.state();
    const png = await window.psdExportApp.debug.exportPng(0);
    let str = ''; for (let i = 0; i < png.length; i += 0x8000) str += String.fromCharCode.apply(null, png.subarray(i, i + 0x8000));
    return btoa(str);
  `);
  const again = decodePng(Buffer.from(raw, 'base64'));
  check('export is deterministic (same pixels when rendered again)', Buffer.compare(again.data, first.data) === 0);
  // PNG round trip: decoded file == the engine's raw pixels
  const rawHash = await run(`
    const s = window.psdExportApp.state();
    const img = await window.psdExportApp.debug.rawFull(0);
    let h = 2166136261; for (let i = 0; i < img.data.length; i++) { h ^= img.data[i]; h = Math.imul(h, 16777619); }
    return h >>> 0;
  `);
  let fh = 2166136261;
  for (let i = 0; i < first.data.length; i++) {
    fh ^= first.data[i];
    fh = Math.imul(fh, 16777619);
  }
  check('PNG decodes to exactly the rendered pixels', (fh >>> 0) === rawHash, [fh >>> 0, rawHash]);

  console.log('\n# phone layout');
  win.setSize(412, 860);
  await run(`const s = window.psdExportApp.state(); s.sheetOpen = false; document.querySelector('.tabbar button:nth-child(2)').click(); return true;`);
  await sleep(800);
  await shot('5-phone-rules.png');
  await run(`document.querySelector('.sheet-close').click(); return true;`);
  await sleep(1200);
  await shot('6-phone-preview.png');

  check('no console errors', errors.length === 0, errors.slice(0, 5));
  console.log(`\n${failed ? failed + ' FAILED' : 'all passed'} — screenshots in ${outDir}`);
  app.exit(failed ? 1 : 0);
});

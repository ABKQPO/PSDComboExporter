/**
 * The Android export path, end to end in Node: the real AndroidTarget writes a
 * ZIP through a fake SaveFile plugin that decodes base64 as strictly as
 * android.util.Base64 (padding only at the very end). The archive is then
 * unpacked and every entry compared byte for byte.
 */

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

const written = [];
let badChunks = 0;
const SaveFile = {
  async chooseFile() {
    return { uri: 'content://test/out.zip' };
  },
  async appendChunk({ data }) {
    // android.util.Base64.decode: "=" may only appear as the final padding
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) {
      badChunks++;
      throw new Error('bad base-64');
    }
    written.push(Buffer.from(data, 'base64'));
  },
  async closeFile() {
    return { uri: 'content://test/out.zip' };
  },
};
globalThis.window = { Capacitor: { isNativePlatform: () => true, Plugins: { SaveFile } } };

const { createTarget } = await import('../src/core/platform');

// entries of awkward sizes (not multiples of 3), one big enough to force a mid-way flush
const rnd = (n, seed) => {
  const a = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) a[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24;
  return a;
};
const entries = [
  ['a.png', rnd(1, 1)],
  ['b.png', rnd(2, 2)],
  ['子目录/c.png', rnd(1000, 3)],
  ['big.png', rnd(5 * 1024 * 1024 + 7, 4)],
  ['d.png', rnd(4, 5)],
  ['e.png', rnd(3 * 1024 * 1024 + 1, 6)],
];

const target = await createTarget();
check('android target chosen', target.platform === 'android', target.platform);
let error = null;
try {
  await target.begin({ suggestedName: 'test', total: entries.length });
  for (const [p, d] of entries) await target.add(p, d);
  await target.finish();
} catch (e) {
  error = e.message;
}
check('export finished without error', error === null, error);
check('every chunk was valid base64', badChunks === 0, badChunks);
check('more than one transfer (flush mid-way)', written.length > 1, written.length);

const zip = Buffer.concat(written);
const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
check('end of central directory found', eocd > 0);
const count = zip.readUInt16LE(eocd + 10);
let cd = zip.readUInt32LE(eocd + 16);
const got = new Map();
for (let i = 0; i < count; i++) {
  const nameLen = zip.readUInt16LE(cd + 28);
  const extra = zip.readUInt16LE(cd + 30);
  const comment = zip.readUInt16LE(cd + 32);
  const size = zip.readUInt32LE(cd + 20);
  const local = zip.readUInt32LE(cd + 42);
  const name = zip.subarray(cd + 46, cd + 46 + nameLen).toString('utf8');
  const lName = zip.readUInt16LE(local + 26);
  const lExtra = zip.readUInt16LE(local + 28);
  const start = local + 30 + lName + lExtra;
  got.set(name, zip.subarray(start, start + size));
  cd += 46 + nameLen + extra + comment;
}
check('all entries present', count === entries.length, count);
for (const [p, d] of entries) check(`entry ${p} identical`, !!got.get(p) && Buffer.compare(got.get(p), Buffer.from(d)) === 0);

const folderWrites = [];
let activeFolderFile = null;
const FolderSaveFile = {
  async chooseDirectory() {
    return { uri: 'content://test/out-folder' };
  },
  async beginOutputFile({ path }) {
    activeFolderFile = { path, chunks: [] };
  },
  async appendOutputChunk({ data }) {
    if (!activeFolderFile || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) throw new Error('bad folder base-64');
    activeFolderFile.chunks.push(Buffer.from(data, 'base64'));
  },
  async finishOutputFile() {
    folderWrites.push({ path: activeFolderFile.path, data: Buffer.concat(activeFolderFile.chunks) });
    activeFolderFile = null;
  },
  async abortOutputFile() {
    activeFolderFile = null;
  },
  async closeDirectory() {
    return { uri: 'content://test/out-folder' };
  },
};
globalThis.window.Capacitor.Plugins.SaveFile = FolderSaveFile;
const folderTarget = await createTarget('folder');
check('android folder target chosen', folderTarget.platform === 'android', folderTarget.platform);
let folderError = null;
try {
  await folderTarget.begin({ suggestedName: 'test', total: entries.length });
  for (const [p, d] of entries) await folderTarget.add(p, d);
  const folderResult = await folderTarget.finish();
  check('folder export reports all entries', folderResult.entries === entries.length, folderResult);
  check('folder export reports destination', folderResult.location.includes('out-folder'), folderResult.location);
} catch (e) {
  folderError = e.message;
}
check('folder export finished without error', folderError === null, folderError);
check('folder export wrote every file', folderWrites.length === entries.length, folderWrites.length);
for (const [p, d] of entries) {
  const gotFile = folderWrites.find((x) => x.path === p);
  check(`folder file ${p} identical`, !!gotFile && Buffer.compare(gotFile.data, Buffer.from(d)) === 0);
}
check('large folder file was streamed in multiple chunks', folderWrites.find((x) => x.path === 'big.png')?.data.length === 5 * 1024 * 1024 + 7, folderWrites.find((x) => x.path === 'big.png')?.data.length);

console.log(`android export: ${pass} checks passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/**
 * Builds the logic test bundle with esbuild (already present via vite) and runs
 * it in Node. Keeps the test file itself dependency-free.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
let status = 0;
for (const name of ['logic.test.mjs', 'engine.test.mjs', 'export.test.mjs', 'node-search.test.mjs', 'manifest.test.mjs']) {
  const out = path.join(here, '..', 'node_modules', '.cache', name.replace('.mjs', '.bundle.mjs'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await build({
    entryPoints: [path.join(here, name)],
    bundle: true,
    outfile: out,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    loader: { '.mjs': 'ts' },
    logLevel: 'warning',
  });
  const res = spawnSync(process.execPath, [out], { stdio: 'inherit' });
  if (res.status !== 0) status = 1;
}
process.exit(status);

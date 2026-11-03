/** Bundles test/ipv-all.ts with esbuild and runs it: npm run test:fidelity -- <file.psd> [outDir] */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'node_modules', '.cache', 'ipv-all.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
await build({
  entryPoints: [path.join(here, 'ipv-all.ts')],
  bundle: true,
  outfile: out,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'warning',
});
const res = spawnSync(process.execPath, ['--max-old-space-size=6144', out, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(res.status ?? 1);

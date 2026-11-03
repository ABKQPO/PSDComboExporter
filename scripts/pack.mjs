#!/usr/bin/env node
/**
 * Cross-platform packaging script.
 *
 *   node scripts/pack.mjs desktop [win|mac|linux] [--arch=x64]
 *   node scripts/pack.mjs android
 *   node scripts/pack.mjs all
 *
 * Desktop output goes to release/, Android output to apk-out/.
 * CI and local builds use the same commands: `npm run pack:*`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const [, , command = 'all', ...rest] = process.argv;
const flags = rest.filter((a) => a.startsWith('--'));
const positional = rest.filter((a) => !a.startsWith('--'));
const arch = (flags.find((f) => f.startsWith('--arch=')) || '--arch=x64').split('=')[1];

function run(cmd, args, opts = {}) {
  const printable = [cmd, ...args].join(' ');
  console.log(`\n$ ${printable}`);
  const res = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (res.status !== 0) {
    console.error(`\n✗ 失败：${printable}`);
    process.exit(res.status ?? 1);
  }
}

function buildWeb() {
  run('npx', ['vite', 'build']);
}

function packDesktop(platform) {
  const target = platform || defaultPlatform();
  console.log(`\n=== 桌面端打包：${target} / ${arch} ===`);
  buildWeb();
  run('npx', ['electron-builder', `--${target}`, `--${arch}`, '--publish', 'never'], {
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });
  const out = path.join(root, 'release');
  const files = fs.existsSync(out)
    ? fs.readdirSync(out).filter((f) => fs.statSync(path.join(out, f)).isFile())
    : [];
  console.log(`\n桌面端产物（release/）：`);
  for (const f of files) console.log(`  ${f}`);
}

function packAndroid() {
  console.log('\n=== Android 打包 ===');
  buildWeb();
  run('npx', ['cap', 'sync', 'android']);

  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(path.join(root, 'android', 'gradlew'), 0o755);
    } catch {
      /* ignore */
    }
  }
  run(gradlew, ['--no-daemon', 'assembleDebug', 'assembleRelease'], {
    cwd: path.join(root, 'android'),
  });

  const apkDir = path.join(root, 'apk-out');
  fs.mkdirSync(apkDir, { recursive: true });
  const copies = [
    ['app/build/outputs/apk/debug/app-debug.apk', `PSD-Combo-Exporter-${version}-android-debug.apk`],
    ['app/build/outputs/apk/release/app-release-unsigned.apk', `PSD-Combo-Exporter-${version}-android-release-unsigned.apk`],
  ];
  for (const [from, to] of copies) {
    const src = path.join(root, 'android', from);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(apkDir, to));
      console.log(`  ${to}`);
    }
  }
}

function defaultPlatform() {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

switch (command) {
  case 'desktop':
    packDesktop(positional[0]);
    break;
  case 'android':
    packAndroid();
    break;
  case 'all':
    packDesktop();
    packAndroid();
    break;
  case 'web':
    buildWeb();
    break;
  default:
    console.error(`未知命令：${command}`);
    console.error('用法：node scripts/pack.mjs <desktop|android|all|web> [win|mac|linux] [--arch=x64]');
    process.exit(1);
}

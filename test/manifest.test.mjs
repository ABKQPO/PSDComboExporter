import assert from 'node:assert/strict';
import { buildManifestCsv } from '../src/core/manifest.ts';

assert.equal(
  buildManifestCsv(['Index', 'Filename', 'Options'], [
    ['1', 'art/A.png', 'Hair: Short'],
    ['2', 'quote"name.png', 'Eyes: Open, Mouth: Smile'],
  ]),
  '\uFEFFIndex,Filename,Options\r\n1,art/A.png,Hair: Short\r\n2,"quote""name.png","Eyes: Open, Mouth: Smile"\r\n',
);
assert.equal(buildManifestCsv(['A', 'B'], []), '\uFEFFA,B\r\n');
console.log('CSV manifest: 2 checks passed');

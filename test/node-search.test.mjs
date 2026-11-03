import assert from 'node:assert/strict';
import { nextSearchIndex, searchNodes } from '../src/ui/nodeSearch.ts';

const nodes = [
  { id: 'hair', text: 'Option group: Hair Short Long' },
  { id: 'eyes', text: 'Option group: Eyes Closed Open' },
  { id: 'export', text: 'Export ZIP' },
];

assert.deepEqual(searchNodes(nodes, 'hair').map((node) => node.id), ['hair']);
assert.deepEqual(searchNodes(nodes, 'OPEN').map((node) => node.id), ['eyes']);
assert.deepEqual(searchNodes(nodes, '  ').map((node) => node.id), []);
assert.deepEqual(searchNodes(nodes, 'missing'), []);
assert.equal(nextSearchIndex(-1, 3, 1), 0);
assert.equal(nextSearchIndex(-1, 3, -1), 2);
assert.equal(nextSearchIndex(2, 3, 1), 0);
assert.equal(nextSearchIndex(0, 3, -1), 2);
assert.equal(nextSearchIndex(-1, 0, 1), -1);
console.log('node search: 9 checks passed');

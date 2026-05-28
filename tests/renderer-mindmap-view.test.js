const assert = require('assert/strict');
const { wrapMindmapLabel } = require('../renderer-mindmap-view');

assert.deepEqual(wrapMindmapLabel('Short label', 20, 3), ['Short label']);
assert.deepEqual(wrapMindmapLabel('Alpha beta gamma delta', 10, 3), ['Alpha beta', 'gamma', 'delta']);
assert.deepEqual(wrapMindmapLabel('Alpha beta gamma delta epsilon', 10, 2), ['Alpha beta', 'gamma...']);

console.log('renderer-mindmap-view tests passed');

const assert = require('assert/strict');
const { normalizePaneSizeWeights } = require('../renderer-pane-layout');

{
  assert.deepEqual(normalizePaneSizeWeights(null), {
    raw: 1,
    formatted: 1,
    mindmap: 1
  });
}

{
  assert.deepEqual(normalizePaneSizeWeights({ raw: 2, formatted: '3', mindmap: 0 }), {
    raw: 2,
    formatted: 3,
    mindmap: 1
  });
}

{
  assert.deepEqual(normalizePaneSizeWeights({ raw: 99, formatted: -1, mindmap: 0.1 }), {
    raw: 8,
    formatted: 1,
    mindmap: 0.25
  });
}

console.log('renderer-pane-layout tests passed');

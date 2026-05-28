const assert = require('assert');
const {
  parseMindmapMarkdown,
  layoutMindmap,
  normalizeColour
} = require('../mindmap-core');

function labels(node) {
  return [node.label, ...(node.children || []).flatMap(labels)];
}

{
  const result = parseMindmapMarkdown('- Root\n  - Child\n    - Grandchild');
  assert.equal(result.ok, true);
  assert.equal(result.root.label, 'Root');
  assert.equal(result.root.children[0].label, 'Child');
  assert.equal(result.root.children[0].children[0].label, 'Grandchild');
}

{
  const result = parseMindmapMarkdown('# Strategy\n\n- Product\n- Market', { fileName: 'Plan.md' });
  assert.equal(result.root.label, 'Strategy');
  assert.deepEqual(result.root.children.map((child) => child.label), ['Product', 'Market']);
}

{
  const result = parseMindmapMarkdown('- Alpha\n- Beta', { fileName: 'Roadmap.md' });
  assert.equal(result.root.label, 'Roadmap');
  assert.deepEqual(result.root.children.map((child) => child.label), ['Alpha', 'Beta']);
}

{
  const result = parseMindmapMarkdown('1. First\n   - Mixed\n2) Second');
  assert.equal(result.ok, true);
  assert.deepEqual(labels(result.root), ['Mindmap', 'First', 'Mixed', 'Second']);
  assert.equal(result.root.children[0].markerType, 'ordered');
  assert.equal(result.root.children[0].children[0].markerType, 'unordered');
}

{
  const result = parseMindmapMarkdown('- [x] Done\n- [ ] Open');
  assert.equal(result.root.children[0].taskState, 'checked');
  assert.equal(result.root.children[1].taskState, 'unchecked');
}

{
  const result = parseMindmapMarkdown('- Node\n  continuation text\n  <!-- mindmap: color=blue fill=#fff icon=star shape=pill image=assets/example.png -->');
  assert.equal(result.root.label, 'Node continuation text');
  assert.equal(result.root.metadata.color, '#2563eb');
  assert.equal(result.root.metadata.fill, '#ffffff');
  assert.equal(result.root.metadata.icon, 'star');
  assert.equal(result.root.metadata.shape, 'pill');
  assert.equal(result.root.metadata.image, 'assets/example.png');
}

{
  const result = parseMindmapMarkdown('---\ntitle: ignored\n---\n\n```md\n- ignored\n```\n\n- Kept');
  assert.equal(result.root.label, 'Kept');
}

{
  const result = parseMindmapMarkdown('- Bad <!-- mindmap: color=url(javascript:alert(1)) icon=unknown nope=true -->');
  assert.equal(result.root.label, 'Bad');
  assert.equal(result.root.metadata.color, undefined);
  assert.ok(result.diagnostics.some((item) => item.code === 'invalid-colour'));
  assert.ok(result.diagnostics.some((item) => item.code === 'invalid-icon'));
  assert.ok(result.diagnostics.some((item) => item.code === 'unknown-metadata'));
}

{
  assert.equal(normalizeColour('#abc'), '#aabbcc');
  assert.equal(normalizeColour('purple'), '#7c3aed');
  assert.equal(normalizeColour('expression(alert(1))'), null);
}

{
  const result = parseMindmapMarkdown('# Map\n- A\n  - B\n- C');
  const layout = layoutMindmap(result.root);
  assert.ok(layout.nodes.length >= 4);
  assert.ok(layout.links.length >= 3);
  assert.ok(layout.width >= 640);
  assert.ok(layout.height >= 360);
}

{
  const result = parseMindmapMarkdown('# Map\n- A\n  - B\n- C\n  - D');
  for (const mode of ['balanced', 'right', 'left', 'vertical', 'radial']) {
    const layout = layoutMindmap(result.root, { layout: mode });
    assert.equal(layout.layout, mode);
    assert.ok(layout.nodes.length >= 5);
    assert.ok(layout.links.length >= 4);
  }
  const balanced = layoutMindmap(result.root, { layout: 'balanced' });
  assert.ok(balanced.nodes.some((item) => item.side === 'left'));
  assert.ok(balanced.nodes.some((item) => item.side === 'right'));
  const left = layoutMindmap(result.root, { layout: 'left' });
  assert.ok(left.nodes.some((item) => item.side === 'left'));
  const vertical = layoutMindmap(result.root, { layout: 'vertical' });
  assert.ok(vertical.nodes.some((item) => item.side === 'down'));
}

console.log('mindmap-core tests passed');

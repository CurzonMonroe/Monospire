const path = require('path');

const MINDMAP_PALETTE = [
  '#2563eb',
  '#16a34a',
  '#dc2626',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#4b5563'
];

const NAMED_COLOURS = {
  red: '#dc2626',
  orange: '#d97706',
  yellow: '#ca8a04',
  green: '#16a34a',
  blue: '#2563eb',
  purple: '#7c3aed',
  pink: '#db2777',
  gray: '#4b5563',
  grey: '#4b5563',
  slate: '#475569'
};

const ALLOWED_SHAPES = new Set(['rounded', 'rectangle', 'pill', 'circle']);
const ALLOWED_ICONS = new Set([
  'idea',
  'check',
  'flag',
  'star',
  'warning',
  'link',
  'person',
  'calendar',
  'note',
  'image'
]);

function stripFrontMatter(source) {
  const lines = String(source || '').split(/\r?\n/);
  if (lines[0] !== '---') {
    return { body: String(source || ''), bodyLineOffset: 0 };
  }
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---' || lines[i] === '...') {
      return {
        body: lines.slice(i + 1).join('\n'),
        bodyLineOffset: i + 1
      };
    }
  }
  return { body: String(source || ''), bodyLineOffset: 0 };
}

function firstHeading(lines, offset) {
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) {
      return {
        label: cleanInlineText(match[2]),
        line: i + offset
      };
    }
  }
  return null;
}

function isFenceLine(line) {
  return /^\s{0,3}(```+|~~~+)/.test(line);
}

function indentationWidth(value) {
  let width = 0;
  for (const char of value || '') {
    width += char === '\t' ? 3 : 1;
  }
  return width;
}

function listMatch(line) {
  const match = line.match(/^([ \t]*)([-*+]|\d+[.)])\s+(.+)$/);
  if (!match) return null;
  const marker = match[2];
  return {
    indent: indentationWidth(match[1]),
    marker,
    markerType: /^\d/.test(marker) ? 'ordered' : 'unordered',
    text: match[3]
  };
}

function cleanInlineText(value) {
  return String(value || '')
    .replace(/<!--\s*mindmap:[\s\S]*?-->/gi, '')
    .replace(/!\[([^\]]*)]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/={2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function createDiagnostic(code, message, line = null, severity = 'warning') {
  return { code, message, line, severity };
}

function normalizeColour(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
  }
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(NAMED_COLOURS, raw)) return NAMED_COLOURS[raw];
  return null;
}

function parseMetadataText(text, line, diagnostics) {
  const metadata = {};
  const source = String(text || '').trim();
  if (!source) return metadata;

  const pairs = source.match(/([a-zA-Z][\w-]*)=(?:"[^"]*"|'[^']*'|[^\s]+)/g) || [];
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    const key = pair.slice(0, index).toLowerCase();
    let value = pair.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === 'color' || key === 'fill') {
      const colour = normalizeColour(value);
      if (colour) {
        metadata[key] = colour;
      } else {
        diagnostics.push(createDiagnostic('invalid-colour', `Ignored invalid ${key} value "${value}".`, line));
      }
    } else if (key === 'icon') {
      const icon = value.toLowerCase();
      if (ALLOWED_ICONS.has(icon)) {
        metadata.icon = icon;
      } else {
        diagnostics.push(createDiagnostic('invalid-icon', `Ignored unsupported icon "${value}".`, line));
      }
    } else if (key === 'image') {
      metadata.image = value;
    } else if (key === 'shape') {
      const shape = value.toLowerCase();
      if (ALLOWED_SHAPES.has(shape)) {
        metadata.shape = shape;
      } else {
        diagnostics.push(createDiagnostic('invalid-shape', `Ignored unsupported shape "${value}".`, line));
      }
    } else if (key === 'collapsed') {
      metadata.collapsed = value === 'true' || value === '1' || value === 'yes';
    } else {
      diagnostics.push(createDiagnostic('unknown-metadata', `Ignored unknown metadata key "${key}".`, line));
    }
  }

  if (pairs.length === 0) {
    diagnostics.push(createDiagnostic('invalid-metadata', 'Ignored malformed mindmap metadata.', line));
  }

  return metadata;
}

function extractInlineMetadata(text, line, diagnostics) {
  const metadata = {};
  let labelText = String(text || '');
  labelText = labelText.replace(/<!--\s*mindmap:([\s\S]*?)-->/gi, (_match, body) => {
    Object.assign(metadata, parseMetadataText(body, line, diagnostics));
    return '';
  });
  return { labelText, metadata };
}

function isUnsafeImagePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    return !raw.startsWith('file:');
  }
  return false;
}

function createNode({ id, label, rawText, depth, lineStart, markerType, marker, metadata, taskState, branchIndex }) {
  return {
    id,
    label,
    rawText,
    depth,
    children: [],
    sourceLineStart: lineStart,
    sourceLineEnd: lineStart,
    markerType,
    marker,
    taskState,
    metadata: metadata || {},
    branchIndex,
    diagnostics: []
  };
}

function parseMindmapMarkdown(source, options = {}) {
  const diagnostics = [];
  const split = stripFrontMatter(source);
  const lines = split.body.split(/\r?\n/);
  const heading = firstHeading(lines, split.bodyLineOffset);
  const nodes = [];
  const stack = [];
  let inFence = false;
  let lastNode = null;

  for (let i = 0; i < lines.length; i += 1) {
    const sourceLine = i + split.bodyLineOffset;
    const line = lines[i];
    if (isFenceLine(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const metadataOnly = line.match(/^\s*<!--\s*mindmap:([\s\S]*?)-->\s*$/i);
    if (metadataOnly && lastNode) {
      Object.assign(lastNode.metadata, parseMetadataText(metadataOnly[1], sourceLine, diagnostics));
      continue;
    }

    const match = listMatch(line);
    if (!match) {
      if (/^( {4}|\t)/.test(line)) continue;
      if (lastNode && line.trim() && !/^\s{0,3}#/.test(line)) {
        lastNode.rawText = `${lastNode.rawText} ${line.trim()}`;
        lastNode.label = cleanInlineText(lastNode.rawText);
        lastNode.sourceLineEnd = sourceLine;
      }
      continue;
    }

    const inline = extractInlineMetadata(match.text, sourceLine, diagnostics);
    let rawText = inline.labelText.trim();
    let taskState = null;
    const taskMatch = rawText.match(/^\[([ xX])]\s+(.+)$/);
    if (taskMatch) {
      taskState = taskMatch[1].toLowerCase() === 'x' ? 'checked' : 'unchecked';
      rawText = taskMatch[2];
    }
    const label = cleanInlineText(rawText);
    if (!label) {
      diagnostics.push(createDiagnostic('empty-node', 'Ignored an empty mindmap node.', sourceLine));
      continue;
    }

    while (stack.length > 0 && match.indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const depth = stack.length + 1;
    const siblingIndex = stack.length > 0 ? stack[stack.length - 1].node.children.length : nodes.length;
    const id = `mm-${sourceLine + 1}-${depth}-${siblingIndex}`;
    const branchIndex = depth === 1 ? siblingIndex : stack[0]?.node.branchIndex ?? 0;
    const node = createNode({
      id,
      label,
      rawText,
      depth,
      lineStart: sourceLine,
      markerType: match.markerType,
      marker: match.marker,
      metadata: inline.metadata,
      taskState,
      branchIndex
    });

    if (node.metadata.image && isUnsafeImagePath(node.metadata.image)) {
      diagnostics.push(createDiagnostic('blocked-image', `Ignored unsupported image URL "${node.metadata.image}".`, sourceLine));
      delete node.metadata.image;
    }

    if (stack.length > 0) {
      stack[stack.length - 1].node.children.push(node);
    } else {
      nodes.push(node);
    }
    stack.push({ indent: match.indent, node });
    lastNode = node;
  }

  if (nodes.length === 0) {
    diagnostics.push(createDiagnostic('empty-mindmap', 'No Markdown list items were found for Mindmap view.', null, 'info'));
    return {
      ok: false,
      root: null,
      diagnostics
    };
  }

  let root = null;
  if (heading) {
    root = createNode({
      id: `mm-root-${heading.line + 1}`,
      label: heading.label,
      rawText: heading.label,
      depth: 0,
      lineStart: heading.line,
      markerType: 'root',
      marker: '',
      metadata: {},
      taskState: null,
      branchIndex: 0
    });
    root.children = nodes;
  } else if (nodes.length === 1) {
    root = nodes[0];
    root.depth = 0;
  } else {
    const fileName = options.fileName ? path.basename(options.fileName, path.extname(options.fileName)) : '';
    root = createNode({
      id: 'mm-root-generated',
      label: cleanInlineText(fileName) || 'Mindmap',
      rawText: cleanInlineText(fileName) || 'Mindmap',
      depth: 0,
      lineStart: 0,
      markerType: 'root',
      marker: '',
      metadata: {},
      taskState: null,
      branchIndex: 0
    });
    root.children = nodes;
  }

  root.diagnostics = diagnostics;
  return {
    ok: true,
    root,
    diagnostics
  };
}

function flattenMindmap(root) {
  const nodes = [];
  function visit(node, parent = null) {
    nodes.push({ node, parent });
    for (const child of node.children || []) visit(child, node);
  }
  if (root) visit(root, null);
  return nodes;
}

function countLeaves(node) {
  if (!node || !Array.isArray(node.children) || node.children.length === 0) return 1;
  return node.children.reduce((sum, child) => sum + countLeaves(child), 0);
}

function normalizeMindmapLayout(value) {
  if (value === 'right' || value === 'left' || value === 'vertical' || value === 'radial') return value;
  return 'balanced';
}

function descendantCount(node) {
  if (!node) return 0;
  return 1 + (node.children || []).reduce((sum, child) => sum + descendantCount(child), 0);
}

function layoutMindmap(root, options = {}) {
  if (!root) return { nodes: [], links: [], width: 640, height: 360 };
  const layout = normalizeMindmapLayout(options.layout);
  const horizontalGap = options.horizontalGap || 240;
  const verticalGap = options.verticalGap || 82;
  const radialGap = options.radialGap || 168;
  const nodeWidth = options.nodeWidth || 180;
  const nodeHeight = options.nodeHeight || 54;
  const links = [];
  const positioned = [];

  function pushNode(node, parent, x, y, side = 'right') {
    const height = node.metadata.shape === 'circle' ? Math.max(nodeWidth * 0.62, nodeHeight) : nodeHeight;
    positioned.push({
      id: node.id,
      node,
      parentId: parent?.id || null,
      x,
      y,
      width: nodeWidth,
      height,
      leaves: countLeaves(node),
      branchIndex: node.branchIndex || 0,
      colour: node.metadata.color || MINDMAP_PALETTE[(node.branchIndex || 0) % MINDMAP_PALETTE.length],
      fill: node.metadata.fill || null,
      shape: node.metadata.shape || 'rounded',
      side
    });
    if (parent) links.push({ from: parent.id, to: node.id, branchIndex: node.branchIndex || 0, side });
  }

  function placeHorizontal(node, depth, parent = null, side = 'right', state) {
    const leaves = countLeaves(node);
    const startY = state.cursorY;
    if (!node.children || node.children.length === 0) {
      state.cursorY += verticalGap;
    } else {
      for (const child of node.children) placeHorizontal(child, depth + 1, node, side, state);
    }
    const endY = state.cursorY - verticalGap;
    const y = node.children && node.children.length > 0
      ? (startY + endY) / 2
      : startY;
    const x = side === 'left' ? -depth * horizontalGap : depth * horizontalGap;
    pushNode(node, parent, x, y, side);
    return leaves;
  }

  function placeVertical(node, depth, parent = null, stateByDepth = []) {
    const siblingsAtDepth = stateByDepth[depth] || 0;
    stateByDepth[depth] = siblingsAtDepth + 1;
    const x = siblingsAtDepth * (nodeWidth + 44);
    const y = depth * verticalGap * 1.25;
    pushNode(node, parent, x, y, 'down');
    for (const child of node.children || []) placeVertical(child, depth + 1, node, stateByDepth);
  }

  function placeRadial(node, depth, parent, angleStart, angleEnd) {
    if (!parent) {
      pushNode(node, null, 0, 0, 'radial');
    }
    const children = node.children || [];
    if (children.length === 0) return;
    const total = children.reduce((sum, child) => sum + descendantCount(child), 0);
    let cursor = angleStart;
    for (const child of children) {
      const share = (angleEnd - angleStart) * (descendantCount(child) / Math.max(1, total));
      const mid = cursor + share / 2;
      const radius = depth * radialGap;
      const x = Math.cos(mid) * radius;
      const y = Math.sin(mid) * radius;
      pushNode(child, node, x, y, Math.cos(mid) < 0 ? 'left' : 'right');
      placeRadial(child, depth + 1, node, cursor, cursor + share);
      cursor += share;
    }
  }

  if (layout === 'vertical') {
    placeVertical(root, 0, null, []);
  } else if (layout === 'radial') {
    placeRadial(root, 1, null, -Math.PI, Math.PI);
  } else if (layout === 'balanced') {
    pushNode(root, null, 0, 0, 'root');
    const children = root.children || [];
    const leftChildren = [];
    const rightChildren = [];
    children.forEach((child, index) => {
      if (index % 2 === 0) rightChildren.push(child);
      else leftChildren.push(child);
    });
    const rightState = { cursorY: -countLeaves({ children: rightChildren }) * verticalGap / 2 };
    const leftState = { cursorY: -countLeaves({ children: leftChildren }) * verticalGap / 2 };
    for (const child of rightChildren) placeHorizontal(child, 1, root, 'right', rightState);
    for (const child of leftChildren) placeHorizontal(child, 1, root, 'left', leftState);
  } else {
    placeHorizontal(root, 0, null, layout === 'left' ? 'left' : 'right', { cursorY: 0 });
  }

  const minX = Math.min(...positioned.map((item) => item.x));
  const maxX = Math.max(...positioned.map((item) => item.x + item.width));
  const minY = Math.min(...positioned.map((item) => item.y));
  const maxY = Math.max(...positioned.map((item) => item.y + item.height));
  const margin = 80;
  for (const item of positioned) {
    item.x = item.x - minX + margin;
    item.y = item.y - minY + margin;
  }

  return {
    layout,
    nodes: positioned,
    links,
    width: Math.max(640, maxX - minX + margin * 2),
    height: Math.max(360, maxY - minY + margin * 2)
  };
}

module.exports = {
  MINDMAP_PALETTE,
  NAMED_COLOURS,
  parseMindmapMarkdown,
  layoutMindmap,
  flattenMindmap,
  normalizeMindmapLayout,
  normalizeColour
};

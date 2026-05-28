const path = require('path');
const fsSync = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');
const {
  MINDMAP_PALETTE,
  parseMindmapMarkdown,
  layoutMindmap,
  normalizeMindmapLayout,
  normalizeColour
} = require('./mindmap-core');

const MINDMAP_SVG_NS = 'http://www.w3.org/2000/svg';

function createSvgElement(tagName, attrs = {}) {
  const element = document.createElementNS(MINDMAP_SVG_NS, tagName);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    element.setAttribute(key, String(value));
  }
  return element;
}

function safeSvgId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '-');
}

function escapeSvgText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function wrapMindmapLabel(value, maxChars = 24, maxLines = 3) {
  const words = escapeSvgText(value).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || current.length === 0) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
    if (lines.length >= maxLines) break;
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/\s+$/, '')}...`;
  }
  return lines;
}

function textColourForFill(fill, fallback) {
  const colour = normalizeColour(fill);
  if (!colour) return fallback;
  const hex = colour.slice(1);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.58 ? '#111827' : '#f8fafc';
}

function mindmapNodeAccessibleLabel(node) {
  const task = node.taskState === 'checked'
    ? 'checked task, '
    : node.taskState === 'unchecked'
      ? 'unchecked task, '
      : '';
  const childCount = Array.isArray(node.children) ? node.children.length : 0;
  return `${task}${node.label}${childCount ? `, ${childCount} child nodes` : ''}`;
}

function mindmapConnectorPath(from, to) {
  if (to.side === 'down') {
    const startX = from.x + from.width / 2;
    const startY = from.y + from.height;
    const endX = to.x + to.width / 2;
    const endY = to.y;
    const midY = startY + Math.max(34, (endY - startY) / 2);
    return `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`;
  }

  if (to.side === 'left') {
    const startX = from.x;
    const startY = from.y + from.height / 2;
    const endX = to.x + to.width;
    const endY = to.y + to.height / 2;
    const mid = Math.max(40, Math.abs(startX - endX) / 2);
    return `M ${startX} ${startY} C ${startX - mid} ${startY}, ${endX + mid} ${endY}, ${endX} ${endY}`;
  }

  const startX = from.x + from.width;
  const startY = from.y + from.height / 2;
  const endX = to.x;
  const endY = to.y + to.height / 2;
  const mid = Math.max(40, Math.abs(endX - startX) / 2);
  return `M ${startX} ${startY} C ${startX + mid} ${startY}, ${endX - mid} ${endY}, ${endX} ${endY}`;
}

function createMindmapViewController(options) {
  const {
    canvas,
    viewport,
    diagnosticsElement,
    nativeApi,
    getMarkdown,
    getFileName,
    getFilePath,
    isVisible,
    isDarkMode,
    canScrollRaw,
    onScrollToLine,
    onStateChange,
    alertUser
  } = options;

  let zoom = 1;
  let layoutMode = 'balanced';
  let renderTimer = null;
  let renderVersion = 0;
  let lastSvg = '';
  let lastLayout = null;
  let focusedNodeId = '';

  function resolveImagePath(imagePath) {
    const raw = String(imagePath || '').trim();
    if (!raw) return null;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
      if (!raw.startsWith('file:')) return null;
      return raw;
    }
    const filePath = getFilePath();
    const baseDir = filePath ? path.dirname(filePath) : process.cwd();
    return pathToFileURL(path.resolve(baseDir, raw)).href;
  }

  function collectRenderDiagnostics(layout) {
    const diagnostics = [];
    for (const item of layout?.nodes || []) {
      const image = item.node?.metadata?.image;
      if (!image) continue;
      const href = resolveImagePath(image);
      if (!href) {
        diagnostics.push({
          code: 'blocked-image',
          message: `Ignored unsupported image path "${image}".`,
          line: item.node.sourceLineStart,
          severity: 'warning'
        });
        continue;
      }
      if (href.startsWith('file:')) {
        try {
          if (!fsSync.existsSync(fileURLToPath(href))) {
            diagnostics.push({
              code: 'missing-image',
              message: `Image not found: ${image}`,
              line: item.node.sourceLineStart,
              severity: 'warning'
            });
          }
        } catch {
          diagnostics.push({
            code: 'missing-image',
            message: `Image could not be loaded: ${image}`,
            line: item.node.sourceLineStart,
            severity: 'warning'
          });
        }
      }
    }
    return diagnostics;
  }

  function appendIcon(group, iconName, x, y, colour) {
    const icon = createSvgElement('text', {
      x,
      y,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      class: 'mindmap-node-text',
      fill: colour,
      style: `fill:${colour}`,
      'aria-hidden': 'true'
    });
    const glyphs = {
      idea: '!',
      check: 'OK',
      flag: 'F',
      star: '*',
      warning: '!',
      link: '@',
      person: 'P',
      calendar: '#',
      note: 'N',
      image: 'IMG'
    };
    icon.textContent = glyphs[iconName] || iconName.slice(0, 2).toUpperCase();
    group.appendChild(icon);
  }

  function appendImage(group, node, x, y) {
    const imageHref = resolveImagePath(node.metadata.image);
    const clipId = `clip-${safeSvgId(node.id)}`;
    const clip = createSvgElement('clipPath', { id: clipId });
    clip.appendChild(createSvgElement('rect', { x, y, width: 34, height: 34, rx: 6, ry: 6 }));
    group.appendChild(clip);

    const darkMode = isDarkMode();
    const placeholder = createSvgElement('rect', {
      x,
      y,
      width: 34,
      height: 34,
      rx: 6,
      ry: 6,
      fill: darkMode ? '#29313d' : '#eef2f7',
      stroke: darkMode ? '#465062' : '#cfd6e2'
    });
    group.appendChild(placeholder);

    if (!imageHref) {
      appendIcon(group, 'image', x + 17, y + 17, darkMode ? '#b7bcc7' : '#666675');
      return;
    }

    const image = createSvgElement('image', {
      x,
      y,
      width: 34,
      height: 34,
      href: imageHref,
      preserveAspectRatio: 'xMidYMid slice',
      'clip-path': `url(#${clipId})`
    });
    group.appendChild(image);
  }

  function renderDiagnostics(diagnostics) {
    if (!diagnosticsElement) return;
    const visibleDiagnostics = (diagnostics || []).slice(0, 5);
    diagnosticsElement.innerHTML = '';
    diagnosticsElement.classList.toggle('visible', visibleDiagnostics.length > 0);
    for (const diagnostic of visibleDiagnostics) {
      const item = document.createElement('div');
      item.textContent = diagnostic.line === null || diagnostic.line === undefined
        ? diagnostic.message
        : `Line ${diagnostic.line + 1}: ${diagnostic.message}`;
      diagnosticsElement.appendChild(item);
    }
  }

  function renderEmpty(message, diagnostics = []) {
    if (!canvas) return;
    canvas.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'mindmap-empty';
    empty.textContent = message;
    canvas.appendChild(empty);
    lastSvg = '';
    lastLayout = null;
    renderDiagnostics(diagnostics);
  }

  function applyZoom() {
    if (!canvas) return;
    canvas.style.transform = `scale(${zoom})`;
    if (lastLayout) {
      canvas.style.width = `${lastLayout.width * zoom}px`;
      canvas.style.height = `${lastLayout.height * zoom}px`;
    }
  }

  function renderSvg(layout, diagnostics = []) {
    if (!canvas || !viewport) return;
    canvas.innerHTML = '';
    const textColour = '#161617';
    const mutedColour = '#666675';
    const defaultNodeFill = '#ffffff';
    const rootFill = '#d8e9ff';
    const nodeBorder = isDarkMode() ? '#465062' : '#cfd6e2';
    const focusRing = isDarkMode() ? '#76b7ff' : '#0a84ff';
    const svg = createSvgElement('svg', {
      class: 'mindmap-svg',
      width: layout.width,
      height: layout.height,
      viewBox: `0 0 ${layout.width} ${layout.height}`,
      role: 'presentation',
      'aria-hidden': 'false'
    });

    const style = createSvgElement('style');
    style.textContent = `
      .mindmap-node-text{fill:${textColour};font:600 12px -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}
      .mindmap-node-subtext{fill:${mutedColour};font:10px -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}
      .mindmap-link{fill:none;stroke-linecap:round;stroke-width:3;opacity:.78}
      .mindmap-node:focus .mindmap-node-outline,.mindmap-node.focused .mindmap-node-outline{stroke:${focusRing};stroke-width:3}
    `;
    svg.appendChild(style);

    const defs = createSvgElement('defs');
    svg.appendChild(defs);
    const nodeById = new Map(layout.nodes.map((item) => [item.id, item]));

    const linkLayer = createSvgElement('g', { class: 'mindmap-links', 'aria-hidden': 'true' });
    for (const link of layout.links) {
      const from = nodeById.get(link.from);
      const to = nodeById.get(link.to);
      if (!from || !to) continue;
      const colour = to.colour || MINDMAP_PALETTE[link.branchIndex % MINDMAP_PALETTE.length];
      linkLayer.appendChild(createSvgElement('path', {
        class: 'mindmap-link',
        d: mindmapConnectorPath(from, to),
        stroke: colour
      }));
    }
    svg.appendChild(linkLayer);

    const nodeLayer = createSvgElement('g', { class: 'mindmap-nodes' });
    for (const item of layout.nodes) {
      const { node } = item;
      const group = createSvgElement('g', {
        class: `mindmap-node${focusedNodeId === node.id ? ' focused' : ''}`,
        tabindex: '0',
        role: 'treeitem',
        'aria-label': mindmapNodeAccessibleLabel(node),
        'data-node-id': node.id,
        'data-line': node.sourceLineStart
      });

      const fill = item.fill || (node.depth === 0 ? rootFill : defaultNodeFill);
      const stroke = item.colour || nodeBorder;
      const nodeTextColour = textColourForFill(item.fill, textColour);
      const nodeMutedColour = textColourForFill(item.fill, mutedColour);
      const outlineAttrs = {
        class: 'mindmap-node-outline',
        fill,
        stroke,
        'stroke-width': node.depth === 0 ? 2.4 : 1.6
      };
      if (item.shape === 'circle') {
        group.appendChild(createSvgElement('circle', {
          ...outlineAttrs,
          cx: item.x + item.width / 2,
          cy: item.y + item.height / 2,
          r: Math.min(item.width, item.height) / 2
        }));
      } else {
        const radius = item.shape === 'rectangle' ? 5 : item.shape === 'pill' ? item.height / 2 : 12;
        group.appendChild(createSvgElement('rect', {
          ...outlineAttrs,
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          rx: radius,
          ry: radius
        }));
      }

      let textX = item.x + item.width / 2;
      if (node.metadata.image) {
        appendImage(group, node, item.x + 12, item.y + 10);
        textX = item.x + 54 + ((item.width - 66) / 2);
      } else if (node.metadata.icon || node.taskState) {
        appendIcon(group, node.metadata.icon || (node.taskState === 'checked' ? 'check' : 'note'), item.x + 24, item.y + item.height / 2, item.colour);
        textX = item.x + 42 + ((item.width - 54) / 2);
      }

      const lines = wrapMindmapLabel(node.label, node.depth === 0 ? 22 : 24, node.metadata.image ? 2 : 3);
      const startY = item.y + (item.height / 2) - ((lines.length - 1) * 8);
      for (let i = 0; i < lines.length; i += 1) {
        const text = createSvgElement('text', {
          x: textX,
          y: startY + i * 16,
          class: 'mindmap-node-text',
          'text-anchor': 'middle',
          'dominant-baseline': 'central',
          style: `fill:${nodeTextColour}`
        });
        text.textContent = lines[i];
        group.appendChild(text);
      }
      if (node.taskState) {
        const sub = createSvgElement('text', {
          x: item.x + item.width - 14,
          y: item.y + item.height - 12,
          class: 'mindmap-node-subtext',
          'text-anchor': 'end',
          style: `fill:${nodeMutedColour}`
        });
        sub.textContent = node.taskState === 'checked' ? 'done' : 'open';
        group.appendChild(sub);
      }
      nodeLayer.appendChild(group);
    }
    svg.appendChild(nodeLayer);
    canvas.appendChild(svg);
    canvas.style.width = `${layout.width}px`;
    canvas.style.height = `${layout.height}px`;
    applyZoom();
    lastSvg = new XMLSerializer().serializeToString(svg);
    lastLayout = layout;
    renderDiagnostics(diagnostics);
  }

  function renderNow(version) {
    if (version !== renderVersion || !isVisible()) return;
    const parsed = parseMindmapMarkdown(getMarkdown(), { fileName: getFileName() });
    if (!parsed.ok || !parsed.root) {
      renderEmpty('Add a Markdown list to see it as a mindmap.', parsed.diagnostics);
      return;
    }
    const flatCount = parsed.root ? layoutMindmap(parsed.root, { layout: layoutMode }).nodes.length : 0;
    const diagnostics = [...parsed.diagnostics];
    if (flatCount > 250) {
      diagnostics.push({
        code: 'large-mindmap',
        message: 'Large mindmap rendered with simplified styling.',
        line: null,
        severity: 'info'
      });
    }
    const layout = layoutMindmap(parsed.root, { layout: layoutMode });
    renderSvg(layout, [...diagnostics, ...collectRenderDiagnostics(layout)]);
  }

  function renderImmediately() {
    if (!isVisible()) return;
    renderVersion += 1;
    const version = renderVersion;
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    renderNow(version);
  }

  function scheduleRender() {
    if (!isVisible()) return;
    renderVersion += 1;
    const version = renderVersion;
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => renderNow(version), 140);
  }

  function focusNode(nodeId) {
    focusedNodeId = nodeId || '';
    if (!canvas) return;
    for (const node of canvas.querySelectorAll('.mindmap-node')) {
      node.classList.toggle('focused', node.getAttribute('data-node-id') === focusedNodeId);
    }
  }

  function setZoom(nextZoom) {
    zoom = Math.max(0.35, Math.min(2.4, Number(nextZoom) || 1));
    applyZoom();
    onStateChange?.();
  }

  async function exportSvg() {
    if (!lastSvg) {
      scheduleRender();
      alertUser('Mindmap export is not ready yet.');
      return false;
    }
    const fileName = getFileName();
    const baseName = fileName ? path.basename(fileName).replace(/\.[^.]+$/, '') : 'Untitled';
    const result = await nativeApi.exportMindmapSvg({
      path: getFilePath(),
      suggestedName: `${baseName}-mindmap`,
      svg: lastSvg
    });
    if (!result?.saved && result?.error) {
      alertUser(`Mindmap export failed: ${result.error}`);
      return false;
    }
    return Boolean(result?.saved);
  }

  function fitToView() {
    if (!viewport || !lastLayout) return;
    const widthRatio = (viewport.clientWidth - 36) / Math.max(1, lastLayout.width);
    const heightRatio = (viewport.clientHeight - 36) / Math.max(1, lastLayout.height);
    zoom = Math.max(0.35, Math.min(1.6, Math.min(widthRatio, heightRatio)));
    applyZoom();
    onStateChange?.();
  }

  function wireEvents() {
    if (!viewport) return;
    viewport.addEventListener('click', (event) => {
      const target = event.target;
      const node = target.closest?.('.mindmap-node[data-line]');
      if (!node) return;
      const line = Number(node.getAttribute('data-line') || 0);
      focusNode(node.getAttribute('data-node-id'));
      if (canScrollRaw()) onScrollToLine(line);
    });
    viewport.addEventListener('focusin', (event) => {
      const node = event.target.closest?.('.mindmap-node[data-node-id]');
      if (node) focusNode(node.getAttribute('data-node-id'));
    });
    viewport.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Enter'].includes(event.key)) return;
      const nodes = [...viewport.querySelectorAll('.mindmap-node')];
      if (nodes.length === 0) return;
      const currentIndex = Math.max(0, nodes.findIndex((node) => node.getAttribute('data-node-id') === focusedNodeId));
      let nextIndex = currentIndex;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = Math.min(nodes.length - 1, currentIndex + 1);
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = Math.max(0, currentIndex - 1);
      if (event.key === 'Enter') {
        const line = Number(nodes[currentIndex].getAttribute('data-line') || 0);
        if (canScrollRaw()) onScrollToLine(line);
        event.preventDefault();
        return;
      }
      nodes[nextIndex].focus();
      focusNode(nodes[nextIndex].getAttribute('data-node-id'));
      event.preventDefault();
    });
    viewport.addEventListener('wheel', (event) => {
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      zoom = event.deltaY > 0 ? Math.max(0.35, zoom - 0.08) : Math.min(2.4, zoom + 0.08);
      applyZoom();
      onStateChange?.();
    }, { passive: false });
    viewport.addEventListener('scroll', () => {
      onStateChange?.();
    });
  }

  return {
    exportSvg,
    fitToView,
    getLayout: () => layoutMode,
    getScrollState: () => ({
      scrollLeft: viewport ? viewport.scrollLeft : 0,
      scrollTop: viewport ? viewport.scrollTop : 0
    }),
    getZoom: () => zoom,
    renderImmediately,
    resetZoom: () => setZoom(1),
    scheduleRender,
    setLayout(value) {
      layoutMode = normalizeMindmapLayout(value);
      renderImmediately();
      onStateChange?.();
    },
    setScrollState(state = {}) {
      if (!viewport) return;
      viewport.scrollLeft = Number.isFinite(state.scrollLeft) ? Math.max(0, state.scrollLeft) : 0;
      viewport.scrollTop = Number.isFinite(state.scrollTop) ? Math.max(0, state.scrollTop) : 0;
    },
    setZoom,
    wireEvents,
    zoomBy(delta) {
      setZoom(zoom + delta);
    }
  };
}

module.exports = {
  createMindmapViewController,
  wrapMindmapLabel
};

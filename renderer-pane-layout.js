const PANE_KEYS = ['raw', 'formatted', 'mindmap'];

function normalizePaneSizeWeights(value) {
  const source = value && typeof value === 'object' ? value : {};
  const next = {};
  for (const key of PANE_KEYS) {
    const numeric = Number(source[key]);
    next[key] = Number.isFinite(numeric) && numeric > 0 ? Math.max(0.25, Math.min(8, numeric)) : 1;
  }
  return next;
}

function createPaneLayoutController(options) {
  const {
    body,
    workspace,
    panes,
    splitters,
    getVisibility,
    getOrientation,
    onResize,
    onChange
  } = options;

  let paneSizeWeights = normalizePaneSizeWeights(options.paneSizeWeights);

  function getVisiblePaneKeys() {
    const visibility = getVisibility();
    return PANE_KEYS.filter((key) => visibility[key]);
  }

  function paneElementForKey(key) {
    return panes[key] || null;
  }

  function splitterForPanePair(leftKey, rightKey) {
    const pair = `${leftKey}-${rightKey}`;
    return splitters.find((splitter) => splitter.dataset.splitter === pair) || null;
  }

  function apply() {
    if (!workspace) return;
    const visibleKeys = getVisiblePaneKeys();
    const horizontal = getOrientation() !== 'vertical';

    for (const [index, key] of visibleKeys.entries()) {
      const pane = paneElementForKey(key);
      if (pane) pane.style.order = String(index * 2);
    }

    for (const splitter of splitters) {
      splitter.style.display = 'none';
      splitter.classList.remove('active');
    }

    if (!horizontal || visibleKeys.length <= 1) {
      workspace.style.removeProperty('grid-template-columns');
      workspace.style.removeProperty('grid-template-rows');
      return;
    }

    const columns = [];
    for (let index = 0; index < visibleKeys.length; index += 1) {
      const key = visibleKeys[index];
      columns.push(`minmax(180px, ${paneSizeWeights[key] || 1}fr)`);
      if (index < visibleKeys.length - 1) {
        const splitter = splitterForPanePair(key, visibleKeys[index + 1]);
        if (splitter) {
          splitter.style.display = 'block';
          splitter.style.order = String(index * 2 + 1);
        }
        columns.push('3px');
      }
    }

    workspace.style.gridTemplateColumns = columns.join(' ');
    workspace.style.removeProperty('grid-template-rows');
  }

  function resizeWeights(leftKey, rightKey, deltaX) {
    const leftPane = paneElementForKey(leftKey);
    const rightPane = paneElementForKey(rightKey);
    if (!leftPane || !rightPane) return;

    const leftWidth = leftPane.getBoundingClientRect().width;
    const rightWidth = rightPane.getBoundingClientRect().width;
    const totalWidth = Math.max(1, leftWidth + rightWidth);
    const minWidth = Math.min(220, Math.max(140, totalWidth * 0.18));
    const nextLeft = Math.max(minWidth, Math.min(totalWidth - minWidth, leftWidth + deltaX));
    const nextRight = totalWidth - nextLeft;
    const pairWeightTotal = (paneSizeWeights[leftKey] || 1) + (paneSizeWeights[rightKey] || 1);
    paneSizeWeights = {
      ...paneSizeWeights,
      [leftKey]: (nextLeft / totalWidth) * pairWeightTotal,
      [rightKey]: (nextRight / totalWidth) * pairWeightTotal
    };
    apply();
    onResize?.();
    onChange?.();
  }

  function beginResize(event, splitter) {
    if (getOrientation() === 'vertical') return;
    const visibleKeys = getVisiblePaneKeys();
    const [leftKey, rightKey] = String(splitter.dataset.splitter || '').split('-');
    const leftIndex = visibleKeys.indexOf(leftKey);
    if (leftIndex < 0 || visibleKeys[leftIndex + 1] !== rightKey) return;

    event.preventDefault();
    splitter.classList.add('active');
    body.classList.add('resizing-panes');
    let lastX = event.clientX;

    const onPointerMove = (moveEvent) => {
      const deltaX = moveEvent.clientX - lastX;
      lastX = moveEvent.clientX;
      resizeWeights(leftKey, rightKey, deltaX);
    };

    const onPointerUp = () => {
      splitter.classList.remove('active');
      body.classList.remove('resizing-panes');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      onChange?.();
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  }

  function wire() {
    for (const splitter of splitters) {
      splitter.addEventListener('pointerdown', (event) => beginResize(event, splitter));
    }
  }

  return {
    apply,
    getWeights: () => ({ ...paneSizeWeights }),
    normalizeWeights: normalizePaneSizeWeights,
    setWeights(value) {
      paneSizeWeights = normalizePaneSizeWeights(value);
      apply();
    },
    wire
  };
}

module.exports = {
  createPaneLayoutController,
  normalizePaneSizeWeights
};

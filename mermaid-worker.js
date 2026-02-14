const { ipcRenderer } = require('electron');

let mermaidApi = null;
let mermaidLoadError = '';
let renderQueue = Promise.resolve();

function logWorker(message, payload = {}) {
  try {
    ipcRenderer.send('diagnostic-log', {
      message: `mermaid.worker.${message}`,
      ...(payload && typeof payload === 'object' ? payload : { value: payload })
    });
  } catch {
    // Best effort logging only.
  }
}

window.addEventListener('error', (event) => {
  logWorker('window-error', { error: String(event?.error?.message || event?.message || 'unknown') });
});

window.addEventListener('unhandledrejection', (event) => {
  logWorker('unhandled-rejection', { error: String(event?.reason?.message || event?.reason || 'unknown') });
});

function loadMermaid() {
  if (mermaidApi) return mermaidApi;
  const globalMermaid = globalThis.mermaid;
  if (globalMermaid && typeof globalMermaid.initialize === 'function' && typeof globalMermaid.render === 'function') {
    mermaidApi = globalMermaid;
    mermaidLoadError = '';
    logWorker('load.success', { source: 'global' });
    return mermaidApi;
  }

  let loaded = null;
  try {
    loaded = require('mermaid');
  } catch (error) {
    mermaidLoadError = String(error?.message || error || 'unable to load mermaid');
    logWorker('load.error', { source: 'require', error: mermaidLoadError });
    return null;
  }

  const candidate = loaded?.default || loaded;
  if (!candidate || typeof candidate.initialize !== 'function' || typeof candidate.render !== 'function') {
    mermaidLoadError = 'mermaid API unavailable';
    logWorker('load.error', { source: 'require', error: mermaidLoadError });
    return null;
  }
  mermaidApi = candidate;
  mermaidLoadError = '';
  logWorker('load.success', { source: 'require' });
  return mermaidApi;
}

async function renderMermaidSvg(api, renderId, code) {
  if (api?.mermaidAPI && typeof api.mermaidAPI.render === 'function') {
    return await api.mermaidAPI.render(renderId, code);
  }
  return await api.render(renderId, code);
}

ipcRenderer.on('mermaid-render-request', (_event, payload) => {
  renderQueue = renderQueue.then(async () => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const code = typeof payload?.code === 'string' ? payload.code : '';
    const darkMode = payload?.darkMode === true;
    if (!id) return;
    const api = loadMermaid();
    if (!api) {
      ipcRenderer.send('mermaid-render-response', { id, ok: false, error: mermaidLoadError || 'Mermaid not available.' });
      return;
    }

    try {
      api.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: darkMode ? 'dark' : 'default',
        flowchart: {
          htmlLabels: false,
          useMaxWidth: true
        }
      });
      const renderId = `monospire-worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await renderMermaidSvg(api, renderId, code);
      ipcRenderer.send('mermaid-render-response', {
        id,
        ok: true,
        svg: typeof result?.svg === 'string' ? result.svg : ''
      });
      logWorker('render.success', { id, bytes: (typeof result?.svg === 'string' ? result.svg.length : 0) });
    } catch (error) {
      ipcRenderer.send('mermaid-render-response', {
        id,
        ok: false,
        error: String(error?.message || error || 'Mermaid render failed.')
      });
      logWorker('render.error', { id, error: String(error?.message || error || 'Mermaid render failed.') });
    }
  }).catch(() => {
    // Keep queue alive if previous render failed unexpectedly.
  });
});

logWorker('ready.send');
ipcRenderer.send('mermaid-worker-ready');

const { contextBridge, ipcRenderer } = require('electron');
try {
  require('fs').appendFileSync('/tmp/monospire-preload.log', `${new Date().toISOString()} preload entered pid=${process.pid}\n`, 'utf8');
} catch {
  // Ignore preload bootstrap logging failures.
}

async function invokeWithFallback(invokeChannel, syncChannel, payload) {
  try {
    return await ipcRenderer.invoke(invokeChannel, payload);
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes('No handler registered')) {
      return ipcRenderer.sendSync(syncChannel, payload);
    }
    throw error;
  }
}

const nativeApi = {
  chooseCssFile: () => ipcRenderer.invoke('choose-css-file'),
  chooseCssTheme: () => invokeWithFallback('choose-css-theme', 'choose-css-theme-sync'),
  loadBundledTheme: (payload) => ipcRenderer.invoke('load-bundled-theme', payload),
  chooseTemplateFile: () => invokeWithFallback('choose-template-file', 'choose-template-file-sync'),
  readCssFile: (filePath) => invokeWithFallback('read-css-file', 'read-css-file-sync', filePath),
  openFile: () => invokeWithFallback('file-open', 'file-open-sync'),
  openFilePath: (payload) => ipcRenderer.invoke('file-open-path', payload),
  saveFile: (payload) => invokeWithFallback('file-save', 'file-save-sync', payload),
  saveFileAs: (payload) => invokeWithFallback('file-save-as', 'file-save-as-sync', payload),
  exportToPages: (payload) => ipcRenderer.invoke('file-export-pages', payload),
  saveThemePreference: (payload) => ipcRenderer.invoke('save-theme-preference', payload),
  loadThemePreference: () => ipcRenderer.invoke('load-theme-preference'),
  saveDefaultTemplatePreference: (payload) => ipcRenderer.invoke('save-default-template-preference', payload),
  loadDefaultTemplatePreference: () => ipcRenderer.invoke('load-default-template-preference'),
  saveDarkModePreference: (payload) => ipcRenderer.invoke('save-dark-mode-preference', payload),
  loadDarkModePreference: () => ipcRenderer.invoke('load-dark-mode-preference'),
  saveDarkModeSyncPreference: (payload) => ipcRenderer.invoke('save-dark-mode-sync-preference', payload),
  loadDarkModeSyncPreference: () => ipcRenderer.invoke('load-dark-mode-sync-preference'),
  getSystemDarkMode: () => ipcRenderer.invoke('get-system-dark-mode'),
  saveRibbonModePreference: (payload) => ipcRenderer.invoke('save-ribbon-mode-preference', payload),
  loadRibbonModePreference: () => ipcRenderer.invoke('load-ribbon-mode-preference'),
  saveSyncViewsPreference: (payload) => ipcRenderer.invoke('save-sync-views-preference', payload),
  loadSyncViewsPreference: () => ipcRenderer.invoke('load-sync-views-preference'),
  saveWordWrapPreference: (payload) => ipcRenderer.invoke('save-word-wrap-preference', payload),
  loadWordWrapPreference: () => ipcRenderer.invoke('load-word-wrap-preference'),
  saveMermaidPreviewPreference: (payload) => ipcRenderer.invoke('save-mermaid-preview-preference', payload),
  loadMermaidPreviewPreference: () => ipcRenderer.invoke('load-mermaid-preview-preference'),
  loadMermaidPreviewCrashNotice: () => ipcRenderer.invoke('load-mermaid-preview-crash-notice'),
  clearMermaidPreviewCrashNotice: () => ipcRenderer.invoke('clear-mermaid-preview-crash-notice'),
  saveOutlinePreference: (payload) => ipcRenderer.invoke('save-outline-preference', payload),
  loadOutlinePreference: () => ipcRenderer.invoke('load-outline-preference'),
  saveKeybindingsPreference: (payload) => ipcRenderer.invoke('save-keybindings-preference', payload),
  loadKeybindingsPreference: () => ipcRenderer.invoke('load-keybindings-preference'),
  loadLastSession: () => ipcRenderer.invoke('load-last-session'),
  sendSessionState: (payload) => ipcRenderer.send('session-state-update', payload),
  saveSnapshot: (payload) => ipcRenderer.invoke('save-snapshot', payload),
  listSnapshots: (payload) => ipcRenderer.invoke('list-snapshots', payload),
  readSnapshot: (payload) => ipcRenderer.invoke('read-snapshot', payload),
  getRecentFiles: () => ipcRenderer.invoke('get-recent-files'),
  addRecentFile: (payload) => ipcRenderer.invoke('add-recent-file', payload),
  clearRecentFiles: () => ipcRenderer.invoke('clear-recent-files'),
  setDocumentState: (payload) => ipcRenderer.send('set-document-state', payload),
  updateMenuState: (payload) => ipcRenderer.send('update-menu-state', payload),
  quitApp: () => ipcRenderer.send('app-quit'),
  newWindow: () => ipcRenderer.send('new-window'),
  setSpellcheckLanguage: (payload) => ipcRenderer.invoke('set-spellcheck-language', payload),
  showUnsavedDialog: (payload) => ipcRenderer.invoke('show-unsaved-dialog', payload),
  confirmCloseWindow: () => ipcRenderer.invoke('confirm-close-window'),
  showAboutDialog: () => ipcRenderer.invoke('show-about-dialog'),
  checkLinks: (payload) => ipcRenderer.invoke('check-links', payload),
  showThemeLoadErrorDialog: (payload) => ipcRenderer.invoke('show-theme-load-error-dialog', payload),
  showTemplateLoadErrorDialog: (payload) => ipcRenderer.invoke('show-template-load-error-dialog', payload),
  showMermaidPreviewDisabledDialog: () => ipcRenderer.invoke('show-mermaid-preview-disabled-dialog'),
  renderMermaid: (payload) => ipcRenderer.invoke('render-mermaid', payload),
  renderMermaidCli: (payload) => ipcRenderer.invoke('render-mermaid-cli', payload),
  diagnosticLog: (payload) => ipcRenderer.send('diagnostic-log', payload),
  onMenuAction: (handler) => ipcRenderer.on('menu-action', (_event, payload) => handler(payload))
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('nativeApi', nativeApi);
} else {
  window.nativeApi = nativeApi;
}

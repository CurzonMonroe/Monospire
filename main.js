try {
  require('fs').appendFileSync('/tmp/monospire-bootstrap.log', `${new Date().toISOString()} main.js entered pid=${process.pid} argv=${JSON.stringify(process.argv)}\n`, 'utf8');
} catch {
  // Ignore bootstrap logging failures.
}

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');

app.setName('Monospire');
let recentFilesCache = [];
const windowSessionState = new Map();
let isQuittingForSessionPersist = false;
let diagnosticsPathCache = null;
const diagnosticsTmpPath = path.join(os.tmpdir(), 'monospire-diagnostics.log');
let mermaidWorkerWindow = null;
let mermaidWorkerReady = false;
let mermaidWorkerLoadingPromise = null;
const mermaidPendingRequests = new Map();
const BUNDLED_THEMES = [
  { label: 'GitHub Style', fileName: 'monospire-github.css' },
  { label: 'Minimal / Typographic', fileName: 'monospire-minimal.css' },
  { label: 'Dark Mode', fileName: 'monospire-darkmode.css' },
  { label: 'VS Code Preview', fileName: 'monospire-vscode.css' },
  { label: 'Solarized', fileName: 'monospire-solarized.css' },
  { label: 'Academic / Document', fileName: 'monospire-academic.css' },
  { label: 'Corporate / Documentation', fileName: 'monospire-corporate.css' },
  { label: 'Dracula Inspired', fileName: 'monospire-dracula.css' },
  { label: 'Print Optimised', fileName: 'monospire-print.css' },
  { type: 'separator' },
  { label: 'Monospire Ink', fileName: 'monospire-ink.css' },
  { label: 'Monospire Roboto Courier', fileName: 'monospire-roboto-courier.css' }
];

function getDiagnosticsPath() {
  if (diagnosticsPathCache) return diagnosticsPathCache;
  try {
    diagnosticsPathCache = path.join(app.getPath('userData'), 'monospire-diagnostics.log');
  } catch {
    diagnosticsPathCache = path.join(os.tmpdir(), 'monospire-diagnostics.log');
  }
  return diagnosticsPathCache;
}

function serializeForDiagnostics(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry instanceof Error) {
        output[key] = {
          name: entry.name,
          message: entry.message,
          stack: entry.stack
        };
      } else {
        output[key] = entry;
      }
    }
    return output;
  }
  return value;
}

function logDiagnostics(channel, payload = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    channel,
    payload: serializeForDiagnostics(payload)
  });
  const targets = [getDiagnosticsPath(), diagnosticsTmpPath];
  const seen = new Set();
  for (const target of targets) {
    if (!target || seen.has(target)) continue;
    seen.add(target);
    try {
      const dir = path.dirname(target);
      fsSync.mkdirSync(dir, { recursive: true });
      fsSync.appendFileSync(target, `${line}\n`, 'utf8');
    } catch {
      // Best-effort diagnostics only.
    }
  }
}

process.on('uncaughtException', (error) => {
  logDiagnostics('process.uncaughtException', { error });
});

process.on('unhandledRejection', (reason) => {
  logDiagnostics('process.unhandledRejection', { reason: serializeForDiagnostics(reason) });
});

logDiagnostics('main.module.loaded', {
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch
});

function getSnapshotsRoot() {
  return path.join(app.getPath('userData'), 'snapshots');
}

function sanitizeSnapshotKey(key) {
  return String(key || 'untitled')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 96) || 'untitled';
}

function snapshotDirForKey(key) {
  return path.join(getSnapshotsRoot(), sanitizeSnapshotKey(key));
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'monospire-settings.json');
}

function escapeAppleScriptString(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || 'osascript failed').trim()));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function runExecFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject({
          error,
          stdout: String(stdout || ''),
          stderr: String(stderr || '')
        });
        return;
      }
      resolve({
        stdout: String(stdout || ''),
        stderr: String(stderr || '')
      });
    });
  });
}

async function convertDocxToPages(sourceDocxPath, targetPagesPath) {
  const src = escapeAppleScriptString(sourceDocxPath);
  const dst = escapeAppleScriptString(targetPagesPath);
  const script = `
set srcFile to POSIX file "${src}"
set dstFile to POSIX file "${dst}"
tell application "Pages"
  activate
  set importedDoc to open srcFile
  delay 0.3
  save importedDoc in dstFile
  close importedDoc saving no
end tell
`;
  await runAppleScript(script);
}

async function readSettings() {
  const settingsPath = getSettingsPath();
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return {};
  } catch {
    return {};
  }
}

async function writeSettings(nextSettings) {
  const settingsPath = getSettingsPath();
  const payload = JSON.stringify(nextSettings || {}, null, 2);
  await fs.writeFile(settingsPath, payload, 'utf8');
}

async function markMermaidPreviewCrashRecovery() {
  const settings = await readSettings();
  settings.mermaidPreviewEnabled = false;
  settings.mermaidPreviewCrashNotice = true;
  await writeSettings(settings);
}

function rejectPendingMermaidRequests(errorMessage) {
  for (const pending of mermaidPendingRequests.values()) {
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, error: errorMessage });
  }
  mermaidPendingRequests.clear();
}

function ensureMermaidWorkerWindow() {
  if (mermaidWorkerWindow && !mermaidWorkerWindow.isDestroyed() && mermaidWorkerReady) {
    return Promise.resolve(mermaidWorkerWindow);
  }
  if (mermaidWorkerLoadingPromise) return mermaidWorkerLoadingPromise;

  mermaidWorkerLoadingPromise = new Promise((resolve) => {
    mermaidWorkerReady = false;
    if (mermaidWorkerWindow && !mermaidWorkerWindow.isDestroyed()) {
      try {
        mermaidWorkerWindow.destroy();
      } catch {
        // Ignore stale worker destruction errors.
      }
    }

    mermaidWorkerWindow = new BrowserWindow({
      show: false,
      width: 32,
      height: 32,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false
      }
    });
    mermaidWorkerWindow.__isMermaidWorker = true;

    mermaidWorkerWindow.on('closed', () => {
      mermaidWorkerWindow = null;
      mermaidWorkerReady = false;
      mermaidWorkerLoadingPromise = null;
      rejectPendingMermaidRequests('Mermaid worker window closed.');
      logDiagnostics('mermaid.worker.closed');
    });

    mermaidWorkerWindow.webContents.on('render-process-gone', (_event, details) => {
      mermaidWorkerReady = false;
      mermaidWorkerLoadingPromise = null;
      rejectPendingMermaidRequests(`Mermaid worker crashed (${details?.reason || 'unknown'}).`);
      logDiagnostics('mermaid.worker.render-process-gone', { details });
    });

    mermaidWorkerWindow.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
      mermaidWorkerReady = false;
      mermaidWorkerLoadingPromise = null;
      rejectPendingMermaidRequests(`Mermaid worker failed to load (${errorCode} ${errorDescription}).`);
      logDiagnostics('mermaid.worker.did-fail-load', { errorCode, errorDescription });
      resolve(mermaidWorkerWindow);
    });

    mermaidWorkerWindow.webContents.once('did-finish-load', () => {
      logDiagnostics('mermaid.worker.did-finish-load');
    });

    void mermaidWorkerWindow.loadFile('mermaid-worker.html').catch((error) => {
      mermaidWorkerReady = false;
      mermaidWorkerLoadingPromise = null;
      rejectPendingMermaidRequests(String(error?.message || error || 'Mermaid worker load failed.'));
      logDiagnostics('mermaid.worker.load.error', { error: String(error?.message || error || 'unknown') });
      resolve(mermaidWorkerWindow);
    });

    // Resolve even before ready; callers wait for ready event below.
    resolve(mermaidWorkerWindow);
  });

  return mermaidWorkerLoadingPromise;
}

function sendMenuAction(action, payload = {}) {
  const focused = BrowserWindow.getFocusedWindow();
  const window = focused && !focused.__isMermaidWorker
    ? focused
    : (getDocumentWindows().find((candidate) => !candidate.isDestroyed()) || null);
  if (!window) {
    logDiagnostics('menu-action.dropped', { action, reason: 'no-document-window' });
    return;
  }
  window.webContents.send('menu-action', { action, payload });
}

function getBundledThemeFilePath(fileName) {
  if (typeof fileName !== 'string' || !fileName.trim()) return null;
  const safeName = path.basename(fileName.trim());
  if (!safeName.toLowerCase().endsWith('.css')) return null;
  const themesRoot = path.join(__dirname, 'themes');
  const fullPath = path.resolve(themesRoot, safeName);
  if (!fullPath.startsWith(path.resolve(themesRoot) + path.sep)) return null;
  if (!fsSync.existsSync(fullPath)) return null;
  return fullPath;
}

function getThemeMenuItemId(fileName) {
  const safe = String(fileName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `theme-bundled-${safe || 'unknown'}`;
}

function getDocumentWindows() {
  return BrowserWindow.getAllWindows().filter((window) => !window.__isMermaidWorker);
}

function normalizeRecentFiles(input) {
  const seen = new Set();
  const output = [];
  const values = Array.isArray(input) ? input : [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
    if (output.length >= 10) break;
  }
  return output;
}

async function refreshRecentFilesCache() {
  const settings = await readSettings();
  recentFilesCache = normalizeRecentFiles(settings.recentFiles);
  return recentFilesCache;
}

async function saveRecentFiles(nextRecentFiles) {
  const settings = await readSettings();
  recentFilesCache = normalizeRecentFiles(nextRecentFiles);
  settings.recentFiles = recentFilesCache;
  await writeSettings(settings);
  return recentFilesCache;
}

function normalizeKeybindings(input) {
  const output = {};
  if (!input || typeof input !== 'object') return output;
  for (const [action, combo] of Object.entries(input)) {
    if (typeof action !== 'string' || typeof combo !== 'string') continue;
    const actionValue = action.trim();
    const comboValue = combo.trim();
    if (!actionValue || !comboValue) continue;
    output[actionValue] = comboValue;
  }
  return output;
}

function normalizeSingleWindowSession(input) {
  if (!input || typeof input !== 'object') return null;
  const markdown = typeof input.markdown === 'string' ? input.markdown : '';
  return {
    currentFilePath: typeof input.currentFilePath === 'string' ? input.currentFilePath : null,
    currentFileName: typeof input.currentFileName === 'string' ? input.currentFileName : 'Untitled.md',
    markdown,
    savedBaseline: typeof input.savedBaseline === 'string' ? input.savedBaseline : markdown,
    isDirty: Boolean(input.isDirty),
    rawSelectionStart: Number.isFinite(input.rawSelectionStart) ? Math.max(0, Number(input.rawSelectionStart)) : 0,
    rawSelectionEnd: Number.isFinite(input.rawSelectionEnd) ? Math.max(0, Number(input.rawSelectionEnd)) : 0,
    rawScrollTop: Number.isFinite(input.rawScrollTop) ? Math.max(0, Number(input.rawScrollTop)) : 0,
    previewScrollTop: Number.isFinite(input.previewScrollTop) ? Math.max(0, Number(input.previewScrollTop)) : 0,
    showRaw: input.showRaw !== false,
    showFormatted: input.showFormatted !== false,
    splitOrientation: input.splitOrientation === 'vertical' ? 'vertical' : 'horizontal',
    lastSavedAt: typeof input.lastSavedAt === 'string' ? input.lastSavedAt : null,
    docSessionKey: typeof input.docSessionKey === 'string' ? input.docSessionKey : ''
  };
}

function normalizeSessionCollection(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry) => normalizeSingleWindowSession(entry))
    .filter((entry) => Boolean(entry))
    .slice(0, 12);
}

async function persistSessionFromWindows() {
  const settings = await readSettings();
  const snapshots = [];
  for (const window of BrowserWindow.getAllWindows()) {
    const key = window.webContents.id;
    const fromMap = windowSessionState.get(key);
    if (fromMap) snapshots.push(normalizeSingleWindowSession(fromMap));
  }
  settings.lastSession = normalizeSessionCollection(snapshots);
  await writeSettings(settings);
}

function buildOpenRecentSubmenu() {
  const submenu = [];
  if (recentFilesCache.length === 0) {
    submenu.push({ label: 'No Recent Files', enabled: false });
  } else {
    for (const filePath of recentFilesCache) {
      submenu.push({
        label: path.basename(filePath),
        sublabel: filePath,
        click: () => sendMenuAction('file-open-recent', { path: filePath })
      });
    }
  }

  submenu.push({ type: 'separator' });
  submenu.push({
    label: 'Clear Menu',
    enabled: recentFilesCache.length > 0,
    click: () => sendMenuAction('file-clear-recent')
  });
  return submenu;
}

function resolveAppIconPath() {
  const candidates = [
    path.join(__dirname, 'assets', 'monospire-icon-1024.png'),
    path.join(__dirname, 'assets', 'Monospire.icns'),
    path.join(__dirname, 'assets', 'monospire-icon.svg')
  ];

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveDockIconPath() {
  const candidates = [
    path.join(__dirname, 'assets', 'monospire-icon-1024.png'),
    path.join(__dirname, 'assets', 'Monospire.icns'),
    path.join(__dirname, 'assets', 'monospire-icon.svg')
  ];

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) return candidate;
  }
  return null;
}

function applyDockIcon() {
  if (process.platform !== 'darwin') return;
  const dockIconPath = resolveDockIconPath();
  if (!dockIconPath) return;
  const icon = nativeImage.createFromPath(dockIconPath);
  if (!icon.isEmpty()) {
    app.dock.setIcon(icon);
  }
}

function buildAppMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuAction('file-new')
        },
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => sendMenuAction('file-new-window')
        },
        {
          label: 'New from Template...',
          accelerator: 'Alt+CmdOrCtrl+N',
          click: () => sendMenuAction('file-new-from-template')
        },
        { type: 'separator' },
        {
          label: 'Set Default Template...',
          click: () => sendMenuAction('file-set-default-template')
        },
        {
          label: 'Reset Default Template',
          click: () => sendMenuAction('file-reset-default-template')
        },
        { type: 'separator' },
        {
          label: 'Open...',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendMenuAction('file-load')
        },
        {
          label: 'Open Recent',
          submenu: buildOpenRecentSubmenu()
        },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendMenuAction('file-save')
        },
        {
          label: 'Export...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendMenuAction('file-save-as')
        },
        {
          label: 'Version History...',
          click: () => sendMenuAction('open-version-history')
        },
        { type: 'separator' },
        { label: 'Exit', accelerator: 'CmdOrCtrl+Q', click: () => sendMenuAction('app-exit') }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find...', accelerator: 'CmdOrCtrl+F', click: () => sendMenuAction('edit-find') },
        { label: 'Replace...', accelerator: 'Alt+CmdOrCtrl+F', click: () => sendMenuAction('edit-replace') },
        { label: 'Command Palette...', accelerator: 'CmdOrCtrl+Shift+P', click: () => sendMenuAction('open-command-palette') },
        { type: 'separator' },
        {
          label: 'Format',
          submenu: [
            { label: 'Bold', accelerator: 'CmdOrCtrl+B', click: () => sendMenuAction('format-bold') },
            { label: 'Italic', accelerator: 'CmdOrCtrl+I', click: () => sendMenuAction('format-italic') },
            { label: 'Inline Code', accelerator: 'CmdOrCtrl+E', click: () => sendMenuAction('format-inline-code') },
            { label: 'Code Block', click: () => sendMenuAction('format-code-block') },
            { label: 'Highlight', click: () => sendMenuAction('format-highlight') },
            { label: 'Horizontal Line', click: () => sendMenuAction('format-horizontal-rule') },
            { label: 'Increase Indent', click: () => sendMenuAction('format-increase-indent') },
            { label: 'Decrease Indent', click: () => sendMenuAction('format-decrease-indent') },
            { type: 'separator' },
            { label: 'Heading 1', click: () => sendMenuAction('format-heading-1') },
            { label: 'Heading 2', click: () => sendMenuAction('format-heading-2') },
            { label: 'Heading 3', click: () => sendMenuAction('format-heading-3') },
            { label: 'Bulleted List', click: () => sendMenuAction('format-list-bullet') },
            { label: 'Numbered List', click: () => sendMenuAction('format-list-number') },
            { label: 'Blockquote', click: () => sendMenuAction('format-quote') },
            { label: 'Link', click: () => sendMenuAction('format-link') }
          ]
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          id: 'toggle-raw',
          label: 'Show Markdown Editor',
          type: 'checkbox',
          checked: true,
          click: (menuItem) => sendMenuAction('toggle-raw-view', { enabled: menuItem.checked })
        },
        {
          id: 'toggle-formatted',
          label: 'Show Preview',
          type: 'checkbox',
          checked: false,
          click: (menuItem) => sendMenuAction('toggle-formatted-view', { enabled: menuItem.checked })
        },
        { type: 'separator' },
        {
          label: 'Zoom',
          submenu: [
            {
              label: 'Markdown Editor',
              submenu: [
                { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => sendMenuAction('zoom-raw-in') },
                { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => sendMenuAction('zoom-raw-out') },
                { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => sendMenuAction('zoom-raw-reset') }
              ]
            },
            {
              label: 'Preview',
              submenu: [
                { label: 'Zoom In', click: () => sendMenuAction('zoom-formatted-in') },
                { label: 'Zoom Out', click: () => sendMenuAction('zoom-formatted-out') },
                { label: 'Reset Zoom', click: () => sendMenuAction('zoom-formatted-reset') }
              ]
            }
          ]
        },
        { type: 'separator' },
        {
          id: 'sync-views',
          label: 'Syncronise Views',
          type: 'checkbox',
          checked: true,
          click: (item) => sendMenuAction('set-sync-views', { enabled: item.checked })
        },
        { type: 'separator' },
        {
          id: 'toggle-outline',
          label: 'Show Outline',
          type: 'checkbox',
          checked: true,
          click: (item) => sendMenuAction('set-outline-view', { enabled: item.checked })
        },
        {
          id: 'outline-left',
          label: 'Outline Left',
          type: 'radio',
          click: () => sendMenuAction('set-outline-position', { position: 'left' })
        },
        {
          id: 'outline-right',
          label: 'Outline Right',
          type: 'radio',
          checked: true,
          click: () => sendMenuAction('set-outline-position', { position: 'right' })
        },
        { type: 'separator' },
        {
          id: 'split-horizontal-view',
          label: 'Horizontal View',
          type: 'radio',
          checked: true,
          click: () => sendMenuAction('set-split-orientation', { orientation: 'horizontal' })
        },
        {
          id: 'split-vertical-view',
          label: 'Vertical View',
          type: 'radio',
          click: () => sendMenuAction('set-split-orientation', { orientation: 'vertical' })
        }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Themes',
          submenu: [
            ...BUNDLED_THEMES.map((entry) => {
              if (entry.type === 'separator') return { type: 'separator' };
              return {
                id: getThemeMenuItemId(entry.fileName),
                label: entry.label,
                type: 'checkbox',
                click: () => sendMenuAction('load-bundled-theme', { fileName: entry.fileName })
              };
            }),
            { type: 'separator' },
            { label: 'Load Theme...', click: () => sendMenuAction('load-theme') }
          ]
        },
        { label: 'Edit Front Matter...', click: () => sendMenuAction('edit-front-matter') },
        { label: 'Check Links...', click: () => sendMenuAction('check-links') },
        { label: 'Keyboard Shortcuts...', click: () => sendMenuAction('open-keybindings') },
        { type: 'separator' },
        {
          label: 'Export Presets',
          submenu: [
            {
              label: 'HTML Preset',
              submenu: [
                {
                  id: 'export-html-default',
                  label: 'Default',
                  type: 'radio',
                  checked: true,
                  click: () => sendMenuAction('set-export-html-preset', { preset: 'default' })
                },
                {
                  id: 'export-html-article',
                  label: 'Article',
                  type: 'radio',
                  click: () => sendMenuAction('set-export-html-preset', { preset: 'article' })
                },
                {
                  id: 'export-html-compact',
                  label: 'Compact',
                  type: 'radio',
                  click: () => sendMenuAction('set-export-html-preset', { preset: 'compact' })
                }
              ]
            },
            {
              label: 'PDF Theme',
              submenu: [
                {
                  id: 'export-pdf-default',
                  label: 'Default',
                  type: 'radio',
                  checked: true,
                  click: () => sendMenuAction('set-export-pdf-preset', { preset: 'default' })
                },
                {
                  id: 'export-pdf-serif',
                  label: 'Serif',
                  type: 'radio',
                  click: () => sendMenuAction('set-export-pdf-preset', { preset: 'serif' })
                },
                {
                  id: 'export-pdf-dark',
                  label: 'Dark',
                  type: 'radio',
                  click: () => sendMenuAction('set-export-pdf-preset', { preset: 'dark' })
                }
              ]
            },
            {
              label: 'DOCX Style',
              submenu: [
                {
                  id: 'export-docx-default',
                  label: 'Default',
                  type: 'radio',
                  checked: true,
                  click: () => sendMenuAction('set-export-docx-preset', { preset: 'default' })
                },
                {
                  id: 'export-docx-classic',
                  label: 'Classic',
                  type: 'radio',
                  click: () => sendMenuAction('set-export-docx-preset', { preset: 'classic' })
                },
                {
                  id: 'export-docx-report',
                  label: 'Report',
                  type: 'radio',
                  click: () => sendMenuAction('set-export-docx-preset', { preset: 'report' })
                }
              ]
            },
            {
              label: 'Pages Preset',
              submenu: [
                {
                  id: 'export-pages-default',
                  label: 'Default',
                  type: 'radio',
                  checked: true,
                  click: () => sendMenuAction('set-export-pages-preset', { preset: 'default' })
                },
                {
                  id: 'export-pages-manuscript',
                  label: 'Manuscript',
                  type: 'radio',
                  click: () => sendMenuAction('set-export-pages-preset', { preset: 'manuscript' })
                },
                {
                  id: 'export-pages-presentation',
                  label: 'Presentation',
                  type: 'radio',
                  click: () => sendMenuAction('set-export-pages-preset', { preset: 'presentation' })
                }
              ]
            }
          ]
        },
        { type: 'separator' },
        {
          label: 'Interface',
          submenu: [
            {
              id: 'ribbon-icons-only',
              label: 'Ribbon: Icons only',
              type: 'radio',
              click: () => sendMenuAction('ribbon-display', { mode: 'icons' })
            },
            {
              id: 'ribbon-text-only',
              label: 'Ribbon: Text only',
              type: 'radio',
              click: () => sendMenuAction('ribbon-display', { mode: 'text' })
            },
            {
              id: 'ribbon-icons-text',
              label: 'Ribbon: Icons and Text',
              type: 'radio',
              checked: true,
              click: () => sendMenuAction('ribbon-display', { mode: 'both' })
            },
            { type: 'separator' },
            {
              id: 'theme-dark-mode',
              label: 'Dark mode',
              type: 'checkbox',
              checked: false,
              click: (item) => sendMenuAction('set-dark-mode', { enabled: item.checked })
            },
            {
              id: 'theme-sync-system',
              label: 'Sync Dark Mode with System',
              type: 'checkbox',
              checked: false,
              click: (item) => sendMenuAction('set-dark-mode-sync', { enabled: item.checked })
            },
            {
              id: 'display-menu-in-app',
              label: 'Display Menu in App',
              type: 'checkbox',
              checked: false,
              click: (item) => sendMenuAction('set-embedded-menu', { enabled: item.checked })
            }
          ]
        },
        {
          label: 'Proofing',
          submenu: [
            {
              id: 'spell-check',
              label: 'Spell Check',
              type: 'checkbox',
              checked: true,
              click: (item) => sendMenuAction('set-spellcheck', { enabled: item.checked })
            },
            {
              id: 'dictionary-en-us',
              label: 'Dictionary: English (US)',
              type: 'radio',
              checked: true,
              click: () => sendMenuAction('set-dictionary-language', { language: 'en-US' })
            },
            {
              id: 'dictionary-en-gb',
              label: 'Dictionary: English (UK)',
              type: 'radio',
              click: () => sendMenuAction('set-dictionary-language', { language: 'en-GB' })
            }
          ]
        },
        { type: 'separator' },
        {
          id: 'mermaid-preview-experimental',
          label: 'Mermaid Preview (Experimental)',
          type: 'checkbox',
          checked: false,
          click: (item) => sendMenuAction('set-mermaid-preview', { enabled: item.checked })
        },
        {
          id: 'display-theme-debug',
          label: 'Show Theme Debug',
          accelerator: 'CmdOrCtrl+Shift+D',
          type: 'checkbox',
          checked: false,
          click: (item) => sendMenuAction('set-theme-debug', { enabled: item.checked })
        },
        { type: 'separator' },
        { label: 'About Monospire', click: () => sendMenuAction('show-about') }
      ]
    }
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: 'Monospire',
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit', label: 'Exit' }]
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

async function exportMarkdownPdf(filePath, payload) {
  const htmlContent = payload?.renderedHtml || '';
  const themeCss = payload?.themeCssText || '';
  const darkMode = Boolean(payload?.darkMode);
  const presetCss = getExportPresetCss('pdf', payload?.exportPresets?.pdf, darkMode);

  const pdfWindow = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: {
      sandbox: true
    }
  });

  const printableHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; padding: 0; }
      body {
        padding: 24px;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
        font-size: 14px;
        line-height: 1.6;
        color: #1f1f23;
        background: #ffffff;
      }
      body.theme-dark {
        color: #ecedf0;
        background: #1b1e24;
      }
      pre { background: #f3f3f7; border-radius: 8px; padding: 12px; overflow-x: auto; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
      body.theme-dark pre { background: #2b3039; }
      img, video, iframe { max-width: 100%; height: auto; }
      ${themeCss}
      ${presetCss}
    </style>
  </head>
  <body class="${darkMode ? 'theme-dark' : ''}">${htmlContent}</body>
</html>`;

  try {
    await pdfWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(printableHtml)}`);
    const pdfData = await pdfWindow.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
      pageSize: 'A4'
    });
    await fs.writeFile(filePath, pdfData);
  } finally {
    if (!pdfWindow.isDestroyed()) {
      pdfWindow.destroy();
    }
  }
}

async function exportMarkdownHtml(filePath, payload) {
  const htmlContent = payload?.renderedHtml || '';
  const themeCss = payload?.themeCssText || '';
  const darkMode = Boolean(payload?.darkMode);
  const presetCss = getExportPresetCss('html', payload?.exportPresets?.html, darkMode);

  const fullHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Monospire Export</title>
    <style>
      html, body { margin: 0; padding: 0; }
      body {
        padding: 28px;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
        font-size: 15px;
        line-height: 1.6;
        color: #1f1f23;
        background: #ffffff;
      }
      body.theme-dark {
        color: #ecedf0;
        background: #1b1e24;
      }
      pre { background: #f3f3f7; border-radius: 8px; padding: 12px; overflow-x: auto; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
      body.theme-dark pre { background: #2b3039; }
      img, video, iframe { max-width: 100%; height: auto; }
      ${themeCss}
      ${presetCss}
    </style>
  </head>
  <body class="${darkMode ? 'theme-dark' : ''}">${htmlContent}</body>
</html>`;
  await fs.writeFile(filePath, fullHtml, 'utf8');
}

async function buildInlineStyledDocxHtml(payload) {
  const htmlContent = payload?.renderedHtml || '';
  const themeCss = payload?.themeCssText || '';
  const darkMode = Boolean(payload?.darkMode);
  const docxPreset = payload?.exportKind === 'pages'
    ? payload?.exportPresets?.pages
    : payload?.exportPresets?.docx;
  const presetCss = getExportPresetCss(payload?.exportKind === 'pages' ? 'pages' : 'docx', docxPreset, darkMode);

  const fullHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
        font-size: 14px;
        line-height: 1.6;
        color: #1f1f23;
      }
      pre { background: #f3f3f7; border-radius: 8px; padding: 12px; overflow-x: auto; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
      ${darkMode ? 'body { color: #ecedf0; background: #1b1e24; } pre { background: #2b3039; }' : ''}
      ${themeCss}
      ${presetCss}
    </style>
  </head>
  <body>${htmlContent}</body>
</html>`;

  const styleWindow = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: {
      sandbox: true
    }
  });

  try {
    await styleWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`);
    const inlined = await styleWindow.webContents.executeJavaScript(`
      (() => {
        const props = [
          'font-family','font-size','font-weight','font-style','line-height','color',
          'text-align','text-decoration-line','text-decoration-color','text-transform','letter-spacing',
          'margin-top','margin-right','margin-bottom','margin-left',
          'padding-top','padding-right','padding-bottom','padding-left',
          'border-top-width','border-right-width','border-bottom-width','border-left-width',
          'border-top-style','border-right-style','border-bottom-style','border-left-style',
          'border-top-color','border-right-color','border-bottom-color','border-left-color',
          'border-radius','display','white-space','vertical-align','list-style-type'
        ];

        const includeBackgroundFor = new Set(['PRE', 'CODE', 'BLOCKQUOTE', 'TABLE', 'TH', 'TD']);

        const normalizeColor = (value) => String(value || '').trim().toLowerCase();

        const shouldKeepBackground = (el, value) => {
          const color = normalizeColor(value);
          if (!includeBackgroundFor.has(el.tagName)) return false;
          if (!color) return false;
          if (color === 'transparent') return false;
          if (color === 'rgba(0, 0, 0, 0)' || color === 'rgba(0,0,0,0)') return false;
          return true;
        };

        const apply = (el) => {
          const cs = window.getComputedStyle(el);
          const style = [];
          for (const p of props) {
            const value = cs.getPropertyValue(p);
            if (!value || value === 'initial' || value === 'normal' || value === 'none' || value === 'auto') continue;
            style.push(\`\${p}: \${value}\`);
          }
          const bg = cs.getPropertyValue('background-color');
          if (shouldKeepBackground(el, bg)) {
            style.push(\`background-color: \${bg}\`);
          }
          if (style.length > 0) el.setAttribute('style', style.join('; '));
        };

        apply(document.body);
        for (const el of document.body.querySelectorAll('*')) apply(el);
        return '<!doctype html><html><head><meta charset="utf-8" /></head><body style="' +
          (document.body.getAttribute('style') || '') + '">' + document.body.innerHTML + '</body></html>';
      })();
    `);
    return String(inlined || fullHtml);
  } finally {
    if (!styleWindow.isDestroyed()) {
      styleWindow.destroy();
    }
  }
}

async function exportMarkdownDocx(filePath, payload) {
  const htmlToDocx = require('html-to-docx');
  const fullHtml = await buildInlineStyledDocxHtml(payload);

  const docxBuffer = await htmlToDocx(fullHtml, null, {
    table: { row: { cantSplit: true } },
    footer: false,
    pageNumber: false
  });
  await fs.writeFile(filePath, docxBuffer);
}

function getExportPresetCss(format, preset, darkMode) {
  const htmlPresets = {
    default: '',
    article: `
      body { max-width: 860px; margin: 0 auto; font-family: Georgia, "Times New Roman", serif; font-size: 17px; line-height: 1.75; }
      h1, h2, h3, h4 { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif; }
      p { margin: 0.75em 0; }
    `,
    compact: `
      body { max-width: 980px; margin: 0 auto; font-size: 13px; line-height: 1.45; }
      h1, h2, h3, h4 { margin: 0.55em 0 0.3em 0; }
      p, ul, ol { margin: 0.35em 0; }
      pre { font-size: 12px; }
    `
  };

  const pdfPresets = {
    default: '',
    serif: `
      body { font-family: Georgia, "Times New Roman", serif; font-size: 13px; line-height: 1.75; }
      h1, h2, h3, h4 { font-family: "Times New Roman", Georgia, serif; }
    `,
    dark: darkMode
      ? `
        body { background: #101216 !important; color: #edf0f6 !important; }
        pre { background: #1e2430 !important; border: 1px solid #31394a; }
      `
      : `
        body { background: #ffffff !important; color: #1f1f23 !important; }
      `
  };

  const docxPresets = {
    default: '',
    classic: `
      body { font-family: "Times New Roman", Georgia, serif; font-size: 12pt; line-height: 1.6; }
      h1, h2, h3, h4 { font-family: "Times New Roman", Georgia, serif; }
    `,
    report: `
      body { font-family: Calibri, "Helvetica Neue", Arial, sans-serif; font-size: 11pt; line-height: 1.5; }
      h1 { font-size: 22pt; border-bottom: 1px solid #d8d8df; padding-bottom: 6px; }
      h2 { font-size: 16pt; margin-top: 1.4em; }
      table { border-collapse: collapse; }
    `
  };

  const pagesPresets = {
    default: `
      body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 12pt; line-height: 1.5; }
    `,
    manuscript: `
      body { font-family: Georgia, "Times New Roman", serif; font-size: 12pt; line-height: 1.9; margin: 0 36pt; }
      h1, h2, h3, h4 { font-family: Georgia, "Times New Roman", serif; }
      p { margin: 0.75em 0; }
    `,
    presentation: `
      body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif; font-size: 13pt; line-height: 1.55; }
      h1 { font-size: 26pt; margin-bottom: 0.35em; }
      h2 { font-size: 19pt; margin-top: 1.2em; }
      p { margin: 0.45em 0; }
    `
  };

  if (format === 'html') return htmlPresets[preset] || htmlPresets.default;
  if (format === 'pdf') return pdfPresets[preset] || pdfPresets.default;
  if (format === 'docx') return docxPresets[preset] || docxPresets.default;
  if (format === 'pages') return pagesPresets[preset] || pagesPresets.default;
  return '';
}

async function exportMarkdownPages(filePath, payload, options = {}) {
  const openAfterExport = options.openAfterExport === true;
  const exportPath = String(filePath || '').toLowerCase().endsWith('.pages') ? filePath : `${filePath}.pages`;
  const tempDocxPath = path.join(
    os.tmpdir(),
    `monospire-pages-${Date.now()}-${crypto.randomUUID()}.docx`
  );
  try {
    await exportMarkdownDocx(tempDocxPath, { ...payload, exportKind: 'pages' });
    await convertDocxToPages(tempDocxPath, exportPath);
    if (openAfterExport) {
      await shell.openPath(exportPath);
    }
    return exportPath;
  } finally {
    try {
      await fs.unlink(tempDocxPath);
    } catch {
      // Temporary file cleanup is best-effort.
    }
  }
}

ipcMain.handle('file-export-pages', async (_event, payload) => {
  const suggested = payload?.path
    ? `${path.basename(payload.path, path.extname(payload.path))}.pages`
    : 'Untitled.pages';
  const result = await dialog.showSaveDialog({
    title: 'Export to Pages',
    defaultPath: suggested,
    filters: [{ name: 'Pages Document', extensions: ['pages'] }]
  });

  if (result.canceled || !result.filePath) return { saved: false };

  try {
    const exportPath = await exportMarkdownPages(result.filePath, payload, { openAfterExport: true });
    return {
      saved: true,
      path: exportPath,
      name: path.basename(exportPath),
      savedAt: new Date().toISOString(),
      openedInPages: true
    };
  } catch (error) {
    return {
      saved: false,
      error: String(error?.message || error || 'Unable to export Pages document. Ensure Apple Pages is installed.')
    };
  }
});

function createWindow(initialSessionState = null) {
  logDiagnostics('window.create.start', {
    hasInitialSessionState: Boolean(initialSessionState)
  });
  const iconPath = resolveAppIconPath();
  const window = new BrowserWindow({
    width: 1260,
    height: 860,
    minWidth: 980,
    minHeight: 660,
    title: 'Monospire',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f3f3f7',
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: true,
      spellcheck: true
    }
  });
  window.__isMermaidWorker = false;

  window.loadFile('index.html');
  logDiagnostics('window.loadFile.called', { file: 'index.html' });
  applyDockIcon();
  window.__mermaidPreviewEnabled = false;
  const webContentsId = window.webContents.id;
  logDiagnostics('window.created', { webContentsId });
  window.webContents.once('did-finish-load', () => {
    logDiagnostics('window.did-finish-load', { webContentsId });
    if (!initialSessionState) return;
    window.webContents.send('menu-action', { action: 'restore-session', payload: { state: initialSessionState } });
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logDiagnostics('window.did-fail-load', {
      webContentsId,
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame
    });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    logDiagnostics('window.render-process-gone', { webContentsId, details });
    if (details?.reason === 'crashed' && window.__mermaidPreviewEnabled) {
      void markMermaidPreviewCrashRecovery();
      logDiagnostics('window.render-process-gone.mermaid-preview-recovery-set', { webContentsId });
    }
  });
  window.webContents.on('unresponsive', () => {
    logDiagnostics('window.webContents.unresponsive', { webContentsId });
  });
  window.on('unresponsive', () => {
    logDiagnostics('window.unresponsive', { webContentsId });
  });
  window.on('responsive', () => {
    logDiagnostics('window.responsive', { webContentsId });
  });

  const openExternalFromNavigation = (event, url) => {
    if (!url) return;
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:')) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  };

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:'))) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  window.webContents.on('will-navigate', openExternalFromNavigation);
  window.webContents.on('will-frame-navigate', openExternalFromNavigation);

  window.webContents.on('context-menu', (event, params) => {
    const isEditable = Boolean(params.isEditable);
    const template = [];

    if (isEditable && params.misspelledWord) {
      const suggestions = (params.dictionarySuggestions || []).slice(0, 8);
      if (suggestions.length > 0) {
        for (const suggestion of suggestions) {
          template.push({
            label: suggestion,
            click: () => window.webContents.replaceMisspelling(suggestion)
          });
        }
      } else {
        template.push({ label: 'No Suggestions', enabled: false });
      }
      template.push({
        label: `Add "${params.misspelledWord}" to Dictionary`,
        click: () => window.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      });
      template.push({ type: 'separator' });
    }

    if (isEditable) {
      template.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste }
      );
    } else if (params.selectionText) {
      template.push({ role: 'copy', enabled: params.editFlags.canCopy });
    }

    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window });
  });

  window.on('close', (event) => {
    logDiagnostics('window.close.requested', { webContentsId, allowClose: Boolean(window.__allowClose) });
    if (window.__allowClose) {
      window.__allowClose = false;
      return;
    }
    const wc = window.webContents;
    if (!wc || wc.isDestroyed()) {
      window.__allowClose = true;
      return;
    }

    event.preventDefault();
    try {
      wc.send('menu-action', { action: 'request-close', payload: {} });
    } catch {
      // Renderer is already gone; allow native close to continue.
      window.__allowClose = true;
      if (!window.isDestroyed()) {
        setImmediate(() => {
          if (!window.isDestroyed()) window.close();
        });
      }
    }
  });

  window.on('closed', () => {
    logDiagnostics('window.closed', { webContentsId });
    if (!isQuittingForSessionPersist) {
      windowSessionState.delete(webContentsId);
    }
    if (getDocumentWindows().length === 0 && mermaidWorkerWindow && !mermaidWorkerWindow.isDestroyed()) {
      try {
        mermaidWorkerWindow.destroy();
      } catch {
        // Best-effort worker cleanup.
      }
    }
  });
}

ipcMain.handle('choose-css-file', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose Markdown CSS',
    properties: ['openFile'],
    filters: [{ name: 'CSS files', extensions: ['css'] }]
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.on('diagnostic-log', (event, payload) => {
  logDiagnostics('renderer', {
    webContentsId: event.sender.id,
    ...((payload && typeof payload === 'object') ? payload : { message: String(payload || '') })
  });
});

ipcMain.on('mermaid-worker-ready', () => {
  mermaidWorkerReady = true;
  logDiagnostics('mermaid.worker.ready');
});

ipcMain.on('mermaid-render-response', (_event, payload) => {
  const id = typeof payload?.id === 'string' ? payload.id : '';
  if (!id) return;
  const pending = mermaidPendingRequests.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  mermaidPendingRequests.delete(id);
  pending.resolve({
    ok: payload?.ok === true,
    svg: typeof payload?.svg === 'string' ? payload.svg : '',
    error: typeof payload?.error === 'string' ? payload.error : ''
  });
});

ipcMain.handle('render-mermaid', async (_event, payload) => {
  const code = typeof payload?.code === 'string' ? payload.code : '';
  const darkMode = payload?.darkMode === true;
  if (!code.trim()) {
    return { ok: false, error: 'Empty Mermaid source.' };
  }

  try {
    const worker = await ensureMermaidWorkerWindow();
    if (!worker || worker.isDestroyed()) {
      return { ok: false, error: 'Mermaid worker unavailable.' };
    }

    if (!mermaidWorkerReady) {
      const readyBy = Date.now() + 2000;
      while (!mermaidWorkerReady && Date.now() < readyBy) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    }
    if (!mermaidWorkerReady) {
      return { ok: false, error: 'Mermaid worker not ready.' };
    }

    const id = `mermaid-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        mermaidPendingRequests.delete(id);
        resolve({ ok: false, error: 'Mermaid render timed out.' });
      }, 8000);

      mermaidPendingRequests.set(id, { resolve, timer });
      worker.webContents.send('mermaid-render-request', { id, code, darkMode });
    });
  } catch (error) {
    return { ok: false, error: String(error?.message || error || 'Mermaid render failed.') };
  }
});

ipcMain.handle('render-mermaid-cli', async (_event, payload) => {
  const code = typeof payload?.code === 'string' ? payload.code : '';
  const darkMode = payload?.darkMode === true;
  if (!code.trim()) return { ok: false, error: 'Empty Mermaid source.' };

  const tmpDir = os.tmpdir();
  const token = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const inputPath = path.join(tmpDir, `monospire-mermaid-${token}.mmd`);
  const outputPath = path.join(tmpDir, `monospire-mermaid-${token}.svg`);
  const configPath = path.join(tmpDir, `monospire-mermaid-${token}.json`);

  try {
    await fs.writeFile(inputPath, code, 'utf8');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        theme: darkMode ? 'dark' : 'default',
        themeVariables: {
          background: 'transparent'
        },
        securityLevel: 'strict',
        flowchart: {
          htmlLabels: false,
          useMaxWidth: true
        }
      }),
      'utf8'
    );

    const mmdcName = process.platform === 'win32' ? 'mmdc.cmd' : 'mmdc';
    const commonArgs = ['-i', inputPath, '-o', outputPath, '-e', 'svg', '-c', configPath, '-b', 'transparent'];
    const commands = [];

    const localMmdc = path.join(__dirname, 'node_modules', '.bin', mmdcName);
    if (fsSync.existsSync(localMmdc)) {
      commands.push({ cmd: localMmdc, args: commonArgs });
    }

    const localCliJs = path.join(__dirname, 'node_modules', '@mermaid-js', 'mermaid-cli', 'src', 'cli.js');
    if (fsSync.existsSync(localCliJs)) {
      commands.push({
        cmd: process.execPath,
        args: [localCliJs, ...commonArgs],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });
    }

    const unpackedRoot = path.join(process.resourcesPath || '', 'app.asar.unpacked');
    const unpackedMmdc = path.join(unpackedRoot, 'node_modules', '.bin', mmdcName);
    if (fsSync.existsSync(unpackedMmdc)) {
      commands.push({ cmd: unpackedMmdc, args: commonArgs });
    }

    const unpackedCliJs = path.join(unpackedRoot, 'node_modules', '@mermaid-js', 'mermaid-cli', 'src', 'cli.js');
    if (fsSync.existsSync(unpackedCliJs)) {
      commands.push({
        cmd: process.execPath,
        args: [unpackedCliJs, ...commonArgs],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });
    }

    commands.push({ cmd: 'mmdc', args: commonArgs });

    let lastError = '';
    for (const candidate of commands) {
      try {
        logDiagnostics('mermaid.cli.exec.start', { cmd: candidate.cmd });
        await runExecFile(candidate.cmd, candidate.args, {
          timeout: 20000,
          windowsHide: true,
          env: candidate.env || process.env
        });
        const svg = await fs.readFile(outputPath, 'utf8');
        logDiagnostics('mermaid.cli.exec.success', { cmd: candidate.cmd, bytes: svg.length });
        return { ok: true, svg };
      } catch (failure) {
        const stderr = String(failure?.stderr || '');
        const message = String(failure?.error?.message || failure?.error || 'mmdc failed');
        lastError = `${message}${stderr ? ` | ${stderr.slice(0, 220)}` : ''}`;
        logDiagnostics('mermaid.cli.exec.error', { cmd: candidate.cmd, error: lastError });
      }
    }

    return {
      ok: false,
      error: lastError || 'Mermaid CLI not found. Install @mermaid-js/mermaid-cli.'
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error || 'Mermaid CLI render failed.') };
  } finally {
    try { await fs.unlink(inputPath); } catch {}
    try { await fs.unlink(outputPath); } catch {}
    try { await fs.unlink(configPath); } catch {}
  }
});

ipcMain.handle('read-css-file', async (_event, filePath) => {
  if (!filePath) return '';
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
});

ipcMain.handle('choose-css-theme', async () => {
  logDiagnostics('theme.choose.start');
  const result = await dialog.showOpenDialog({
    title: 'Choose Markdown CSS',
    properties: ['openFile'],
    filters: [{ name: 'CSS files', extensions: ['css'] }]
  });

  if (result.canceled || result.filePaths.length === 0) {
    logDiagnostics('theme.choose.cancelled');
    return null;
  }
  const filePath = result.filePaths[0];
  try {
    const cssText = await fs.readFile(filePath, 'utf8');
    logDiagnostics('theme.choose.success', { path: filePath, bytes: cssText.length });
    return { path: filePath, cssText };
  } catch {
    logDiagnostics('theme.choose.read-error', { path: filePath });
    return { path: filePath, cssText: '' };
  }
});

ipcMain.handle('load-bundled-theme', async (_event, payload) => {
  const fileName = payload?.fileName;
  const filePath = getBundledThemeFilePath(fileName);
  if (!filePath) {
    return { loaded: false, error: 'Bundled theme not found.' };
  }
  try {
    const cssText = await fs.readFile(filePath, 'utf8');
    logDiagnostics('theme.bundled.success', { fileName, bytes: cssText.length });
    return { loaded: true, path: filePath, cssText };
  } catch (error) {
    const message = String(error?.message || error || 'read failed');
    logDiagnostics('theme.bundled.error', { fileName, error: message });
    return { loaded: false, error: message };
  }
});

ipcMain.handle('save-theme-preference', async (_event, payload) => {
  const themePath = payload?.path || null;
  const settings = await readSettings();
  settings.themePath = themePath;
  await writeSettings(settings);
  return { saved: true };
});

ipcMain.handle('choose-template-file', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose Markdown Template',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];

  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { path: filePath, name: path.basename(filePath), content };
  } catch {
    return null;
  }
});

ipcMain.handle('save-default-template-preference', async (_event, payload) => {
  const templatePath = payload?.path || null;
  const settings = await readSettings();
  settings.defaultTemplatePath = templatePath;
  await writeSettings(settings);
  return { saved: true };
});

ipcMain.handle('save-dark-mode-preference', async (_event, payload) => {
  const settings = await readSettings();
  settings.darkMode = Boolean(payload?.enabled);
  await writeSettings(settings);
  return { saved: true };
});

ipcMain.handle('load-dark-mode-preference', async () => {
  const settings = await readSettings();
  if (typeof settings.darkMode !== 'boolean') {
    return { loaded: false, enabled: false };
  }
  return { loaded: true, enabled: settings.darkMode };
});

ipcMain.handle('save-dark-mode-sync-preference', async (_event, payload) => {
  const settings = await readSettings();
  settings.darkModeSyncSystem = payload?.enabled === true;
  await writeSettings(settings);
  return { saved: true };
});

ipcMain.handle('load-dark-mode-sync-preference', async () => {
  const settings = await readSettings();
  if (typeof settings.darkModeSyncSystem !== 'boolean') {
    return { loaded: false, enabled: false };
  }
  return { loaded: true, enabled: settings.darkModeSyncSystem };
});

ipcMain.handle('get-system-dark-mode', async () => {
  return { enabled: nativeTheme.shouldUseDarkColors };
});

ipcMain.handle('save-ribbon-mode-preference', async (_event, payload) => {
  const mode = payload?.mode;
  if (mode !== 'icons' && mode !== 'text' && mode !== 'both') {
    return { saved: false };
  }
  const settings = await readSettings();
  settings.ribbonMode = mode;
  await writeSettings(settings);
  return { saved: true };
});

ipcMain.handle('load-ribbon-mode-preference', async () => {
  const settings = await readSettings();
  const mode = settings.ribbonMode;
  if (mode !== 'icons' && mode !== 'text' && mode !== 'both') {
    return { loaded: false, mode: 'both' };
  }
  return { loaded: true, mode };
});

ipcMain.handle('save-sync-views-preference', async (_event, payload) => {
  const settings = await readSettings();
  settings.syncViews = payload?.enabled !== false;
  await writeSettings(settings);
  return { saved: true };
});

ipcMain.handle('load-sync-views-preference', async () => {
  const settings = await readSettings();
  if (typeof settings.syncViews !== 'boolean') {
    return { loaded: false, enabled: true };
  }
  return { loaded: true, enabled: settings.syncViews };
});

ipcMain.handle('save-mermaid-preview-preference', async (_event, payload) => {
  const settings = await readSettings();
  settings.mermaidPreviewEnabled = payload?.enabled === true;
  await writeSettings(settings);
  return { saved: true };
});

ipcMain.handle('load-mermaid-preview-preference', async () => {
  const settings = await readSettings();
  if (typeof settings.mermaidPreviewEnabled !== 'boolean') {
    return { loaded: false, enabled: false };
  }
  return { loaded: true, enabled: settings.mermaidPreviewEnabled };
});

ipcMain.handle('load-mermaid-preview-crash-notice', async () => {
  const settings = await readSettings();
  return { enabled: settings.mermaidPreviewCrashNotice === true };
});

ipcMain.handle('clear-mermaid-preview-crash-notice', async () => {
  const settings = await readSettings();
  settings.mermaidPreviewCrashNotice = false;
  await writeSettings(settings);
  return { saved: true };
});

ipcMain.handle('save-outline-preference', async (_event, payload) => {
  const visible = payload?.visible !== false;
  const position = payload?.position === 'left' ? 'left' : 'right';
  const settings = await readSettings();
  settings.outline = { visible, position };
  await writeSettings(settings);
  return { saved: true };
});

ipcMain.handle('load-outline-preference', async () => {
  const settings = await readSettings();
  const stored = settings.outline;
  if (!stored || typeof stored !== 'object') {
    return { loaded: false, visible: true, position: 'right' };
  }

  const visible = stored.visible !== false;
  const position = stored.position === 'left' ? 'left' : 'right';
  return { loaded: true, visible, position };
});

ipcMain.handle('save-keybindings-preference', async (_event, payload) => {
  const settings = await readSettings();
  settings.keybindings = normalizeKeybindings(payload?.keybindings);
  await writeSettings(settings);
  return { saved: true };
});

ipcMain.handle('load-keybindings-preference', async () => {
  const settings = await readSettings();
  const keybindings = normalizeKeybindings(settings.keybindings);
  return { loaded: Object.keys(keybindings).length > 0, keybindings };
});

ipcMain.on('session-state-update', (event, payload) => {
  const state = normalizeSingleWindowSession(payload?.state || payload);
  if (!state) return;
  windowSessionState.set(event.sender.id, state);
});

ipcMain.handle('load-last-session', async () => {
  const settings = await readSettings();
  const windows = normalizeSessionCollection(settings.lastSession);
  return { loaded: windows.length > 0, windows };
});

ipcMain.handle('save-snapshot', async (_event, payload) => {
  const key = sanitizeSnapshotKey(payload?.docKey || 'untitled');
  const content = typeof payload?.content === 'string' ? payload.content : '';
  const title = typeof payload?.title === 'string' ? payload.title : 'Untitled';
  const metadata = {
    key,
    title,
    createdAt: new Date().toISOString(),
    hash: crypto.createHash('sha1').update(content).digest('hex').slice(0, 12)
  };

  const dir = snapshotDirForKey(key);
  await fs.mkdir(dir, { recursive: true });
  const id = `${Date.now()}-${metadata.hash}`;
  const filePath = path.join(dir, `${id}.json`);
  await fs.writeFile(filePath, JSON.stringify({ ...metadata, content }, null, 2), 'utf8');

  const all = (await fs.readdir(dir))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse();
  const stale = all.slice(80);
  for (const filename of stale) {
    // eslint-disable-next-line no-await-in-loop
    await fs.unlink(path.join(dir, filename));
  }
  return { saved: true, id, createdAt: metadata.createdAt, hash: metadata.hash };
});

ipcMain.handle('list-snapshots', async (_event, payload) => {
  const key = sanitizeSnapshotKey(payload?.docKey || 'untitled');
  const dir = snapshotDirForKey(key);
  try {
    const files = (await fs.readdir(dir))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, 40);
    const snapshots = [];
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      const raw = await fs.readFile(path.join(dir, file), 'utf8');
      const parsed = JSON.parse(raw);
      snapshots.push({
        id: String(file).replace(/\.json$/, ''),
        createdAt: parsed.createdAt || null,
        title: parsed.title || 'Untitled',
        hash: parsed.hash || ''
      });
    }
    return { snapshots };
  } catch {
    return { snapshots: [] };
  }
});

ipcMain.handle('read-snapshot', async (_event, payload) => {
  const key = sanitizeSnapshotKey(payload?.docKey || 'untitled');
  const id = String(payload?.id || '').trim();
  if (!id) return { loaded: false };
  const filePath = path.join(snapshotDirForKey(key), `${id}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      loaded: true,
      content: typeof parsed.content === 'string' ? parsed.content : '',
      createdAt: parsed.createdAt || null,
      title: parsed.title || 'Untitled'
    };
  } catch {
    return { loaded: false };
  }
});

ipcMain.handle('load-default-template-preference', async () => {
  const settings = await readSettings();
  const templatePath = settings.defaultTemplatePath;

  if (!templatePath) {
    return { loaded: false };
  }

  try {
    const content = await fs.readFile(templatePath, 'utf8');
    return {
      loaded: true,
      path: templatePath,
      name: path.basename(templatePath),
      content
    };
  } catch {
    settings.defaultTemplatePath = null;
    await writeSettings(settings);
    return { loaded: false, invalidPath: templatePath };
  }
});

ipcMain.handle('load-theme-preference', async () => {
  const settings = await readSettings();
  const themePath = settings.themePath;

  if (!themePath) {
    return { loaded: false };
  }

  try {
    const cssText = await fs.readFile(themePath, 'utf8');
    return { loaded: true, path: themePath, cssText };
  } catch {
    settings.themePath = null;
    await writeSettings(settings);
    return { loaded: false, invalidPath: themePath };
  }
});

ipcMain.on('read-css-file-sync', (event, filePath) => {
  if (!filePath) {
    event.returnValue = '';
    return;
  }
  try {
    event.returnValue = fsSync.readFileSync(filePath, 'utf8');
  } catch {
    event.returnValue = '';
  }
});

ipcMain.on('choose-css-theme-sync', (event) => {
  try {
    const filePaths = dialog.showOpenDialogSync({
      title: 'Choose Markdown CSS',
      properties: ['openFile'],
      filters: [{ name: 'CSS files', extensions: ['css'] }]
    });

    if (!filePaths || filePaths.length === 0) {
      event.returnValue = null;
      return;
    }

    const filePath = filePaths[0];
    const cssText = fsSync.readFileSync(filePath, 'utf8');
    event.returnValue = { path: filePath, cssText };
  } catch {
    event.returnValue = null;
  }
});

ipcMain.on('choose-template-file-sync', (event) => {
  try {
    const filePaths = dialog.showOpenDialogSync({
      title: 'Choose Markdown Template',
      properties: ['openFile'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (!filePaths || filePaths.length === 0) {
      event.returnValue = null;
      return;
    }

    const filePath = filePaths[0];
    const content = fsSync.readFileSync(filePath, 'utf8');
    event.returnValue = { path: filePath, name: path.basename(filePath), content };
  } catch {
    event.returnValue = null;
  }
});

ipcMain.handle('file-open', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Open Markdown File',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];
  const content = await fs.readFile(filePath, 'utf8');
  const stats = await fs.stat(filePath);

  return {
    path: filePath,
    name: path.basename(filePath),
    content,
    lastSavedAt: stats?.mtime ? stats.mtime.toISOString() : null
  };
});

ipcMain.handle('file-open-path', async (_event, payload) => {
  const filePath = payload?.path;
  if (!filePath) return null;

  try {
    const content = await fs.readFile(filePath, 'utf8');
    const stats = await fs.stat(filePath);
    return {
      path: filePath,
      name: path.basename(filePath),
      content,
      lastSavedAt: stats?.mtime ? stats.mtime.toISOString() : null
    };
  } catch {
    return null;
  }
});

async function checkRemoteUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    let response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal
    });
    if (response.status === 405 || response.status === 501) {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal
      });
    }
    return {
      url,
      ok: response.ok,
      status: response.status
    };
  } catch (error) {
    return {
      url,
      ok: false,
      error: String(error?.message || error || 'request failed')
    };
  } finally {
    clearTimeout(timeout);
  }
}

ipcMain.handle('check-links', async (_event, payload) => {
  const rawUrls = Array.isArray(payload?.urls) ? payload.urls : [];
  const urls = [...new Set(rawUrls.filter((value) => typeof value === 'string' && value.startsWith('http')))].slice(0, 120);
  const results = [];
  for (const url of urls) {
    // Keep requests bounded and predictable.
    // eslint-disable-next-line no-await-in-loop
    results.push(await checkRemoteUrl(url));
  }
  return { results };
});

ipcMain.handle('file-save', async (_event, payload) => {
  const targetPath = payload?.path;
  const content = payload?.content ?? '';
  if (!targetPath) return { saved: false, requiresPath: true };

  try {
    const extension = path.extname(targetPath).toLowerCase();
    if (extension === '.pdf') {
      await exportMarkdownPdf(targetPath, payload);
    } else if (extension === '.html' || extension === '.htm') {
      await exportMarkdownHtml(targetPath, payload);
    } else if (extension === '.pages') {
      await exportMarkdownPages(targetPath, payload);
    } else if (extension === '.docx') {
      await exportMarkdownDocx(targetPath, payload);
    } else {
      await fs.writeFile(targetPath, content, 'utf8');
    }
    return {
      saved: true,
      path: targetPath,
      name: path.basename(targetPath),
      savedAt: new Date().toISOString()
    };
  } catch (error) {
    return { saved: false, error: String(error?.message || error || 'Unable to save file') };
  }
});

ipcMain.handle('file-save-as', async (_event, payload) => {
  const content = payload?.content ?? '';
  const suggestedPath = payload?.path;

  const result = await dialog.showSaveDialog({
    title: 'Save Markdown File',
    defaultPath: suggestedPath || 'Untitled.md',
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Text', extensions: ['txt'] },
      { name: 'HTML', extensions: ['html'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'Pages Document', extensions: ['pages'] },
      { name: 'Word Document', extensions: ['docx'] }
    ]
  });

  if (result.canceled || !result.filePath) return { saved: false };

  try {
    const extension = path.extname(result.filePath).toLowerCase();
    const outputPath = extension ? result.filePath : `${result.filePath}.md`;
    if (extension === '.pdf') {
      await exportMarkdownPdf(outputPath, payload);
    } else if (extension === '.html' || extension === '.htm') {
      await exportMarkdownHtml(outputPath, payload);
    } else if (extension === '.pages') {
      await exportMarkdownPages(outputPath, payload);
    } else if (extension === '.docx') {
      await exportMarkdownDocx(outputPath, payload);
    } else {
      await fs.writeFile(outputPath, content, 'utf8');
    }
    return {
      saved: true,
      path: outputPath,
      name: path.basename(outputPath),
      savedAt: new Date().toISOString()
    };
  } catch (error) {
    return { saved: false, error: String(error?.message || error || 'Unable to save file') };
  }
});

ipcMain.on('file-open-sync', (event) => {
  try {
    const filePaths = dialog.showOpenDialogSync({
      title: 'Open Markdown File',
      properties: ['openFile'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (!filePaths || filePaths.length === 0) {
      event.returnValue = null;
      return;
    }

    const filePath = filePaths[0];
    const content = fsSync.readFileSync(filePath, 'utf8');
    const stats = fsSync.statSync(filePath);
    event.returnValue = {
      path: filePath,
      name: path.basename(filePath),
      content,
      lastSavedAt: stats?.mtime ? stats.mtime.toISOString() : null
    };
  } catch {
    event.returnValue = null;
  }
});

ipcMain.on('file-save-sync', (event, payload) => {
  try {
    const targetPath = payload?.path;
    const content = payload?.content ?? '';
    if (!targetPath) {
      event.returnValue = { saved: false, requiresPath: true };
      return;
    }

    const extension = path.extname(targetPath).toLowerCase();
    if (extension === '.pages' || extension === '.pdf' || extension === '.docx') {
      event.returnValue = { saved: false, error: 'Synchronous export for this format is not supported.' };
      return;
    }
    fsSync.writeFileSync(targetPath, content, 'utf8');
    event.returnValue = {
      saved: true,
      path: targetPath,
      name: path.basename(targetPath),
      savedAt: new Date().toISOString()
    };
  } catch {
    event.returnValue = { saved: false };
  }
});

ipcMain.on('file-save-as-sync', (event, payload) => {
  try {
    const content = payload?.content ?? '';
    const suggestedPath = payload?.path;

    const filePath = dialog.showSaveDialogSync({
      title: 'Save Markdown File',
      defaultPath: suggestedPath || 'Untitled.md',
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Text', extensions: ['txt'] },
        { name: 'HTML', extensions: ['html'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Pages Document', extensions: ['pages'] },
        { name: 'Word Document', extensions: ['docx'] }
      ]
    });

    if (!filePath) {
      event.returnValue = { saved: false };
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    if (extension === '.pdf') {
      event.returnValue = { saved: false, error: 'Synchronous PDF export is not supported.' };
      return;
    }
    if (extension === '.docx') {
      event.returnValue = { saved: false, error: 'Synchronous DOCX export is not supported.' };
      return;
    }
    if (extension === '.pages') {
      event.returnValue = { saved: false, error: 'Synchronous Pages export is not supported.' };
      return;
    }
    if (extension === '.html' || extension === '.htm') {
      const htmlContent = payload?.renderedHtml || '';
      const themeCss = payload?.themeCssText || '';
      const darkMode = Boolean(payload?.darkMode);
      const presetCss = getExportPresetCss('html', payload?.exportPresets?.html, darkMode);
      const fullHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Monospire Export</title>
    <style>${themeCss}\n${presetCss}</style>
  </head>
  <body class="${darkMode ? 'theme-dark' : ''}">${htmlContent}</body>
</html>`;
      fsSync.writeFileSync(filePath, fullHtml, 'utf8');
    } else {
      fsSync.writeFileSync(filePath, content, 'utf8');
    }
    event.returnValue = {
      saved: true,
      path: filePath,
      name: path.basename(filePath),
      savedAt: new Date().toISOString()
    };
  } catch {
    event.returnValue = { saved: false };
  }
});

ipcMain.on('set-document-state', (event, payload) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;

  const title = payload?.title || 'Monospire';
  const filePath = payload?.path || '';
  const dirty = Boolean(payload?.dirty);

  window.setTitle(title);
  window.setDocumentEdited(dirty);
  window.setRepresentedFilename(filePath);
});

ipcMain.on('update-menu-state', (event, payload) => {
  const menu = Menu.getApplicationMenu();
  if (!menu || !payload) return;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window && typeof payload.mermaidPreviewEnabled === 'boolean') {
    window.__mermaidPreviewEnabled = payload.mermaidPreviewEnabled;
  }

  const rawItem = menu.getMenuItemById('toggle-raw');
  const formattedItem = menu.getMenuItemById('toggle-formatted');
  const darkModeItem = menu.getMenuItemById('theme-dark-mode');
  const darkModeSyncItem = menu.getMenuItemById('theme-sync-system');
  const ribbonIcons = menu.getMenuItemById('ribbon-icons-only');
  const ribbonText = menu.getMenuItemById('ribbon-text-only');
  const ribbonBoth = menu.getMenuItemById('ribbon-icons-text');
  const horizontalView = menu.getMenuItemById('split-horizontal-view');
  const verticalView = menu.getMenuItemById('split-vertical-view');
  const spellCheckItem = menu.getMenuItemById('spell-check');
  const dictionaryUsItem = menu.getMenuItemById('dictionary-en-us');
  const dictionaryGbItem = menu.getMenuItemById('dictionary-en-gb');
  const embeddedMenuItem = menu.getMenuItemById('display-menu-in-app');
  const themeDebugItem = menu.getMenuItemById('display-theme-debug');
  const syncViewsItem = menu.getMenuItemById('sync-views');
  const mermaidPreviewItem = menu.getMenuItemById('mermaid-preview-experimental');
  const outlineItem = menu.getMenuItemById('toggle-outline');
  const outlineLeftItem = menu.getMenuItemById('outline-left');
  const outlineRightItem = menu.getMenuItemById('outline-right');
  const exportHtmlDefault = menu.getMenuItemById('export-html-default');
  const exportHtmlArticle = menu.getMenuItemById('export-html-article');
  const exportHtmlCompact = menu.getMenuItemById('export-html-compact');
  const exportPdfDefault = menu.getMenuItemById('export-pdf-default');
  const exportPdfSerif = menu.getMenuItemById('export-pdf-serif');
  const exportPdfDark = menu.getMenuItemById('export-pdf-dark');
  const exportDocxDefault = menu.getMenuItemById('export-docx-default');
  const exportDocxClassic = menu.getMenuItemById('export-docx-classic');
  const exportDocxReport = menu.getMenuItemById('export-docx-report');
  const exportPagesDefault = menu.getMenuItemById('export-pages-default');
  const exportPagesManuscript = menu.getMenuItemById('export-pages-manuscript');
  const exportPagesPresentation = menu.getMenuItemById('export-pages-presentation');
  const activeThemeFileName = typeof payload.activeThemeFileName === 'string' ? payload.activeThemeFileName : '';

  if (rawItem && typeof payload.showRaw === 'boolean') rawItem.checked = payload.showRaw;
  if (formattedItem && typeof payload.showFormatted === 'boolean') formattedItem.checked = payload.showFormatted;
  if (darkModeItem && typeof payload.darkMode === 'boolean') darkModeItem.checked = payload.darkMode;
  if (darkModeSyncItem && typeof payload.darkModeSyncSystem === 'boolean') darkModeSyncItem.checked = payload.darkModeSyncSystem;
  if (darkModeItem && typeof payload.darkModeSyncSystem === 'boolean') darkModeItem.enabled = !payload.darkModeSyncSystem;

  if (payload.ribbonMode === 'icons' && ribbonIcons) ribbonIcons.checked = true;
  if (payload.ribbonMode === 'text' && ribbonText) ribbonText.checked = true;
  if (payload.ribbonMode === 'both' && ribbonBoth) ribbonBoth.checked = true;
  if (payload.splitOrientation === 'horizontal' && horizontalView) horizontalView.checked = true;
  if (payload.splitOrientation === 'vertical' && verticalView) verticalView.checked = true;
  if (spellCheckItem && typeof payload.spellcheckEnabled === 'boolean') spellCheckItem.checked = payload.spellcheckEnabled;
  if (payload.dictionaryLanguage === 'en-US' && dictionaryUsItem) dictionaryUsItem.checked = true;
  if (payload.dictionaryLanguage === 'en-GB' && dictionaryGbItem) dictionaryGbItem.checked = true;
  if (dictionaryUsItem && typeof payload.spellcheckEnabled === 'boolean') dictionaryUsItem.enabled = payload.spellcheckEnabled;
  if (dictionaryGbItem && typeof payload.spellcheckEnabled === 'boolean') dictionaryGbItem.enabled = payload.spellcheckEnabled;
  if (embeddedMenuItem && typeof payload.embeddedMenu === 'boolean') embeddedMenuItem.checked = payload.embeddedMenu;
  if (themeDebugItem && typeof payload.themeDebugVisible === 'boolean') themeDebugItem.checked = payload.themeDebugVisible;
  if (syncViewsItem && typeof payload.syncViewsEnabled === 'boolean') syncViewsItem.checked = payload.syncViewsEnabled;
  if (mermaidPreviewItem && typeof payload.mermaidPreviewEnabled === 'boolean') mermaidPreviewItem.checked = payload.mermaidPreviewEnabled;
  if (outlineItem && typeof payload.outlineVisible === 'boolean') outlineItem.checked = payload.outlineVisible;
  if (outlineLeftItem && typeof payload.outlineVisible === 'boolean') outlineLeftItem.enabled = payload.outlineVisible;
  if (outlineRightItem && typeof payload.outlineVisible === 'boolean') outlineRightItem.enabled = payload.outlineVisible;
  if (outlineLeftItem && payload.outlinePosition === 'left') outlineLeftItem.checked = true;
  if (outlineRightItem && payload.outlinePosition === 'right') outlineRightItem.checked = true;
  if (exportHtmlDefault && payload.exportHtmlPreset === 'default') exportHtmlDefault.checked = true;
  if (exportHtmlArticle && payload.exportHtmlPreset === 'article') exportHtmlArticle.checked = true;
  if (exportHtmlCompact && payload.exportHtmlPreset === 'compact') exportHtmlCompact.checked = true;
  if (exportPdfDefault && payload.exportPdfPreset === 'default') exportPdfDefault.checked = true;
  if (exportPdfSerif && payload.exportPdfPreset === 'serif') exportPdfSerif.checked = true;
  if (exportPdfDark && payload.exportPdfPreset === 'dark') exportPdfDark.checked = true;
  if (exportDocxDefault && payload.exportDocxPreset === 'default') exportDocxDefault.checked = true;
  if (exportDocxClassic && payload.exportDocxPreset === 'classic') exportDocxClassic.checked = true;
  if (exportDocxReport && payload.exportDocxPreset === 'report') exportDocxReport.checked = true;
  if (exportPagesDefault && payload.exportPagesPreset === 'default') exportPagesDefault.checked = true;
  if (exportPagesManuscript && payload.exportPagesPreset === 'manuscript') exportPagesManuscript.checked = true;
  if (exportPagesPresentation && payload.exportPagesPreset === 'presentation') exportPagesPresentation.checked = true;
  for (const entry of BUNDLED_THEMES) {
    if (!entry || entry.type === 'separator') continue;
    const menuItem = menu.getMenuItemById(getThemeMenuItemId(entry.fileName));
    if (menuItem) menuItem.checked = entry.fileName === activeThemeFileName;
  }
});

ipcMain.on('app-quit', () => {
  app.quit();
});

ipcMain.on('new-window', () => {
  createWindow();
});

ipcMain.handle('set-spellcheck-language', async (event, payload) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return { ok: false, language: null };

  const language = payload?.language;
  if (language !== 'en-US' && language !== 'en-GB') {
    return { ok: false, language: null };
  }

  try {
    window.webContents.session.setSpellCheckerLanguages([language]);
    return { ok: true, language };
  } catch (error) {
    return { ok: false, language: null, error: String(error?.message || error) };
  }
});

ipcMain.handle('show-unsaved-dialog', async (event, payload) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return 'cancel';

  const context = payload?.context || 'continuing';
  const result = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['Save', 'Discard', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Unsaved Changes',
    message: 'You have unsaved changes.',
    detail: `Do you want to save before ${context}?`
  });

  if (result.response === 0) return 'save';
  if (result.response === 1) return 'discard';
  return 'cancel';
});

ipcMain.handle('confirm-close-window', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return false;
  window.__allowClose = true;
  window.close();
  return true;
});

ipcMain.handle('show-about-dialog', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const version = app.getVersion();
  await dialog.showMessageBox(window || undefined, {
    type: 'info',
    title: 'About Monospire',
    message: 'Monospire',
    detail: `Version ${version}\nElectron ${process.versions.electron}\nNode ${process.versions.node}\nChrome ${process.versions.chrome}\n©2026 Curzon Monroe`,
    buttons: ['OK']
  });
});

ipcMain.handle('show-theme-load-error-dialog', async (event, payload) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const invalidPath = payload?.path || 'unknown file';
  await dialog.showMessageBox(window || undefined, {
    type: 'warning',
    title: 'Theme Not Loaded',
    message: 'Saved theme could not be loaded.',
    detail: `The saved theme file could not be found or read:\n${invalidPath}\n\nMonospire reverted to the default theme.`,
    buttons: ['OK']
  });
});

ipcMain.handle('show-template-load-error-dialog', async (event, payload) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const invalidPath = payload?.path || 'unknown file';
  await dialog.showMessageBox(window || undefined, {
    type: 'warning',
    title: 'Template Not Loaded',
    message: 'Default template could not be loaded.',
    detail: `The configured template file could not be found or read:\n${invalidPath}\n\nMonospire will create a blank new document instead.`,
    buttons: ['OK']
  });
});

ipcMain.handle('show-mermaid-preview-disabled-dialog', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  await dialog.showMessageBox(window || undefined, {
    type: 'warning',
    title: 'Mermaid Preview Disabled',
    message: 'Mermaid Preview was turned off to keep Monospire stable.',
    detail: 'Monospire detected a renderer crash while Mermaid Preview (Experimental) was enabled, so it has been disabled for this launch.',
    buttons: ['OK']
  });
});

ipcMain.handle('get-recent-files', async () => {
  await refreshRecentFilesCache();
  return recentFilesCache;
});

ipcMain.handle('add-recent-file', async (_event, payload) => {
  const filePath = typeof payload?.path === 'string' ? payload.path.trim() : '';
  if (!filePath) {
    await refreshRecentFilesCache();
    return recentFilesCache;
  }
  const next = [filePath, ...recentFilesCache.filter((entry) => entry !== filePath)];
  const saved = await saveRecentFiles(next);
  buildAppMenu();
  return saved;
});

ipcMain.handle('clear-recent-files', async () => {
  const saved = await saveRecentFiles([]);
  buildAppMenu();
  return saved;
});

app.whenReady().then(() => {
  logDiagnostics('app.whenReady');
  applyDockIcon();
  void (async () => {
    await refreshRecentFilesCache();
    logDiagnostics('app.recent-files.ready', { count: recentFilesCache.length });
    buildAppMenu();
    const settings = await readSettings();
    const restored = normalizeSessionCollection(settings.lastSession);
    logDiagnostics('app.session.restore', { count: restored.length });
    if (restored.length > 0) {
      for (const state of restored) {
        createWindow(state);
      }
    } else {
      createWindow();
    }

    app.on('activate', () => {
      logDiagnostics('app.activate');
      applyDockIcon();
      if (getDocumentWindows().length === 0) createWindow();
    });

    const initialSystemDark = nativeTheme.shouldUseDarkColors;
    for (const window of getDocumentWindows()) {
      const wc = window.webContents;
      if (!wc || wc.isDestroyed()) continue;
      wc.send('menu-action', { action: 'system-dark-mode-changed', payload: { enabled: initialSystemDark } });
    }
  })();
});

app.on('before-quit', (event) => {
  logDiagnostics('app.before-quit', { alreadyPersisting: isQuittingForSessionPersist });
  if (mermaidWorkerWindow && !mermaidWorkerWindow.isDestroyed()) {
    try {
      mermaidWorkerWindow.destroy();
    } catch {
      // Ignore worker shutdown errors.
    }
  }
  if (isQuittingForSessionPersist) return;
  isQuittingForSessionPersist = true;
  event.preventDefault();
  void (async () => {
    try {
      await persistSessionFromWindows();
    } finally {
      app.exit(0);
    }
  })();
});

app.on('window-all-closed', () => {
  logDiagnostics('app.window-all-closed', { platform: process.platform });
  if (process.platform !== 'darwin') app.quit();
});

app.on('child-process-gone', (_event, details) => {
  logDiagnostics('app.child-process-gone', { details });
});

nativeTheme.on('updated', () => {
  const enabled = nativeTheme.shouldUseDarkColors;
  logDiagnostics('nativeTheme.updated', { enabled });
  for (const window of getDocumentWindows()) {
    const wc = window.webContents;
    if (!wc || wc.isDestroyed()) continue;
    wc.send('menu-action', { action: 'system-dark-mode-changed', payload: { enabled } });
  }
});

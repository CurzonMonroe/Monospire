const MarkdownIt = require('markdown-it');
const TurndownService = require('turndown');
const morphdom = require('morphdom');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
try {
  require('fs').appendFileSync('/tmp/monospire-renderer.log', `${new Date().toISOString()} renderer module entered pid=${process.pid}\n`, 'utf8');
} catch {
  // Ignore renderer bootstrap logging failures.
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true
});

const defaultFenceRenderer =
  md.renderer.rules.fence ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

let hljs = null;
let syntaxReady = false;
let syntaxInitAttempted = false;
let syntaxError = '';
let mermaidApi = null;
let mermaidError = '';
let mermaidBackend = '';
let mermaidRenderVersion = 0;
const MERMAID_ENABLED = true;
const MERMAID_RENDER_TIMEOUT_MS = 15000;

function diagnosticLog(message, payload = {}) {
  try {
    if (!window.nativeApi || typeof window.nativeApi.diagnosticLog !== 'function') return;
    window.nativeApi.diagnosticLog({
      message,
      ...(payload && typeof payload === 'object' ? payload : { value: payload })
    });
  } catch {
    // Best-effort diagnostics only.
  }
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

const LANGUAGE_KEYWORDS = {
  c: ['auto', 'break', 'case', 'const', 'continue', 'default', 'do', 'else', 'enum', 'extern', 'for', 'goto', 'if', 'inline', 'register', 'restrict', 'return', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'volatile', 'while', 'int', 'char', 'short', 'long', 'float', 'double', 'void', 'signed', 'unsigned'],
  cpp: ['alignas', 'alignof', 'auto', 'break', 'case', 'catch', 'class', 'const', 'constexpr', 'continue', 'decltype', 'default', 'delete', 'do', 'else', 'enum', 'explicit', 'export', 'extern', 'for', 'friend', 'goto', 'if', 'inline', 'mutable', 'namespace', 'new', 'noexcept', 'operator', 'private', 'protected', 'public', 'register', 'reinterpret_cast', 'return', 'sizeof', 'static', 'struct', 'switch', 'template', 'this', 'throw', 'try', 'typedef', 'typename', 'union', 'using', 'virtual', 'volatile', 'while', 'int', 'char', 'short', 'long', 'float', 'double', 'void', 'bool'],
  javascript: ['break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'yield', 'async', 'await'],
  typescript: ['abstract', 'any', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'infer', 'instanceof', 'interface', 'keyof', 'let', 'namespace', 'new', 'of', 'private', 'protected', 'public', 'readonly', 'return', 'static', 'super', 'switch', 'this', 'throw', 'try', 'type', 'typeof', 'var', 'void', 'while'],
  python: ['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while', 'with', 'yield'],
  java: ['abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'try', 'void', 'volatile', 'while'],
  go: ['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var'],
  rust: ['as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while'],
  json: ['true', 'false', 'null'],
  bash: ['if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac', 'function', 'select', 'until', 'export', 'readonly', 'local', 'return']
};

function canonicalLanguage(languageInfo) {
  const raw = (languageInfo || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'c++' || raw === 'cplusplus' || raw === 'cc' || raw === 'cxx' || raw === 'cpp') return 'cpp';
  if (raw === 'c#' || raw === 'cs') return 'csharp';
  if (raw === 'js' || raw === 'jsx') return 'javascript';
  if (raw === 'ts' || raw === 'tsx') return 'typescript';
  if (raw === 'py') return 'python';
  if (raw === 'sh' || raw === 'zsh' || raw === 'shell') return 'bash';
  return raw;
}

function isMermaidFenceInfo(info) {
  const raw = (info || '').trim().toLowerCase();
  if (!raw) return false;
  const aliases = new Set([
    'mermaid',
    'flowchart',
    'sequence',
    'sequencediagram',
    'class',
    'classdiagram',
    'state',
    'statediagram',
    'statediagram-v2',
    'er',
    'erdiagram',
    'journey',
    'gantt',
    'pie',
    'quadrantchart',
    'requirement',
    'gitgraph',
    'mindmap',
    'timeline',
    'sankey',
    'xychart',
    'block-beta'
  ]);
  return aliases.has(raw);
}

async function loadMermaidApi() {
  if (!MERMAID_ENABLED) {
    mermaidError = 'disabled';
    mermaidBackend = '';
    diagnosticLog('mermaid.load.skipped', { reason: 'disabled' });
    return null;
  }
  diagnosticLog('mermaid.load.start');
  if (typeof window.nativeApi?.renderMermaid === 'function') {
    mermaidApi = { backend: 'worker' };
    mermaidBackend = 'worker';
    mermaidError = '';
    diagnosticLog('mermaid.load.success', { backend: 'worker' });
    return mermaidApi;
  }
  if (typeof window.nativeApi?.renderMermaidCli === 'function') {
    mermaidApi = { backend: 'cli' };
    mermaidBackend = 'cli';
    mermaidError = '';
    diagnosticLog('mermaid.load.success', { backend: 'mmdc' });
    return mermaidApi;
  }
  if (typeof window.nativeApi?.renderMermaid !== 'function' && typeof window.nativeApi?.renderMermaidCli !== 'function') {
    mermaidApi = null;
    mermaidBackend = '';
    mermaidError = 'no backend bridge available';
    diagnosticLog('mermaid.load.unavailable', { reason: mermaidError });
    return null;
  }
  return null;
}

async function renderMermaidWithFallback(source, preferredBackend, options = {}) {
  const attempts = preferredBackend === 'cli' ? ['cli', 'worker'] : ['worker', 'cli'];
  let lastResult = null;
  const renderDarkMode = options.darkMode ?? darkMode;

  for (const backend of attempts) {
    try {
      if (backend === 'worker' && typeof window.nativeApi?.renderMermaid === 'function') {
        const result = await withTimeout(
          window.nativeApi.renderMermaid({ code: source, darkMode: renderDarkMode }),
          MERMAID_RENDER_TIMEOUT_MS,
          `mermaid render timed out after ${MERMAID_RENDER_TIMEOUT_MS}ms`
        );
        if (result?.ok) {
          mermaidBackend = 'worker';
          return result;
        }
        lastResult = result;
      } else if (backend === 'cli' && typeof window.nativeApi?.renderMermaidCli === 'function') {
        const result = await withTimeout(
          window.nativeApi.renderMermaidCli({ code: source, darkMode }),
          MERMAID_RENDER_TIMEOUT_MS,
          `mermaid render timed out after ${MERMAID_RENDER_TIMEOUT_MS}ms`
        );
        if (result?.ok) {
          mermaidBackend = 'cli';
          return result;
        }
        lastResult = result;
      }
    } catch (error) {
      lastResult = { ok: false, error: String(error?.message || error || 'render failed') };
    }
  }

  return lastResult || { ok: false, error: 'No Mermaid backend available.' };
}

function normalizeHighlightLanguage(languageInfo) {
  const canonical = canonicalLanguage(languageInfo);
  const supported = {
    c: 'c',
    cpp: 'cpp',
    csharp: 'csharp',
    javascript: 'javascript',
    typescript: 'typescript',
    python: 'python',
    java: 'java',
    go: 'go',
    rust: 'rust',
    json: 'json',
    bash: 'bash',
    html: 'html',
    css: 'css',
    xml: 'xml',
    yaml: 'yaml',
    sql: 'sql',
    markdown: 'markdown'
  };
  return supported[canonical] || 'text';
}

function initializeSyntaxHighlighter() {
  if (syntaxInitAttempted) return;
  syntaxInitAttempted = true;
  diagnosticLog('syntax.init.start');

  try {
    try {
      hljs = require('highlight.js');
    } catch {
      const candidates = [
        path.join(__dirname, 'node_modules', 'highlight.js'),
        path.join(process.cwd(), 'node_modules', 'highlight.js')
      ];
      let loaded = null;
      for (const candidate of candidates) {
        try {
          loaded = require(candidate);
          if (loaded) break;
        } catch {
          // Try next resolution path.
        }
      }
      hljs = loaded;
    }
    const normalizeHljs = (candidate) => {
      if (!candidate) return null;
      if (typeof candidate.highlight === 'function') return candidate;
      if (candidate.default && typeof candidate.default.highlight === 'function') return candidate.default;
      if (candidate.default?.default && typeof candidate.default.default.highlight === 'function') return candidate.default.default;
      return null;
    };

    hljs = normalizeHljs(hljs);
    if (typeof hljs?.highlight !== 'function') {
      throw new Error('highlight.js API unavailable');
    }
    syntaxReady = true;
    syntaxError = '';
    diagnosticLog('syntax.init.success');
    lastRenderedHtml = '';
    renderFromMarkdown(markdownState);
    updateThemeDebug();
  } catch (error) {
    hljs = null;
    syntaxReady = false;
    syntaxError = String(error?.message || error || 'unknown');
    diagnosticLog('syntax.init.error', { error: syntaxError });
    updateThemeDebug();
  }
}

function applyInlineHljsStyles(highlightedHtml) {
  const useDarkPalette = darkMode && !renderingForExport;
  const palette = useDarkPalette
    ? {
        keyword: 'color:#c792ea;font-weight:600;',
        string: 'color:#8bd49c;',
        comment: 'color:#97a1b4;font-style:italic;',
        number: 'color:#f6a45e;',
        literal: 'color:#7ecbff;',
        type: 'color:#d8a5ff;',
        title: 'color:#7ecbff;',
        built_in: 'color:#d8a5ff;'
      }
    : {
        keyword: 'color:#7b2cbf;font-weight:600;',
        string: 'color:#0f7b49;',
        comment: 'color:#6f7787;font-style:italic;',
        number: 'color:#b24f00;',
        literal: 'color:#005e8a;',
        type: 'color:#9c27b0;',
        title: 'color:#005e8a;',
        built_in: 'color:#9c27b0;'
      };

  const classToToken = [
    ['hljs-keyword', 'keyword'],
    ['hljs-string', 'string'],
    ['hljs-comment', 'comment'],
    ['hljs-number', 'number'],
    ['hljs-literal', 'literal'],
    ['hljs-type', 'type'],
    ['hljs-title', 'title'],
    ['hljs-built_in', 'built_in']
  ];

  return highlightedHtml.replace(/<span class="([^"]+)">/g, (_match, classList) => {
    const classes = classList.split(/\s+/);
    let style = '';
    for (const [className, token] of classToToken) {
      if (classes.includes(className)) {
        style = palette[token];
        break;
      }
    }
    if (!style) return `<span class="${classList}">`;
    return `<span class="${classList}" style="${style}">`;
  });
}

function codeBlockLabelStyle() {
  const color = darkMode && !renderingForExport ? '#8fb8ff' : '#2f6f9f';
  return [
    'display:block!important',
    'text-align:right!important',
    'font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif!important',
    'font-size:0.72em!important',
    'line-height:1.15!important',
    'font-weight:700!important',
    'letter-spacing:0.02em!important',
    'text-transform:uppercase!important',
    `color:${color}!important`,
    'margin:0 0 0.14em 0!important',
    'padding:0!important',
    'background:transparent!important',
    'border:0!important',
    'pointer-events:none!important'
  ].join(';');
}

function renderFenceWithHighlightJs(content, info, langLabel, classSafeLang) {
  if (!syntaxReady || !hljs) return null;

  try {
    const lang = normalizeHighlightLanguage(info);
    const highlightedRaw = lang && hljs.getLanguage(lang)
      ? hljs.highlight(content, { language: lang, ignoreIllegals: true }).value
      : hljs.highlightAuto(content).value;
    const highlighted = applyInlineHljsStyles(highlightedRaw);

    return `<pre class="code-block hljs language-${classSafeLang}" data-lang="${langLabel}"><span class="code-block-label" style="${codeBlockLabelStyle()}">${langLabel}</span>\n<code class="hljs language-${classSafeLang}">${highlighted}</code></pre>\n`;
  } catch {
    return null;
  }
}

function applyHighlightRule(input, regex, className, tokens) {
  return input.replace(regex, (match) => {
    const token = `@@HL${tokens.length}@@`;
    tokens.push(`<span class="hl-${className}">${match}</span>`);
    return token;
  });
}

function highlightCodeContent(content, languageInfo) {
  const canonical = canonicalLanguage(languageInfo);
  const keywords = LANGUAGE_KEYWORDS[canonical] || [];
  let html = md.utils.escapeHtml(content || '');
  const tokens = [];

  if (canonical === 'python') {
    html = applyHighlightRule(html, /#.*/g, 'comment', tokens);
  } else if (canonical === 'bash') {
    html = applyHighlightRule(html, /#.*/g, 'comment', tokens);
  } else if (canonical === 'json') {
    html = applyHighlightRule(html, /"(?:\\.|[^"\\])*"\s*(?=:)/g, 'property', tokens);
  } else {
    html = applyHighlightRule(html, /\/\*[\s\S]*?\*\//g, 'comment', tokens);
    html = applyHighlightRule(html, /\/\/.*/g, 'comment', tokens);
  }

  html = applyHighlightRule(html, /"(?:\\.|[^"\\])*"/g, 'string', tokens);
  html = applyHighlightRule(html, /'(?:\\.|[^'\\])*'/g, 'string', tokens);
  html = applyHighlightRule(html, /\b\d+(?:\.\d+)?\b/g, 'number', tokens);

  if (keywords.length > 0) {
    const keywordPattern = new RegExp(`\\b(?:${keywords.join('|')})\\b`, 'g');
    html = applyHighlightRule(html, keywordPattern, 'keyword', tokens);
  }

  return html.replace(/@@HL(\d+)@@/g, (_match, index) => tokens[Number(index)] || '');
}

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = (token.info || '').trim();
  const sourceLine = Array.isArray(token.map) ? token.map[0] + (env?.bodyLineOffset || 0) : null;
  const lineAttr = sourceLine === null ? '' : ` data-line="${sourceLine}"`;

  if (isMermaidFenceInfo(info)) {
    const rawInfo = info.toLowerCase();
    const content = token.content || '';
    const mermaidSource = rawInfo === 'mermaid' ? content : `${rawInfo}\n${content}`;
    const escaped = md.utils.escapeHtml(mermaidSource);
    return `<div class="mermaid-block" data-mermaid-block="true"${lineAttr}><pre class="mermaid-source" data-mermaid-source="true" data-lang="mermaid"><code>${escaped}</code></pre><div class="mermaid-render" data-mermaid-render="true"></div></div>\n`;
  }

  if (!info) {
    const raw = defaultFenceRenderer(tokens, idx, options, env, self);
    if (!lineAttr) return raw;
    return raw.replace('<pre', `<pre${lineAttr}`);
  }

  const langLabel = md.utils.escapeHtml(info);
  const classSafeLang = info.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const highlightedHtml = renderFenceWithHighlightJs(token.content, info, langLabel, classSafeLang);
  if (highlightedHtml) {
    if (!lineAttr) return highlightedHtml;
    return highlightedHtml.replace('<pre', `<pre${lineAttr}`);
  }
  const codeContent = highlightCodeContent(token.content, info);

  return `<pre class="code-block" data-lang="${langLabel}"${lineAttr}><span class="code-block-label" style="${codeBlockLabelStyle()}">${langLabel}</span>\n<code class="language-${classSafeLang}">${codeContent}</code></pre>\n`;
};

md.inline.ruler.before('emphasis', 'mark', (state, silent) => {
  const start = state.pos;
  const src = state.src;
  if (src.charCodeAt(start) !== 0x3d || src.charCodeAt(start + 1) !== 0x3d) return false;

  const end = src.indexOf('==', start + 2);
  if (end === -1 || end === start + 2) return false;
  if (silent) return false;

  const tokenOpen = state.push('mark_open', 'mark', 1);
  tokenOpen.markup = '==';
  const textToken = state.push('text', '', 0);
  textToken.content = src.slice(start + 2, end);
  const tokenClose = state.push('mark_close', 'mark', -1);
  tokenClose.markup = '==';
  state.pos = end + 2;
  return true;
});

md.renderer.rules.paragraph_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrJoin('class', 'splendor-p');
  if (Array.isArray(tokens[idx].map)) {
    tokens[idx].attrSet('data-line', String(tokens[idx].map[0] + (env?.bodyLineOffset || 0)));
  }
  return self.renderToken(tokens, idx, options);
};

function tokenPlainText(token) {
  if (!token) return '';
  if (Array.isArray(token.children) && token.children.length > 0) {
    return token.children
      .filter((child) => child.type === 'text' || child.type === 'code_inline')
      .map((child) => child.content || '')
      .join('')
      .trim();
  }
  return (token.content || '').trim();
}

function slugifyHeading(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'section';
}

md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const tag = tokens[idx].tag;
  tokens[idx].attrJoin('class', `splendor-${tag}`);
  if (Array.isArray(tokens[idx].map)) {
    tokens[idx].attrSet('data-line', String(tokens[idx].map[0] + (env?.bodyLineOffset || 0)));
  }
  const textToken = tokens[idx + 1];
  const baseSlug = slugifyHeading(tokenPlainText(textToken));
  if (!env.__headingSlugCounts) env.__headingSlugCounts = {};
  const count = env.__headingSlugCounts[baseSlug] || 0;
  env.__headingSlugCounts[baseSlug] = count + 1;
  const slug = count === 0 ? baseSlug : `${baseSlug}-${count + 1}`;
  tokens[idx].attrSet('id', slug);
  return self.renderToken(tokens, idx, options);
};

for (const tokenName of ['blockquote_open', 'list_item_open']) {
  const previous = md.renderer.rules[tokenName];
  md.renderer.rules[tokenName] = (tokens, idx, options, env, self) => {
    if (Array.isArray(tokens[idx].map)) {
      tokens[idx].attrSet('data-line', String(tokens[idx].map[0] + (env?.bodyLineOffset || 0)));
    }
    if (previous) return previous(tokens, idx, options, env, self);
    return self.renderToken(tokens, idx, options);
  };
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  emDelimiter: '*'
});

turndown.addRule('markTag', {
  filter: ['mark'],
  replacement: (content) => `==${content}==`
});

turndown.addRule('mermaidBlocks', {
  filter: (node) => node.nodeName === 'DIV' && node.hasAttribute?.('data-mermaid-block'),
  replacement: (_content, node) => {
    const sourceNode = node.querySelector('[data-mermaid-source] code');
    const source = (sourceNode?.textContent || '').replace(/\n$/, '');
    return `\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\n`;
  }
});

turndown.addRule('fencedCodeBlocks', {
  filter: (node) => node.nodeName === 'PRE' && node.querySelector?.('code'),
  replacement: (_content, node) => {
    const codeNode = node.querySelector('code');
    const explicitLang = node.getAttribute('data-lang') || '';
    const className = codeNode.getAttribute('class') || '';
    const languageMatch = className.match(/language-([a-zA-Z0-9_-]+)/);
    const language = explicitLang || (languageMatch ? languageMatch[1] : '');
    const text = codeNode.textContent || '';
    const cleaned = text.replace(/\n$/, '');
    return `\n\n\`\`\`${language}\n${cleaned}\n\`\`\`\n\n`;
  }
});

const body = document.body;
const workspace = document.getElementById('workspace');
const menuBar = document.getElementById('menu-bar');
const rawEditor = document.getElementById('raw-editor');
const rawEditorShell = document.getElementById('raw-editor-shell');
const rawLineNumberList = document.getElementById('raw-line-number-list');
const frame = document.getElementById('formatted-frame');
const titlebarText = document.getElementById('titlebar-text');
const themeDebug = document.getElementById('theme-debug');
const ribbonThemeModeButtons = [...document.querySelectorAll('[data-theme-mode]')];
const editorFontMenu = document.getElementById('editor-font-menu');
const editorFontCurrent = document.getElementById('editor-font-current');
const settingsModal = document.getElementById('settings-modal');
const settingsRibbonMode = document.getElementById('settings-ribbon-mode');
const settingsThemeMode = document.getElementById('settings-theme-mode');
const settingsEmbeddedMenu = document.getElementById('settings-embedded-menu');
const settingsEditorFont = document.getElementById('settings-editor-font');
const settingsWordWrap = document.getElementById('settings-word-wrap');
const settingsLineNumbers = document.getElementById('settings-line-numbers');
const settingsSpellcheck = document.getElementById('settings-spellcheck');
const settingsDictionaryLanguage = document.getElementById('settings-dictionary-language');
const settingsMermaidPreview = document.getElementById('settings-mermaid-preview');
const settingsThemeDebug = document.getElementById('settings-theme-debug');
const recentFilesMenu = document.getElementById('recent-files-menu');
const tocPane = document.getElementById('toc-pane');
const tocList = document.getElementById('toc-list');
const commandPalette = document.getElementById('command-palette');
const paletteInput = document.getElementById('palette-input');
const paletteList = document.getElementById('palette-list');
const frontMatterModal = document.getElementById('front-matter-modal');
const frontMatterRows = document.getElementById('front-matter-rows');
const findReplaceModal = document.getElementById('find-replace-modal');
const findInput = document.getElementById('find-input');
const replaceInput = document.getElementById('replace-input');
const findRegex = document.getElementById('find-regex');
const findCase = document.getElementById('find-case');
const findWord = document.getElementById('find-word');
const findReplaceStatus = document.getElementById('find-replace-status');
const linkCheckModal = document.getElementById('link-check-modal');
const linkCheckSummary = document.getElementById('link-check-summary');
const linkCheckList = document.getElementById('link-check-list');
const keybindingsList = document.getElementById('keybindings-list');
const settingsKeyboardShortcuts = document.getElementById('settings-keyboard-shortcuts');
const versionHistoryModal = document.getElementById('version-history-modal');
const versionHistoryList = document.getElementById('version-history-list');
const statusLastSaved = document.getElementById('status-last-saved');
const statusLineCount = document.getElementById('status-line-count');
const statusWordCount = document.getElementById('status-word-count');
const statusCharCount = document.getElementById('status-char-count');
const statusImageCount = document.getElementById('status-image-count');

let markdownState = '';
let lastRenderedHtml = null;
let userCssPath = null;
let userCssText = '';
let themeLightPath = null;
let themeLightCssText = '';
let themeDarkPath = null;
let themeDarkCssText = '';
let renderingForExport = false;
let defaultTemplatePath = null;
let currentFilePath = null;
let currentFileName = 'Untitled.md';
let isDirty = false;
let savedBaseline = markdownState;
let lastSavedAt = null;

let showRaw = true;
let showFormatted = true;
let rawZoom = 1;
let formattedZoom = 1;
let ribbonMode = 'both';
let splitOrientation = 'horizontal';
let spellcheckEnabled = true;
let dictionaryLanguage = 'en-US';
let listContinuationMode = null;
let darkMode = false;
let darkModeMode = 'light';
let darkModeSyncSystem = false;
let embeddedMenu = false;
let themeDebugVisible = false;
let syncViewsEnabled = true;
let wordWrapEnabled = false;
let lineNumbersEnabled = false;
let editorFontFamily = '';
let editorFontFamilies = [];
let mermaidPreviewEnabled = false;
let outlineVisible = true;
let outlinePosition = 'right';
let lastFocusedEditor = 'raw';
let isApplyingRawHistory = false;
const rawUndoStack = [];
const rawRedoStack = [];

let suppressRawHandler = false;
let suppressFrameHandler = false;
let lastRawSnapshot = { text: markdownState, selectionStart: 0, selectionEnd: 0 };
let lastLineNumberCount = 0;
let lastLineNumberSignature = '';
let lastRawLineMetrics = null;
let formattedNormalizeTimer = null;
let lastFindQuery = '';
let rawFindCursor = 0;
let previewScrollSyncRaf = null;
let rawScrollSyncRaf = null;
let activeScrollSyncSource = null;
let previewAnchorCache = null;
let recentFiles = [];
let outlineItems = [];
let paletteItems = [];
let paletteActiveIndex = 0;
let exportHtmlPreset = 'default';
let exportPdfPreset = 'default';
let exportDocxPreset = 'default';
let exportPagesPreset = 'default';
let lastFindOptionsKey = '';
let findMatches = [];
let activeFindMatchIndex = -1;
let selectedSnapshotId = '';
let docSessionKey = `untitled-${Math.random().toString(36).slice(2, 10)}`;
let isRestoringSession = false;
let hasRestoredSessionState = false;
let autosaveTimer = null;
let autosaveInFlight = false;
let lastSnapshotHash = '';
let lastSnapshotAt = 0;

function isExportOnlyExtension(filePath) {
  const lower = String(filePath || '').toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.pdf') || lower.endsWith('.docx') || lower.endsWith('.pages');
}

const DEFAULT_KEYBINDINGS = {
  'file-new': 'CmdOrCtrl+N',
  'file-new-window': 'CmdOrCtrl+Shift+N',
  'file-new-from-template': 'Alt+CmdOrCtrl+N',
  'file-load': 'CmdOrCtrl+O',
  'file-save': 'CmdOrCtrl+S',
  'file-save-as': 'CmdOrCtrl+Shift+S',
  'app-exit': 'CmdOrCtrl+Q',
  'edit-find': 'CmdOrCtrl+F',
  'edit-replace': 'Alt+CmdOrCtrl+F',
  'find-next': 'CmdOrCtrl+G',
  'open-command-palette': 'CmdOrCtrl+Shift+P',
  'format-bold': 'CmdOrCtrl+B',
  'format-italic': 'CmdOrCtrl+I',
  'format-inline-code': 'CmdOrCtrl+E',
  'zoom-raw-in': 'CmdOrCtrl+=',
  'zoom-raw-out': 'CmdOrCtrl+-',
  'zoom-raw-reset': 'CmdOrCtrl+0',
  'edit-front-matter': 'CmdOrCtrl+M',
  'open-settings': 'CmdOrCtrl+,',
  'toggle-theme-debug': 'CmdOrCtrl+Shift+D'
};
let keybindings = { ...DEFAULT_KEYBINDINGS };
const IS_MAC = /\bMac|iPhone|iPad|iPod\b/i.test(navigator.platform || '');
const KEYBINDING_GROUPS = [
  {
    title: 'File',
    actions: [
      ['file-new', 'New Document'],
      ['file-new-window', 'New Window'],
      ['file-new-from-template', 'New from Template'],
      ['file-load', 'Open'],
      ['file-save', 'Save'],
      ['file-save-as', 'Export'],
      ['app-exit', 'Exit']
    ]
  },
  {
    title: 'Edit',
    actions: [
      ['edit-find', 'Find'],
      ['edit-replace', 'Replace'],
      ['find-next', 'Find Next'],
      ['open-command-palette', 'Command Palette']
    ]
  },
  {
    title: 'Format',
    actions: [
      ['format-bold', 'Bold'],
      ['format-italic', 'Italic'],
      ['format-inline-code', 'Inline Code']
    ]
  },
  {
    title: 'Zoom',
    actions: [
      ['zoom-raw-in', 'Editor Zoom In'],
      ['zoom-raw-out', 'Editor Zoom Out'],
      ['zoom-raw-reset', 'Reset Editor Zoom']
    ]
  },
  {
    title: 'Tools',
    actions: [
      ['edit-front-matter', 'Document Metadata'],
      ['open-settings', 'Settings'],
      ['toggle-theme-debug', 'Theme Debug']
    ]
  }
];

const menuTriggers = [...document.querySelectorAll('.menu-trigger')];
const menuGroups = [...document.querySelectorAll('.menu-group')];
const actionButtons = [...document.querySelectorAll('[data-action]')];

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeKeyComboString(input) {
  const tokens = String(input || '')
    .split('+')
    .map((item) => item.trim())
    .filter(Boolean);
  const mods = new Set();
  let key = '';
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === 'cmdorctrl' || lower === 'cmd' || lower === 'meta') mods.add('CmdOrCtrl');
    else if (lower === 'ctrl' || lower === 'control') mods.add('CmdOrCtrl');
    else if (lower === 'alt' || lower === 'option') mods.add('Alt');
    else if (lower === 'shift') mods.add('Shift');
    else key = token.length === 1 ? token.toUpperCase() : token;
  }
  const ordered = [];
  if (mods.has('CmdOrCtrl')) ordered.push('CmdOrCtrl');
  if (mods.has('Alt')) ordered.push('Alt');
  if (mods.has('Shift')) ordered.push('Shift');
  if (key) ordered.push(key);
  return ordered.join('+');
}

function formatKeyComboForPlatform(combo) {
  return String(combo || '')
    .split('+')
    .map((part) => {
      const token = part.trim();
      if (token === 'CmdOrCtrl') return IS_MAC ? 'Cmd' : 'Ctrl';
      if (token === 'Alt') return IS_MAC ? 'Option' : 'Alt';
      return token;
    })
    .filter(Boolean)
    .join('+');
}

function comboFromKeyboardEvent(event) {
  const parts = [];
  if (event.metaKey || event.ctrlKey) parts.push('CmdOrCtrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  let key = event.key;
  if (!key) return '';
  if (key === ' ') key = 'Space';
  if (key === 'Escape') key = 'Esc';
  if (key.length === 1) key = key.toUpperCase();
  const ignored = ['Meta', 'Control', 'Alt', 'Shift'];
  if (ignored.includes(key)) return '';
  parts.push(key);
  return normalizeKeyComboString(parts.join('+'));
}

function stableHash(input) {
  let hash = 2166136261;
  const text = String(input || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function basename(filePath) {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

function updateWindowTitle() {
  const dirtyPrefix = isDirty ? '● ' : '';
  const title = `Monospire - ${dirtyPrefix}${currentFileName}`;
  titlebarText.textContent = title;

  window.nativeApi.setDocumentState({
    title,
    path: currentFilePath,
    dirty: isDirty
  });
}

function formatSavedDateTime(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function computeWordCount(source) {
  const matches = (source || '').match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g);
  return matches ? matches.length : 0;
}

function computeImageCount(source) {
  const markdownImages = (source || '').match(/!\[[^\]]*]\([^)]+\)/g) || [];
  const htmlImages = (source || '').match(/<img\b[^>]*>/gi) || [];
  return markdownImages.length + htmlImages.length;
}

function countMarkdownLines(source) {
  const text = source || '';
  return text.length === 0 ? 1 : text.split('\n').length;
}

function updateStatusBar() {
  if (!statusLastSaved || !statusLineCount || !statusWordCount || !statusCharCount || !statusImageCount) return;

  statusLastSaved.textContent = `Last Saved: ${formatSavedDateTime(lastSavedAt)}`;
  statusLineCount.textContent = `Lines: ${countMarkdownLines(markdownState)}`;
  statusWordCount.textContent = `Words: ${computeWordCount(markdownState)}`;
  statusCharCount.textContent = `Characters: ${(markdownState || '').length}`;
  statusImageCount.textContent = `Images: ${computeImageCount(markdownState)}`;
}

function countRawEditorLines() {
  return countMarkdownLines(rawEditor.value);
}

function getRawEditorLineHeight() {
  const style = window.getComputedStyle(rawEditor);
  const parsed = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(parsed)) return parsed;
  const fontSize = Number.parseFloat(style.fontSize);
  return Number.isFinite(fontSize) ? fontSize * 1.6 : 22.4;
}

function measureWrappedRawLineHeights(lines) {
  const lineHeight = getRawEditorLineHeight();
  if (!wordWrapEnabled || !rawEditor.clientWidth) {
    return lines.map(() => lineHeight);
  }

  const style = window.getComputedStyle(rawEditor);
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(style.paddingRight) || 0;
  const contentWidth = Math.max(1, rawEditor.clientWidth - paddingLeft - paddingRight);
  const measurer = document.createElement('div');
  measurer.style.position = 'fixed';
  measurer.style.left = '-10000px';
  measurer.style.top = '0';
  measurer.style.visibility = 'hidden';
  measurer.style.boxSizing = 'border-box';
  measurer.style.width = `${contentWidth}px`;
  measurer.style.font = style.font;
  measurer.style.fontSize = style.fontSize;
  measurer.style.fontFamily = style.fontFamily;
  measurer.style.fontWeight = style.fontWeight;
  measurer.style.fontStyle = style.fontStyle;
  measurer.style.letterSpacing = style.letterSpacing;
  measurer.style.lineHeight = style.lineHeight;
  measurer.style.whiteSpace = 'pre-wrap';
  measurer.style.overflowWrap = 'break-word';
  measurer.style.tabSize = style.tabSize || '8';
  document.body.appendChild(measurer);

  const heights = lines.map((line) => {
    measurer.textContent = line.length > 0 ? line : ' ';
    return Math.max(lineHeight, measurer.scrollHeight);
  });
  measurer.remove();
  return heights;
}

function rawLineMetricSignature() {
  const style = window.getComputedStyle(rawEditor);
  return [
    wordWrapEnabled ? 'wrap' : 'nowrap',
    rawEditor.clientWidth,
    rawEditor.style.fontSize || '',
    style.fontFamily || '',
    rawEditor.value
  ].join(':');
}

function getRawLineMetrics({ force = false } = {}) {
  const text = rawEditor.value || '';
  const lines = text.split('\n');
  const signature = rawLineMetricSignature();
  if (!force && lastRawLineMetrics?.signature === signature) {
    return lastRawLineMetrics;
  }

  const style = window.getComputedStyle(rawEditor);
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
  const heights = measureWrappedRawLineHeights(lines);
  const tops = [];
  let cursor = paddingTop;
  for (const height of heights) {
    tops.push(cursor);
    cursor += height;
  }

  lastRawLineMetrics = {
    signature,
    lines,
    heights,
    tops,
    totalHeight: cursor + paddingBottom,
    paddingTop
  };
  return lastRawLineMetrics;
}

function rawLinePositionFromScrollTop(scrollTop) {
  const metrics = getRawLineMetrics();
  const tops = metrics.tops;
  if (tops.length === 0) return { line: 0, progress: 0 };
  const y = Math.max(0, scrollTop || 0);
  let index = 0;
  for (let i = 0; i < tops.length; i += 1) {
    if (tops[i] <= y) index = i;
    else break;
  }
  const start = tops[index] ?? metrics.paddingTop;
  const end = index + 1 < tops.length
    ? tops[index + 1]
    : Math.max(start + 1, metrics.totalHeight);
  const progress = Math.max(0, Math.min(1, (y - start) / Math.max(1, end - start)));
  return { line: index, progress };
}

function rawScrollTopForLinePosition(line, progress = 0) {
  const metrics = getRawLineMetrics();
  const index = Math.max(0, Math.min(metrics.tops.length - 1, Math.floor(line || 0)));
  const start = metrics.tops[index] ?? metrics.paddingTop;
  const end = index + 1 < metrics.tops.length
    ? metrics.tops[index + 1]
    : Math.max(start + 1, metrics.totalHeight);
  return Math.round(start + ((end - start) * Math.max(0, Math.min(1, progress))));
}

function updateLineNumberScroll() {
  if (!rawLineNumberList) return;
  rawLineNumberList.style.transform = `translateY(-${rawEditor.scrollTop || 0}px)`;
}

function updateLineNumbers({ force = false } = {}) {
  if (!rawLineNumberList) return;
  const metrics = getRawLineMetrics({ force });
  const lines = metrics.lines;
  const lineCount = countRawEditorLines();
  const signature = `${lineCount}:${metrics.signature}`;

  if (force || signature !== lastLineNumberSignature || lineCount !== lastLineNumberCount) {
    rawLineNumberList.replaceChildren();
    for (let index = 0; index < lineCount; index += 1) {
      const row = document.createElement('div');
      row.className = 'raw-line-number-row';
      row.textContent = String(index + 1);
      row.style.height = `${metrics.heights[index] || getRawEditorLineHeight()}px`;
      rawLineNumberList.appendChild(row);
    }
    lastLineNumberCount = lineCount;
    lastLineNumberSignature = signature;
  }
  updateLineNumberScroll();
}

async function loadKeybindingsPreference() {
  const result = await window.nativeApi.loadKeybindingsPreference();
  if (!result?.loaded || !result.keybindings || typeof result.keybindings !== 'object') {
    keybindings = { ...DEFAULT_KEYBINDINGS };
    return;
  }
  keybindings = { ...DEFAULT_KEYBINDINGS, ...result.keybindings };
}

async function saveKeybindingsPreference() {
  await window.nativeApi.saveKeybindingsPreference({ keybindings });
}

function cssFontFamilyValue(family) {
  const name = String(family || '').trim();
  if (!name) return '';
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace`;
}

function cssQuotedFontFamily(family) {
  return `"${String(family || '').trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function measureFontSample(context, fontStack) {
  context.font = `16px ${fontStack}`;
  return {
    narrow: context.measureText('iiiiiiiiii').width,
    wide: context.measureText('WWWWWWWWWW').width,
    mixed: context.measureText('ilMW01{}[]').width,
    repeated: context.measureText('mmmmmmmmmm').width
  };
}

function isMonospaceMeasurement(metrics) {
  return Math.abs(metrics.narrow - metrics.wide) < 0.5 && Math.abs(metrics.mixed - metrics.repeated) < 0.5;
}

function isLikelyMonospaceFont(family) {
  const name = String(family || '').trim();
  if (!name) return false;
  const canvas = isLikelyMonospaceFont.canvas || (isLikelyMonospaceFont.canvas = document.createElement('canvas'));
  const context = canvas.getContext('2d');
  if (!context) return false;

  const quoted = cssQuotedFontFamily(name);
  const serifFallback = measureFontSample(context, `${quoted}, serif`);
  const sansFallback = measureFontSample(context, `${quoted}, sans-serif`);

  if (!isMonospaceMeasurement(serifFallback) || !isMonospaceMeasurement(sansFallback)) {
    return false;
  }

  return (
    Math.abs(serifFallback.narrow - sansFallback.narrow) < 0.5 &&
    Math.abs(serifFallback.wide - sansFallback.wide) < 0.5 &&
    Math.abs(serifFallback.mixed - sansFallback.mixed) < 0.5
  );
}

function setEditorFontFamily(family, options = {}) {
  const persist = options.persist !== false;
  editorFontFamily = String(family || '').trim();
  document.documentElement.style.setProperty(
    '--editor-font-family',
    editorFontFamily
      ? cssFontFamilyValue(editorFontFamily)
      : 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'
  );
  if (editorFontCurrent) {
    editorFontCurrent.textContent = `${editorFontFamily || 'System Mono'} ›`;
  }
  if (editorFontMenu) {
    for (const button of editorFontMenu.querySelectorAll('[data-editor-font-family]')) {
      button.classList.toggle('checked', button.dataset.editorFontFamily === editorFontFamily);
    }
  }
  if (settingsEditorFont) {
    settingsEditorFont.value = editorFontFamily;
  }
  lastRawLineMetrics = null;
  updateLineNumbers({ force: true });
  if (persist) {
    void window.nativeApi.saveEditorFontPreference({ family: editorFontFamily });
  }
  notifyNativeMenuState();
}

async function populateEditorFontMenu() {
  if (!editorFontMenu && !settingsEditorFont) return;
  let families = [];
  try {
    const result = await window.nativeApi.listInstalledFontFamilies();
    families = Array.isArray(result?.families) ? result.families : [];
  } catch (error) {
    diagnosticLog('renderer.editor-fonts.list.error', { error: String(error?.message || error) });
  }

  const monospaceFamilies = families
    .filter(isLikelyMonospaceFont)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  editorFontFamilies = monospaceFamilies;
  const allFamilies = [''].concat(monospaceFamilies);
  if (editorFontFamily && !allFamilies.includes(editorFontFamily)) {
    allFamilies.push(editorFontFamily);
  }

  if (settingsEditorFont) {
    settingsEditorFont.replaceChildren();
    for (const family of allFamilies) {
      const option = document.createElement('option');
      option.value = family;
      option.textContent = family || 'System Mono';
      settingsEditorFont.appendChild(option);
    }
    settingsEditorFont.value = editorFontFamily;
  }

  if (editorFontMenu) {
    editorFontMenu.replaceChildren();
    for (const family of allFamilies) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.editorFontFamily = family;
      button.textContent = family || 'System Mono';
      button.classList.toggle('checked', family === editorFontFamily);
      editorFontMenu.appendChild(button);
    }
  }
  notifyNativeMenuState();
}

async function loadEditorFontPreference() {
  try {
    const result = await window.nativeApi.loadEditorFontPreference();
    return result?.loaded ? String(result.family || '') : '';
  } catch (error) {
    diagnosticLog('renderer.editor-font.load.error', { error: String(error?.message || error) });
    return '';
  }
}

function renderKeybindingsEditor() {
  if (!keybindingsList) return;
  keybindingsList.innerHTML = '';
  const rendered = new Set();

  for (const group of KEYBINDING_GROUPS) {
    const section = document.createElement('section');
    section.className = 'keybinding-section';
    const heading = document.createElement('h2');
    heading.textContent = group.title;
    section.appendChild(heading);

    for (const [action, labelText] of group.actions) {
      const defaultCombo = DEFAULT_KEYBINDINGS[action];
      if (!defaultCombo) continue;
      rendered.add(action);
      const row = document.createElement('div');
      row.className = 'keybinding-row';

      const label = document.createElement('label');
      label.setAttribute('for', `keybinding-${action}`);
      const labelMain = document.createElement('span');
      labelMain.className = 'keybinding-label-main';
      labelMain.textContent = labelText;
      const labelDefault = document.createElement('span');
      labelDefault.className = 'keybinding-label-default';
      labelDefault.textContent = `Default ${formatKeyComboForPlatform(defaultCombo)}`;
      label.appendChild(labelMain);
      label.appendChild(labelDefault);

      const input = document.createElement('input');
      input.type = 'text';
      input.id = `keybinding-${action}`;
      input.dataset.action = action;
      input.value = formatKeyComboForPlatform(keybindings[action] || defaultCombo);

      row.appendChild(label);
      row.appendChild(input);
      section.appendChild(row);
    }

    keybindingsList.appendChild(section);
  }

  for (const [action, defaultCombo] of Object.entries(DEFAULT_KEYBINDINGS)) {
    if (rendered.has(action)) continue;
    const row = document.createElement('div');
    row.className = 'keybinding-row';
    const label = document.createElement('label');
    label.setAttribute('for', `keybinding-${action}`);
    const labelMain = document.createElement('span');
    labelMain.className = 'keybinding-label-main';
    labelMain.textContent = action;
    const labelDefault = document.createElement('span');
    labelDefault.className = 'keybinding-label-default';
    labelDefault.textContent = `Default ${formatKeyComboForPlatform(defaultCombo)}`;
    label.appendChild(labelMain);
    label.appendChild(labelDefault);
    const input = document.createElement('input');
    input.type = 'text';
    input.id = `keybinding-${action}`;
    input.dataset.action = action;
    input.value = formatKeyComboForPlatform(keybindings[action] || defaultCombo);
    row.appendChild(label);
    row.appendChild(input);
    keybindingsList.appendChild(row);
  }
}

function openKeybindingsModal() {
  openSettings();
  renderKeybindingsEditor();
  settingsKeyboardShortcuts?.scrollIntoView({ block: 'start' });
}

function closeKeybindingsModal() {
  closeSettings();
}

async function saveKeybindingsFromEditor() {
  if (!keybindingsList) return;
  const inputs = [...keybindingsList.querySelectorAll('input[data-action]')];
  const next = { ...DEFAULT_KEYBINDINGS };
  for (const input of inputs) {
    const action = input.dataset.action;
    if (!action) continue;
    const normalized = normalizeKeyComboString(input.value);
    if (normalized) next[action] = normalized;
  }
  keybindings = next;
  await saveKeybindingsPreference();
  renderKeybindingsEditor();
}

async function resetKeybindingsToDefault() {
  keybindings = { ...DEFAULT_KEYBINDINGS };
  await saveKeybindingsPreference();
  renderKeybindingsEditor();
}

function buildSessionStatePayload() {
  const doc = frame.contentDocument;
  const scrollEl = doc?.scrollingElement || doc?.documentElement || doc?.body;
  return {
    state: {
      currentFilePath,
      currentFileName,
      markdown: markdownState,
      savedBaseline,
      isDirty,
      rawSelectionStart: rawEditor.selectionStart ?? 0,
      rawSelectionEnd: rawEditor.selectionEnd ?? 0,
      rawScrollTop: rawEditor.scrollTop ?? 0,
      previewScrollTop: scrollEl ? scrollEl.scrollTop : 0,
      showRaw,
      showFormatted,
      splitOrientation,
      lastSavedAt,
      docSessionKey
    }
  };
}

function publishSessionState() {
  window.nativeApi.sendSessionState(buildSessionStatePayload());
}

function applySessionState(state) {
  if (!state || typeof state !== 'object') return;
  isRestoringSession = true;
  hasRestoredSessionState = true;
  currentFilePath = state.currentFilePath || null;
  currentFileName = state.currentFileName || (currentFilePath ? basename(currentFilePath) : 'Untitled.md');
  markdownState = typeof state.markdown === 'string' ? state.markdown : '';
  rawEditor.value = markdownState;
  updateLineNumbers({ force: true });
  savedBaseline = typeof state.savedBaseline === 'string' ? state.savedBaseline : markdownState;
  lastSavedAt = state.lastSavedAt || null;
  docSessionKey = state.docSessionKey || docSessionKey;
  setViewVisibility(state.showRaw !== false, state.showFormatted !== false);
  setSplitOrientation(state.splitOrientation === 'vertical' ? 'vertical' : 'horizontal');
  renderFromMarkdown(markdownState);
  setDirty(Boolean(state.isDirty));
  updateWindowTitle();
  updateStatusBar();
  const selStart = Number.isFinite(state.rawSelectionStart) ? Math.max(0, state.rawSelectionStart) : 0;
  const selEnd = Number.isFinite(state.rawSelectionEnd) ? Math.max(0, state.rawSelectionEnd) : selStart;
  rawEditor.setSelectionRange(selStart, selEnd);
  rawEditor.scrollTop = Number.isFinite(state.rawScrollTop) ? Math.max(0, state.rawScrollTop) : 0;
  updateLineNumberScroll();
  setTimeout(() => {
    const doc = frame.contentDocument;
    const scrollEl = doc?.scrollingElement || doc?.documentElement || doc?.body;
    if (scrollEl) {
      scrollEl.scrollTop = Number.isFinite(state.previewScrollTop) ? Math.max(0, state.previewScrollTop) : 0;
    }
  }, 0);
  isRestoringSession = false;
  publishSessionState();
}

function currentDocKey() {
  return currentFilePath || docSessionKey || 'untitled';
}

async function maybeSnapshot(reason = 'auto') {
  const now = Date.now();
  const hash = stableHash(markdownState);
  if (hash === lastSnapshotHash && reason === 'auto') return;
  if (reason === 'auto' && now - lastSnapshotAt < 60000) return;
  const title = currentFileName || 'Untitled.md';
  await window.nativeApi.saveSnapshot({
    docKey: currentDocKey(),
    title,
    content: markdownState,
    reason
  });
  lastSnapshotAt = now;
  lastSnapshotHash = hash;
}

async function runAutosaveTick() {
  if (autosaveInFlight || isRestoringSession) return;
  autosaveInFlight = true;
  try {
    if (isDirty && currentFilePath) {
      if (!isExportOnlyExtension(currentFilePath)) {
        await saveCurrentFile(false, { fromAutosave: true });
      } else {
        diagnosticLog('autosave.skip.export-only-path', { path: currentFilePath });
      }
    }
    if (markdownState && markdownState.trim().length > 0) {
      await maybeSnapshot('auto');
    }
    publishSessionState();
  } finally {
    autosaveInFlight = false;
  }
}

function startAutosaveLoop() {
  if (autosaveTimer) clearInterval(autosaveTimer);
  autosaveTimer = setInterval(() => {
    void runAutosaveTick();
  }, 20000);
}

function openVersionHistoryModal() {
  if (!versionHistoryModal) return;
  versionHistoryModal.classList.remove('hidden');
  void refreshVersionHistory();
}

function closeVersionHistoryModal() {
  if (!versionHistoryModal) return;
  versionHistoryModal.classList.add('hidden');
}

async function refreshVersionHistory() {
  if (!versionHistoryList) return;
  const response = await window.nativeApi.listSnapshots({ docKey: currentDocKey() });
  const snapshots = Array.isArray(response?.snapshots) ? response.snapshots : [];
  versionHistoryList.innerHTML = '';
  selectedSnapshotId = snapshots[0]?.id || '';
  if (snapshots.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'snapshot-item';
    empty.textContent = 'No snapshots available.';
    versionHistoryList.appendChild(empty);
    return;
  }
  for (const item of snapshots) {
    const row = document.createElement('div');
    row.className = `snapshot-item${item.id === selectedSnapshotId ? ' active' : ''}`;
    row.dataset.snapshotId = item.id;
    const when = item.createdAt ? new Date(item.createdAt).toLocaleString() : 'Unknown time';
    const title = document.createElement('div');
    title.textContent = item.title || currentFileName;
    const meta = document.createElement('div');
    meta.className = 'snapshot-meta';
    meta.textContent = `${when} | ${item.hash || ''}`;
    row.appendChild(title);
    row.appendChild(meta);
    versionHistoryList.appendChild(row);
  }
}

async function restoreSelectedSnapshot() {
  if (!selectedSnapshotId) return;
  const loaded = await window.nativeApi.readSnapshot({ docKey: currentDocKey(), id: selectedSnapshotId });
  if (!loaded?.loaded) {
    window.alert('Unable to load selected snapshot.');
    return;
  }
  rawUndoStack.push(captureRawSnapshot());
  if (rawUndoStack.length > 500) rawUndoStack.shift();
  rawRedoStack.length = 0;
  // Force full refresh of editor/preview/outline even if snapshot content
  // matches the currently rendered HTML.
  lastRenderedHtml = '';
  setMarkdownProgrammatically(loaded.content || '');
  closeVersionHistoryModal();
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function applyTemplateTokens(content) {
  const source = String(content || '');
  const now = new Date();
  const dateValue = `${now.getFullYear()}-${pad2(now.getDate())}-${pad2(now.getMonth() + 1)}`;
  const timeValue = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

  return source
    .replace(/\{\{date\}\}/g, dateValue)
    .replace(/\{\{time\}\}/g, timeValue);
}

function splitFrontMatter(source) {
  const input = String(source || '');
  if (!input.startsWith('---\n') && !input.startsWith('---\r\n')) {
    return { hasFrontMatter: false, block: '', body: input, bodyLineOffset: 0 };
  }

  const lines = input.split(/\r?\n/);
  if (lines[0] !== '---') {
    return { hasFrontMatter: false, block: '', body: input, bodyLineOffset: 0 };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    return { hasFrontMatter: false, block: '', body: input, bodyLineOffset: 0 };
  }

  const blockLines = lines.slice(1, endIndex);
  let bodyStartLine = endIndex + 1;
  if (lines[bodyStartLine] === '') bodyStartLine += 1;
  const bodyLines = lines.slice(bodyStartLine);
  return {
    hasFrontMatter: true,
    block: blockLines.join('\n'),
    body: bodyLines.join('\n'),
    bodyLineOffset: bodyStartLine
  };
}

function parseFrontMatterFields(block) {
  const fields = [];
  const lines = String(block || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!key) continue;
    fields.push({ key, value });
  }
  return fields;
}

function serializeFrontMatterFields(fields) {
  const rows = Array.isArray(fields) ? fields : [];
  return rows
    .filter((row) => row && row.key && row.key.trim().length > 0)
    .map((row) => `${row.key.trim()}: ${String(row.value || '').trim()}`)
    .join('\n');
}

function escapeHtmlAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function mergeFrontMatterWithBody(frontMatterBlock, body) {
  const normalizedBody = String(body || '');
  const normalizedFrontMatter = String(frontMatterBlock || '').trim();
  if (!normalizedFrontMatter) return normalizedBody;
  if (!normalizedBody) return `---\n${normalizedFrontMatter}\n---\n`;
  return `---\n${normalizedFrontMatter}\n---\n\n${normalizedBody}`;
}

function buildOutlineFromMarkdown(source) {
  const split = splitFrontMatter(source);
  const markdownBody = split.body;
  const tokens = md.parse(markdownBody, {});
  const slugCounts = {};
  const items = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== 'heading_open') continue;
    const inlineToken = tokens[i + 1];
    const text = tokenPlainText(inlineToken);
    if (!text) continue;
    const level = Number((token.tag || 'h1').slice(1));
    const baseSlug = slugifyHeading(text);
    const count = slugCounts[baseSlug] || 0;
    slugCounts[baseSlug] = count + 1;
    const slug = count === 0 ? baseSlug : `${baseSlug}-${count + 1}`;
    const line = (Array.isArray(token.map) ? token.map[0] : 0) + (split.bodyLineOffset || 0);
    items.push({ text, level, slug, line });
  }

  return items;
}

function renderRecentFilesMenu() {
  if (!recentFilesMenu) return;
  recentFilesMenu.innerHTML = '';

  const clearButton = document.querySelector('[data-action="file-clear-recent"]');
  if (clearButton) clearButton.disabled = recentFiles.length === 0;

  if (recentFiles.length === 0) {
    const empty = document.createElement('button');
    empty.type = 'button';
    empty.disabled = true;
    empty.innerHTML = '<span class="menu-item-main"><img class="menu-item-icon" src="./assets/sf-symbols/recent.png" alt="" aria-hidden="true" />No Recent Files</span>';
    recentFilesMenu.appendChild(empty);
    return;
  }

  for (const filePath of recentFiles) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = 'file-open-recent';
    button.dataset.path = filePath;

    const main = document.createElement('span');
    main.className = 'menu-item-main';
    const icon = document.createElement('img');
    icon.className = 'menu-item-icon';
    icon.src = './assets/sf-symbols/recent.png';
    icon.alt = '';
    icon.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.textContent = basename(filePath);
    const details = document.createElement('span');
    details.className = 'shortcut';
    details.textContent = filePath;

    main.appendChild(icon);
    main.appendChild(name);
    button.appendChild(main);
    button.appendChild(details);
    recentFilesMenu.appendChild(button);
  }
}

async function refreshRecentFilesMenu() {
  const files = await window.nativeApi.getRecentFiles();
  recentFiles = Array.isArray(files) ? files : [];
  renderRecentFilesMenu();
}

async function addRecentFile(filePath) {
  if (!filePath) return;
  const files = await window.nativeApi.addRecentFile({ path: filePath });
  recentFiles = Array.isArray(files) ? files : recentFiles;
  renderRecentFilesMenu();
}

async function clearRecentFilesMenu() {
  const files = await window.nativeApi.clearRecentFiles();
  recentFiles = Array.isArray(files) ? files : [];
  renderRecentFilesMenu();
}

function renderOutlineList() {
  if (!tocList) return;
  tocList.innerHTML = '';
  if (outlineItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'toc-item';
    empty.classList.add('toc-empty');
    empty.innerHTML = '<strong>Headings appear here</strong><span>Add # or ## headings to build an outline.</span>';
    tocList.appendChild(empty);
    return;
  }

  for (const item of outlineItems) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toc-item';
    button.dataset.slug = item.slug;
    button.dataset.line = String(item.line);
    button.dataset.level = String(item.level);
    button.textContent = item.text;
    tocList.appendChild(button);
  }
}

function updateOutline() {
  outlineItems = buildOutlineFromMarkdown(markdownState);
  renderOutlineList();
}

function setOutlineVisible(enabled, options = {}) {
  const persist = options.persist !== false;
  outlineVisible = enabled !== false;
  workspace.classList.toggle('with-outline', outlineVisible);
  invalidatePreviewAnchorCache();
  if (persist) {
    void window.nativeApi.saveOutlinePreference({
      visible: outlineVisible,
      position: outlinePosition
    });
  }
  updateMenuChecks();
  notifyNativeMenuState();
}

function setOutlinePosition(position, options = {}) {
  const persist = options.persist !== false;
  if (position !== 'left' && position !== 'right') return;
  outlinePosition = position;
  workspace.classList.remove('outline-left', 'outline-right');
  workspace.classList.add(outlinePosition === 'left' ? 'outline-left' : 'outline-right');
  invalidatePreviewAnchorCache();
  if (persist) {
    void window.nativeApi.saveOutlinePreference({
      visible: outlineVisible,
      position: outlinePosition
    });
  }
  updateMenuChecks();
  notifyNativeMenuState();
}

function scrollRawToLine(lineNumber) {
  const text = rawEditor.value || '';
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < Math.min(lineNumber, lines.length); i += 1) {
    offset += lines[i].length + 1;
  }
  const clamped = Math.max(0, Math.min(offset, text.length));
  rawEditor.focus({ preventScroll: true });
  rawEditor.setSelectionRange(clamped, clamped);
  rawEditor.scrollTop = rawEditor.scrollHeight * (clamped / Math.max(1, text.length));
}

function jumpToOutlineItem(item) {
  if (!item) return;
  if (showFormatted && frame.contentDocument) {
    const target = frame.contentDocument.getElementById(item.slug);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
  }
  if (showRaw) {
    scrollRawToLine(item.line);
  }
}

function commandPaletteCommands() {
  return [
    { label: 'File: New', action: 'file-new' },
    { label: 'File: Open...', action: 'file-load' },
    { label: 'File: Save', action: 'file-save' },
    { label: 'File: Export...', action: 'file-save-as' },
    { label: 'Edit: Find...', action: 'edit-find' },
    { label: 'Edit: Replace...', action: 'edit-replace' },
    { label: 'Tools: Check Links...', action: 'check-links' },
    { label: 'File: Version History...', action: 'open-version-history' },
    { label: 'View: Show Markdown Editor', action: 'toggle-raw-view', payload: { enabled: true } },
    { label: 'View: Show Preview', action: 'toggle-formatted-view', payload: { enabled: true } },
    { label: 'View: Toggle Outline', action: 'toggle-outline-view' },
    { label: 'View: Outline Left', action: 'outline-left' },
    { label: 'View: Outline Right', action: 'outline-right' },
    { label: 'View: Syncronise Views', action: 'toggle-sync-views' },
    { label: 'View: Toggle Word Wrap', action: 'toggle-word-wrap' },
    { label: 'View: Toggle Line Numbers', action: 'toggle-line-numbers' },
    { label: 'Tools: Document Metadata', action: 'edit-front-matter' },
    { label: 'Tools: Load Theme', action: 'load-theme' },
    { label: 'Tools: Settings', action: 'open-settings' },
    { label: 'Tools: Theme Light', action: 'set-dark-mode-mode', payload: { mode: 'light' } },
    { label: 'Tools: Theme Dark', action: 'set-dark-mode-mode', payload: { mode: 'dark' } },
    { label: 'Tools: Theme Auto', action: 'set-dark-mode-mode', payload: { mode: 'auto' } }
  ];
}

function renderCommandPaletteList(filterText = '') {
  if (!paletteList) return;
  const query = String(filterText || '').trim().toLowerCase();
  paletteItems = commandPaletteCommands().filter((entry) => {
    if (!query) return true;
    return entry.label.toLowerCase().includes(query);
  });
  paletteActiveIndex = Math.min(paletteActiveIndex, Math.max(0, paletteItems.length - 1));

  paletteList.innerHTML = '';
  for (let i = 0; i < paletteItems.length; i += 1) {
    const entry = paletteItems[i];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `palette-item${i === paletteActiveIndex ? ' active' : ''}`;
    button.dataset.index = String(i);
    button.textContent = entry.label;
    paletteList.appendChild(button);
  }
}

function openCommandPalette() {
  if (!commandPalette || !paletteInput) return;
  commandPalette.classList.remove('hidden');
  paletteInput.value = '';
  paletteActiveIndex = 0;
  renderCommandPaletteList('');
  paletteInput.focus();
}

function closeCommandPalette() {
  if (!commandPalette) return;
  commandPalette.classList.add('hidden');
}

function executeCommandPaletteIndex(index) {
  const entry = paletteItems[index];
  if (!entry) return;
  closeCommandPalette();
  void handleAction(entry.action, entry.payload || {});
}

function renderFrontMatterRows(fields) {
  if (!frontMatterRows) return;
  frontMatterRows.innerHTML = '';
  const values = Array.isArray(fields) && fields.length > 0 ? fields : [{ key: '', value: '' }];

  for (let i = 0; i < values.length; i += 1) {
    const row = document.createElement('div');
    row.className = 'front-matter-row';
    row.innerHTML = `
      <input type="text" data-key-input="${i}" placeholder="key" value="${escapeHtmlAttr(values[i].key)}" />
      <input type="text" data-value-input="${i}" placeholder="value" value="${escapeHtmlAttr(values[i].value)}" />
      <button type="button" data-action="remove-front-matter-row" data-index="${i}">Remove</button>
    `;
    frontMatterRows.appendChild(row);
  }
}

function openFrontMatterEditor() {
  const split = splitFrontMatter(markdownState);
  const fields = parseFrontMatterFields(split.block);
  renderFrontMatterRows(fields);
  if (frontMatterModal) {
    frontMatterModal.classList.remove('hidden');
  }
}

function closeFrontMatterEditor() {
  if (frontMatterModal) {
    frontMatterModal.classList.add('hidden');
  }
}

function collectFrontMatterRows() {
  if (!frontMatterRows) return [];
  const rows = [...frontMatterRows.querySelectorAll('.front-matter-row')];
  return rows.map((row) => {
    const keyInput = row.querySelector('input[data-key-input]');
    const valueInput = row.querySelector('input[data-value-input]');
    return {
      key: keyInput?.value || '',
      value: valueInput?.value || ''
    };
  });
}

function saveFrontMatterFromEditor() {
  const split = splitFrontMatter(markdownState);
  const rows = collectFrontMatterRows();
  const nextFrontMatter = serializeFrontMatterFields(rows);
  const nextMarkdown = mergeFrontMatterWithBody(nextFrontMatter, split.body);
  setMarkdownProgrammatically(nextMarkdown);
  closeFrontMatterEditor();
}

function updateMenuChecks() {
  const rawToggle = document.querySelector('[data-toggle="raw"]');
  const formattedToggle = document.querySelector('[data-toggle="formatted"]');
  const embeddedMenuToggle = document.querySelector('[data-toggle="embedded-menu"]');
  const themeDebugToggle = document.querySelector('[data-toggle="theme-debug"]');
  const horizontalViewToggle = document.querySelector('[data-toggle="horizontal-view"]');
  const verticalViewToggle = document.querySelector('[data-toggle="vertical-view"]');
  const spellcheckToggle = document.querySelector('[data-toggle="spellcheck"]');
  const dictionaryUsToggle = document.querySelector('[data-toggle="dictionary-en-us"]');
  const dictionaryGbToggle = document.querySelector('[data-toggle="dictionary-en-gb"]');
  const darkModeLightToggle = document.querySelector('[data-toggle="dark-mode-light"]');
  const darkModeDarkToggle = document.querySelector('[data-toggle="dark-mode-dark"]');
  const darkModeAutoToggle = document.querySelector('[data-toggle="dark-mode-auto"]');
  const syncViewsToggle = document.querySelector('[data-toggle="sync-views"]');
  const wordWrapToggle = document.querySelector('[data-toggle="word-wrap"]');
  const lineNumbersToggle = document.querySelector('[data-toggle="line-numbers"]');
  const mermaidPreviewToggle = document.querySelector('[data-toggle="mermaid-preview"]');
  const outlineToggle = document.querySelector('[data-toggle="outline-view"]');
  const outlineLeftToggle = document.querySelector('[data-toggle="outline-left"]');
  const outlineRightToggle = document.querySelector('[data-toggle="outline-right"]');
  const exportHtmlDefault = document.querySelector('[data-toggle="export-html-default"]');
  const exportHtmlArticle = document.querySelector('[data-toggle="export-html-article"]');
  const exportHtmlCompact = document.querySelector('[data-toggle="export-html-compact"]');
  const exportPdfDefault = document.querySelector('[data-toggle="export-pdf-default"]');
  const exportPdfSerif = document.querySelector('[data-toggle="export-pdf-serif"]');
  const exportPdfDark = document.querySelector('[data-toggle="export-pdf-dark"]');
  const exportDocxDefault = document.querySelector('[data-toggle="export-docx-default"]');
  const exportDocxClassic = document.querySelector('[data-toggle="export-docx-classic"]');
  const exportDocxReport = document.querySelector('[data-toggle="export-docx-report"]');
  const exportPagesDefault = document.querySelector('[data-toggle="export-pages-default"]');
  const exportPagesManuscript = document.querySelector('[data-toggle="export-pages-manuscript"]');
  const exportPagesPresentation = document.querySelector('[data-toggle="export-pages-presentation"]');

  if (rawToggle) rawToggle.classList.toggle('checked', showRaw);
  if (formattedToggle) formattedToggle.classList.toggle('checked', showFormatted);
  if (embeddedMenuToggle) embeddedMenuToggle.classList.toggle('checked', embeddedMenu);
  if (themeDebugToggle) themeDebugToggle.classList.toggle('checked', themeDebugVisible);
  if (horizontalViewToggle) horizontalViewToggle.classList.toggle('checked', splitOrientation === 'horizontal');
  if (verticalViewToggle) verticalViewToggle.classList.toggle('checked', splitOrientation === 'vertical');
  if (spellcheckToggle) spellcheckToggle.classList.toggle('checked', spellcheckEnabled);
  if (dictionaryUsToggle) dictionaryUsToggle.classList.toggle('checked', dictionaryLanguage === 'en-US');
  if (dictionaryGbToggle) dictionaryGbToggle.classList.toggle('checked', dictionaryLanguage === 'en-GB');
  if (darkModeLightToggle) darkModeLightToggle.classList.toggle('checked', darkModeMode === 'light');
  if (darkModeDarkToggle) darkModeDarkToggle.classList.toggle('checked', darkModeMode === 'dark');
  if (darkModeAutoToggle) darkModeAutoToggle.classList.toggle('checked', darkModeMode === 'auto');
  for (const button of ribbonThemeModeButtons) {
    button.classList.toggle('checked', button.dataset.themeMode === darkModeMode);
  }
  if (syncViewsToggle) syncViewsToggle.classList.toggle('checked', syncViewsEnabled);
  if (wordWrapToggle) wordWrapToggle.classList.toggle('checked', wordWrapEnabled);
  if (lineNumbersToggle) lineNumbersToggle.classList.toggle('checked', lineNumbersEnabled);
  if (mermaidPreviewToggle) mermaidPreviewToggle.classList.toggle('checked', mermaidPreviewEnabled);
  if (outlineToggle) outlineToggle.classList.toggle('checked', outlineVisible);
  if (outlineLeftToggle) outlineLeftToggle.classList.toggle('checked', outlinePosition === 'left');
  if (outlineRightToggle) outlineRightToggle.classList.toggle('checked', outlinePosition === 'right');
  if (outlineLeftToggle) outlineLeftToggle.disabled = !outlineVisible;
  if (outlineRightToggle) outlineRightToggle.disabled = !outlineVisible;
  if (exportHtmlDefault) exportHtmlDefault.classList.toggle('checked', exportHtmlPreset === 'default');
  if (exportHtmlArticle) exportHtmlArticle.classList.toggle('checked', exportHtmlPreset === 'article');
  if (exportHtmlCompact) exportHtmlCompact.classList.toggle('checked', exportHtmlPreset === 'compact');
  if (exportPdfDefault) exportPdfDefault.classList.toggle('checked', exportPdfPreset === 'default');
  if (exportPdfSerif) exportPdfSerif.classList.toggle('checked', exportPdfPreset === 'serif');
  if (exportPdfDark) exportPdfDark.classList.toggle('checked', exportPdfPreset === 'dark');
  if (exportDocxDefault) exportDocxDefault.classList.toggle('checked', exportDocxPreset === 'default');
  if (exportDocxClassic) exportDocxClassic.classList.toggle('checked', exportDocxPreset === 'classic');
  if (exportDocxReport) exportDocxReport.classList.toggle('checked', exportDocxPreset === 'report');
  if (exportPagesDefault) exportPagesDefault.classList.toggle('checked', exportPagesPreset === 'default');
  if (exportPagesManuscript) exportPagesManuscript.classList.toggle('checked', exportPagesPreset === 'manuscript');
  if (exportPagesPresentation) exportPagesPresentation.classList.toggle('checked', exportPagesPreset === 'presentation');
  if (dictionaryUsToggle) dictionaryUsToggle.disabled = !spellcheckEnabled;
  if (dictionaryGbToggle) dictionaryGbToggle.disabled = !spellcheckEnabled;
  syncSettingsControls();
}

function syncSettingsControls() {
  if (settingsRibbonMode) settingsRibbonMode.value = ribbonMode;
  if (settingsThemeMode) settingsThemeMode.value = darkModeMode;
  if (settingsEmbeddedMenu) settingsEmbeddedMenu.checked = embeddedMenu;
  if (settingsEditorFont) settingsEditorFont.value = editorFontFamily;
  if (settingsWordWrap) settingsWordWrap.checked = wordWrapEnabled;
  if (settingsLineNumbers) settingsLineNumbers.checked = lineNumbersEnabled;
  if (settingsSpellcheck) settingsSpellcheck.checked = spellcheckEnabled;
  if (settingsDictionaryLanguage) {
    settingsDictionaryLanguage.value = dictionaryLanguage;
    settingsDictionaryLanguage.disabled = !spellcheckEnabled;
  }
  if (settingsMermaidPreview) settingsMermaidPreview.checked = mermaidPreviewEnabled;
  if (settingsThemeDebug) settingsThemeDebug.checked = themeDebugVisible;
}

function openSettings() {
  syncSettingsControls();
  renderKeybindingsEditor();
  if (settingsModal) settingsModal.classList.remove('hidden');
}

function closeSettings() {
  if (settingsModal) settingsModal.classList.add('hidden');
}

function notifyNativeMenuState() {
  const activeThemeFileName = (() => {
    if (!themeLightPath && !themeDarkPath) return '';
    const candidate = themeLightPath || themeDarkPath || '';
    return candidate ? path.basename(candidate) : '';
  })();

  window.nativeApi.updateMenuState({
    showRaw,
    showFormatted,
    darkMode,
    darkModeMode,
    darkModeSyncSystem,
    ribbonMode,
    splitOrientation,
    spellcheckEnabled,
    dictionaryLanguage,
    embeddedMenu,
    themeDebugVisible,
    syncViewsEnabled,
    wordWrapEnabled,
    lineNumbersEnabled,
    mermaidPreviewEnabled,
    outlineVisible,
    outlinePosition,
    exportHtmlPreset,
    exportPdfPreset,
    exportDocxPreset,
    exportPagesPreset,
    activeThemeFileName,
    editorFontFamily,
    editorFontFamilies
  });
}

function applySplitOrientation() {
  workspace.classList.remove('split-horizontal', 'split-vertical');
  workspace.classList.add(splitOrientation === 'vertical' ? 'split-vertical' : 'split-horizontal');
  invalidatePreviewAnchorCache();
}

function updateListModeButtons() {
  const bulletButton = document.querySelector('.ribbon-button[data-action="format-list-bullet"]');
  const numberButton = document.querySelector('.ribbon-button[data-action="format-list-number"]');
  if (bulletButton) bulletButton.classList.toggle('active', listContinuationMode === 'bullet');
  if (numberButton) numberButton.classList.toggle('active', listContinuationMode === 'number');
}

function setListContinuationMode(nextMode) {
  if (nextMode !== null && nextMode !== 'bullet' && nextMode !== 'number') return;
  listContinuationMode = nextMode;
  updateListModeButtons();
}

function setModeFromVisibility() {
  workspace.classList.remove('mode-raw', 'mode-formatted', 'mode-split');

  if (showRaw && showFormatted) {
    workspace.classList.add('mode-split');
  } else if (showRaw) {
    workspace.classList.add('mode-raw');
  } else {
    workspace.classList.add('mode-formatted');
  }

  applySplitOrientation();
  updateMenuChecks();
  notifyNativeMenuState();
}

function setViewVisibility(nextRaw, nextFormatted) {
  if (!nextRaw && !nextFormatted) {
    return;
  }

  showRaw = nextRaw;
  showFormatted = nextFormatted;
  setModeFromVisibility();
  invalidatePreviewAnchorCache();
  publishSessionState();
}

function setDirty(nextDirty) {
  if (isDirty === nextDirty) return;
  isDirty = nextDirty;
  updateWindowTitle();
}

function updateDirtyFromState() {
  setDirty(markdownState !== savedBaseline);
}

function captureRawSnapshot() {
  return {
    text: rawEditor.value,
    selectionStart: rawEditor.selectionStart ?? 0,
    selectionEnd: rawEditor.selectionEnd ?? 0
  };
}

function syncRawSnapshot() {
  lastRawSnapshot = captureRawSnapshot();
}

function applyRawSnapshot(snapshot) {
  isApplyingRawHistory = true;
  suppressRawHandler = true;
  rawEditor.value = snapshot.text;
  updateLineNumbers({ force: true });
  rawEditor.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  rawEditor.focus({ preventScroll: true });
  suppressRawHandler = false;
  renderFromMarkdown(snapshot.text);
  syncRawSnapshot();
  updateDirtyFromState();
  isApplyingRawHistory = false;
}

function undoRaw() {
  if (rawUndoStack.length === 0) return;
  rawRedoStack.push(captureRawSnapshot());
  const previous = rawUndoStack.pop();
  applyRawSnapshot(previous);
}

function redoRaw() {
  if (rawRedoStack.length === 0) return;
  rawUndoStack.push(captureRawSnapshot());
  const next = rawRedoStack.pop();
  applyRawSnapshot(next);
}

function applyRawZoom() {
  rawEditor.style.fontSize = `${14 * rawZoom}px`;
  updateLineNumbers({ force: true });
}

function applyFormattedZoom() {
  const doc = frame.contentDocument;
  if (!doc) return;
  if (userCssText && userCssText.trim().length > 0) {
    doc.body.style.fontSize = '';
    invalidatePreviewAnchorCache();
    return;
  }
  doc.body.style.fontSize = `${15 * formattedZoom}px`;
  invalidatePreviewAnchorCache();
}

function setRibbonMode(nextMode, options = {}) {
  const persist = options.persist !== false;
  ribbonMode = nextMode;
  body.classList.remove('ribbon-icons', 'ribbon-text', 'ribbon-both');
  if (nextMode === 'icons') body.classList.add('ribbon-icons');
  if (nextMode === 'text') body.classList.add('ribbon-text');
  if (nextMode === 'both') body.classList.add('ribbon-both');
  if (persist) {
    void window.nativeApi.saveRibbonModePreference({ mode: ribbonMode });
  }
  notifyNativeMenuState();
}

function setSplitOrientation(nextOrientation) {
  if (nextOrientation !== 'horizontal' && nextOrientation !== 'vertical') return;
  splitOrientation = nextOrientation;
  applySplitOrientation();
  updateMenuChecks();
  notifyNativeMenuState();
  publishSessionState();
}

function applySpellcheckSetting() {
  rawEditor.spellcheck = spellcheckEnabled;
  const doc = frame.contentDocument;
  if (!doc?.body) return;
  doc.body.spellcheck = spellcheckEnabled;
}

function setSpellcheckEnabled(enabled) {
  spellcheckEnabled = enabled;
  applySpellcheckSetting();
  updateMenuChecks();
  notifyNativeMenuState();
}

async function setDictionaryLanguage(language) {
  if (!spellcheckEnabled) return;
  if (language !== 'en-US' && language !== 'en-GB') return;
  const result = await window.nativeApi.setSpellcheckLanguage({ language });
  if (result?.ok) {
    dictionaryLanguage = result.language;
    updateMenuChecks();
    notifyNativeMenuState();
  }
}

function normalizeDarkModeMode(mode) {
  if (mode === 'dark' || mode === 'auto') return mode;
  return 'light';
}

function setDarkMode(enabled, options = {}) {
  const persist = options.persist !== false;
  darkMode = enabled;
  body.classList.toggle('dark-content', darkMode);
  for (const button of ribbonThemeModeButtons) {
    button.classList.toggle('checked', button.dataset.themeMode === darkModeMode);
  }
  applyFrameTheme();
  if (syntaxReady) {
    lastRenderedHtml = '';
    renderFromMarkdown(markdownState);
  }
  void applyThemeVariantForMode();
  if (persist) {
    void window.nativeApi.saveDarkModePreference({ enabled: darkMode });
  }
  notifyNativeMenuState();
}

async function loadDarkModePreference() {
  const result = await window.nativeApi.loadDarkModePreference();
  if (!result?.loaded) return 'light';
  if (result.mode === 'light' || result.mode === 'dark' || result.mode === 'auto') return result.mode;
  return result.enabled ? 'dark' : 'light';
}

async function loadDarkModeSyncPreference() {
  const result = await window.nativeApi.loadDarkModeSyncPreference();
  if (!result?.loaded) return false;
  return result.enabled === true;
}

async function loadSystemDarkMode() {
  const result = await window.nativeApi.getSystemDarkMode();
  return result?.enabled === true;
}

function setDarkModeSyncSystem(enabled, options = {}) {
  const persist = options.persist !== false;
  const applySystem = options.applySystem !== false;
  darkModeSyncSystem = enabled === true;
  darkModeMode = darkModeSyncSystem ? 'auto' : (darkMode ? 'dark' : 'light');
  updateMenuChecks();
  if (persist) {
    void window.nativeApi.saveDarkModeSyncPreference({ enabled: darkModeSyncSystem });
  }
  notifyNativeMenuState();
  if (darkModeSyncSystem && applySystem) {
    void (async () => {
      const systemDark = await loadSystemDarkMode();
      setDarkMode(systemDark, { persist: false });
    })();
  }
}

async function setDarkModeMode(mode, options = {}) {
  const persist = options.persist !== false;
  darkModeMode = normalizeDarkModeMode(mode);
  darkModeSyncSystem = darkModeMode === 'auto';
  updateMenuChecks();
  notifyNativeMenuState();

  if (persist) {
    void window.nativeApi.saveDarkModePreference({
      mode: darkModeMode,
      enabled: darkModeMode === 'dark'
    });
  }

  if (darkModeMode === 'auto') {
    const systemDark = await loadSystemDarkMode();
    if (darkModeMode === 'auto') {
      setDarkMode(systemDark, { persist: false });
    }
    return;
  }

  setDarkMode(darkModeMode === 'dark', { persist: false });
}

async function loadRibbonModePreference() {
  const result = await window.nativeApi.loadRibbonModePreference();
  if (!result?.loaded) return 'both';
  if (result.mode !== 'icons' && result.mode !== 'text' && result.mode !== 'both') return 'both';
  return result.mode;
}

async function loadSyncViewsPreference() {
  const result = await window.nativeApi.loadSyncViewsPreference();
  if (!result?.loaded) return true;
  return result.enabled !== false;
}

async function loadWordWrapPreference() {
  const result = await window.nativeApi.loadWordWrapPreference();
  if (!result?.loaded) return false;
  return result.enabled === true;
}

async function loadMermaidPreviewPreference() {
  const result = await window.nativeApi.loadMermaidPreviewPreference();
  if (!result?.loaded) return false;
  return result.enabled === true;
}

async function loadOutlinePreference() {
  const result = await window.nativeApi.loadOutlinePreference();
  if (!result?.loaded) return { visible: true, position: 'right' };
  return {
    visible: result.visible !== false,
    position: result.position === 'left' ? 'left' : 'right'
  };
}

function setEmbeddedMenu(enabled) {
  embeddedMenu = enabled;
  body.classList.toggle('embedded-menu-hidden', !embeddedMenu);
  if (menuBar) {
    menuBar.style.display = embeddedMenu ? '' : 'none';
  }
  if (!embeddedMenu) {
    closeAllMenus();
  }
  updateMenuChecks();
  notifyNativeMenuState();
}

function setThemeDebugVisible(enabled) {
  themeDebugVisible = enabled;
  body.classList.toggle('theme-debug-visible', themeDebugVisible);
  if (themeDebug) {
    themeDebug.style.display = themeDebugVisible ? '' : 'none';
  }
  updateMenuChecks();
  notifyNativeMenuState();
}

function setSyncViewsEnabled(enabled, options = {}) {
  const persist = options.persist !== false;
  syncViewsEnabled = enabled !== false;
  updateMenuChecks();
  if (persist) {
    void window.nativeApi.saveSyncViewsPreference({ enabled: syncViewsEnabled });
  }
  notifyNativeMenuState();
}

function setWordWrapEnabled(enabled, options = {}) {
  const persist = options.persist !== false;
  wordWrapEnabled = enabled === true;
  rawEditor.wrap = wordWrapEnabled ? 'soft' : 'off';
  updateLineNumbers({ force: true });
  if (persist) {
    void window.nativeApi.saveWordWrapPreference({ enabled: wordWrapEnabled });
  }
  updateMenuChecks();
  notifyNativeMenuState();
}

function setLineNumbersEnabled(enabled, options = {}) {
  const persist = options.persist !== false;
  lineNumbersEnabled = enabled === true;
  if (rawEditorShell) {
    rawEditorShell.classList.toggle('line-numbers-visible', lineNumbersEnabled);
  }
  if (lineNumbersEnabled) updateLineNumbers({ force: true });
  if (persist) {
    void window.nativeApi.saveLineNumbersPreference({ enabled: lineNumbersEnabled });
  }
  updateMenuChecks();
  notifyNativeMenuState();
}

async function loadLineNumbersPreference() {
  const result = await window.nativeApi.loadLineNumbersPreference();
  if (!result?.loaded) return false;
  return result.enabled === true;
}

function setMermaidPreviewEnabled(enabled, options = {}) {
  const persist = options.persist !== false;
  mermaidPreviewEnabled = enabled === true;
  updateMenuChecks();
  if (persist) {
    void window.nativeApi.saveMermaidPreviewPreference({ enabled: mermaidPreviewEnabled });
  }
  notifyNativeMenuState();
  if (mermaidPreviewEnabled) {
    scheduleFrameMermaidRender();
  } else {
    mermaidRenderVersion += 1;
    const doc = frame.contentDocument;
    if (doc) {
      for (const block of [...doc.querySelectorAll('[data-mermaid-block]')]) {
        const sourcePre = block.querySelector('[data-mermaid-source]');
        const renderTarget = block.querySelector('[data-mermaid-render]');
        if (sourcePre) {
          sourcePre.removeAttribute('hidden');
          sourcePre.setAttribute('aria-hidden', 'false');
          sourcePre.style.removeProperty('display');
        }
        if (renderTarget) {
          renderTarget.innerHTML = '';
        }
        block.classList.remove('mermaid-ready', 'mermaid-error');
      }
    }
  }
}

function applyFrameTheme() {
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.body.classList.toggle('theme-dark', darkMode);
  invalidatePreviewAnchorCache();
}

function ensurePreviewChromeCss(doc) {
  if (!doc) return;
  let previewChromeCss = doc.getElementById('preview-chrome-css');
  if (!previewChromeCss) {
    const head = doc.head || doc.getElementsByTagName('head')[0];
    if (!head) return;
    previewChromeCss = doc.createElement('style');
    previewChromeCss.id = 'preview-chrome-css';
    head.appendChild(previewChromeCss);
  }
  previewChromeCss.textContent = `
    body {
      box-sizing: border-box !important;
      padding: 12px 28px 32px 28px !important;
    }
    body > :first-child {
      margin-top: 0 !important;
    }
    .preview-empty-state {
      min-height: calc(100vh - 48px);
      display: grid;
      place-items: center;
      color: #8b92a1;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
      text-align: center;
    }
    .preview-empty-state > div {
      max-width: 320px;
      display: grid;
      gap: 6px;
    }
    .preview-empty-state strong {
      color: #666675;
      font-size: 13px;
    }
    .preview-empty-state span {
      font-size: 12px;
      line-height: 1.45;
    }
    body.theme-dark .preview-empty-state {
      color: #858ea0;
    }
    body.theme-dark .preview-empty-state strong {
      color: #c3cad9;
    }
  `;
}

function ensureFrameDocument() {
  if (frame.contentDocument?.readyState === 'complete') {
    ensurePreviewChromeCss(frame.contentDocument);
    return;
  }

  frame.srcdoc = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; padding: 0; }
      body {
        box-sizing: border-box;
      }
      body.use-default-theme {
        min-height: 100vh;
        padding: 20px;
        font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
        font-size: 15px;
        line-height: 1.6;
        color: #1f1f23;
        background: transparent;
        outline: none;
      }
      body.theme-dark {
        color: #ecedf0;
      }
      pre.code-block {
        padding-top: 0.7em;
      }
      pre.code-block > .code-block-label {
        display: block !important;
        font-size: 0.5em !important;
        line-height: 1.15 !important;
        font-weight: 700 !important;
        font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif !important;
        letter-spacing: 0.02em !important;
        text-transform: uppercase !important;
        color: rgba(102, 105, 122, 0.92) !important;
        margin: 0 0 0.45em 0 !important;
        padding: 0 !important;
        pointer-events: none;
      }
      pre.code-block > code {
        display: block !important;
      }
      body.theme-dark .code-block-label { color: rgba(169, 176, 196, 0.95); }
      pre.code-block .hl-keyword { color: #7b2cbf !important; font-weight: 600 !important; }
      pre.code-block .hl-string { color: #0f7b49 !important; }
      pre.code-block .hl-comment { color: #6f7787 !important; font-style: italic !important; }
      pre.code-block .hl-number { color: #b24f00 !important; }
      pre.code-block .hl-property { color: #005e8a !important; }
      pre.code-block .hljs-keyword { color: #7b2cbf !important; font-weight: 600 !important; }
      pre.code-block .hljs-string { color: #0f7b49 !important; }
      pre.code-block .hljs-comment { color: #6f7787 !important; font-style: italic !important; }
      pre.code-block .hljs-number { color: #b24f00 !important; }
      pre.code-block .hljs-literal { color: #005e8a !important; }
      pre.code-block .hljs-type { color: #9c27b0 !important; }
      pre.code-block .hljs-title, pre.code-block .hljs-title.function_ { color: #005e8a !important; }
      pre.code-block .hljs-built_in { color: #9c27b0 !important; }
      body.theme-dark pre.code-block .hl-keyword { color: #c792ea !important; }
      body.theme-dark pre.code-block .hl-string { color: #8bd49c !important; }
      body.theme-dark pre.code-block .hl-comment { color: #97a1b4 !important; }
      body.theme-dark pre.code-block .hl-number { color: #f6a45e !important; }
      body.theme-dark pre.code-block .hl-property { color: #7ecbff !important; }
      body.theme-dark pre.code-block .hljs-keyword { color: #c792ea !important; }
      body.theme-dark pre.code-block .hljs-string { color: #8bd49c !important; }
      body.theme-dark pre.code-block .hljs-comment { color: #97a1b4 !important; }
      body.theme-dark pre.code-block .hljs-number { color: #f6a45e !important; }
      body.theme-dark pre.code-block .hljs-literal { color: #7ecbff !important; }
      body.theme-dark pre.code-block .hljs-type { color: #d8a5ff !important; }
      body.theme-dark pre.code-block .hljs-title, body.theme-dark pre.code-block .hljs-title.function_ { color: #7ecbff !important; }
      body.theme-dark pre.code-block .hljs-built_in { color: #d8a5ff !important; }
      body.use-default-theme pre { background: #f3f3f7; border-radius: 8px; padding: 12px; overflow-x: auto; }
      body.use-default-theme.theme-dark pre { background: #2b3039; }
      body.use-default-theme code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; background: #f3f3f7; padding: 0.1em 0.35em; border-radius: 4px; }
      body.use-default-theme.theme-dark code { background: #2b3039; }
      body.use-default-theme pre code { background: transparent; padding: 0; }
      body.use-default-theme blockquote { margin-left: 0; border-left: 3px solid #d2d2da; padding-left: 12px; color: #4d4d5d; }
      body.use-default-theme.theme-dark blockquote { border-left-color: #4f5768; color: #c7ccd8; }
      body.use-default-theme table { border-collapse: collapse; }
      body.use-default-theme th, body.use-default-theme td { border: 1px solid #d8d8df; padding: 8px 10px; }
      body.use-default-theme.theme-dark th, body.use-default-theme.theme-dark td { border-color: #475062; }
      .mermaid-block { margin: 0.65em 0; }
      .mermaid-block > .mermaid-source { margin: 0; }
      .mermaid-block > .mermaid-render { min-height: 1px; overflow-x: auto; }
      .mermaid-block > .mermaid-render svg { max-width: 100%; height: auto; display: block; }
      .mermaid-block > .mermaid-render .mermaid-error { font-size: 0.86em; color: #8a2b2b; background: #fff3f3; border: 1px solid #f0c8c8; border-radius: 6px; padding: 8px 10px; }
      body.theme-dark .mermaid-block > .mermaid-render .mermaid-error { color: #ffb1b1; background: #3a2222; border-color: #5d3434; }
    </style>
    <style id="user-css"></style>
    <style id="preview-chrome-css">
      body {
        box-sizing: border-box !important;
        padding: 12px 28px 32px 28px !important;
      }
      body > :first-child {
        margin-top: 0 !important;
      }
    </style>
  </head>
  <body class="use-default-theme" contenteditable="true" spellcheck="true" lang="en-US"></body>
</html>`;
}

function normalizeThemeCss(cssText) {
  const upgraded = (cssText || '').replace(/@import\s+url\((['"]?)http:\/\//gi, '@import url($1https://');
  const importPattern = /@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')\s*;/gi;
  const importMatches = upgraded.match(importPattern) || [];
  const withoutImports = upgraded.replace(importPattern, '').trim();
  if (importMatches.length === 0) return upgraded;
  return `${importMatches.join('\n')}\n${withoutImports}`;
}

function buildExportThemeCss() {
  const lightThemeCss = themeLightCssText && themeLightCssText.trim().length > 0 ? themeLightCssText : '';
  const baseThemeCss = lightThemeCss || userCssText || '';

  const needsReadableTextOverride = !lightThemeCss;
  const textOverrides = needsReadableTextOverride
    ? `
      --text: #1f1f23;
      --heading: #111827;
      --muted: #59636e;
      --border: #d0d7de;
      --rule: #d0d7de;
      --link: #0969da;
      --accent: #0969da;
      --code-text: #24292f;
      --code-border: #d0d7de;
    `
    : '';

  const exportOverrides = `
    :root {
      --bg: #ffffff;
      --panel: #f6f8fa;
      --quote-bg: #f6f8fa;
      --table-head: #f6f8fa;
      --table-row: #ffffff;
      --code-bg: #f6f8fa;
      --code-inline-bg: #f6f8fa;
      --code-block-bg: #f6f8fa;
      ${textOverrides}
    }

    html,
    body {
      background: #ffffff !important;
    }

    ${needsReadableTextOverride ? `
    body { color: var(--text) !important; }
    h1, h2, h3, h4, h5, h6 { color: var(--heading) !important; }
    blockquote { color: var(--muted) !important; background: var(--quote-bg) !important; border-color: var(--border) !important; }
    a, a:visited { color: var(--link) !important; }
    hr { border-color: var(--border) !important; }
    th { background: var(--table-head) !important; }
    td, th { border-color: var(--border) !important; }
    ` : ''}
    code { background: var(--code-bg) !important; }
    pre {
      background: var(--code-block-bg, var(--code-bg)) !important;
      max-width: 100% !important;
      overflow-x: visible !important;
      white-space: pre-wrap !important;
      overflow-wrap: anywhere !important;
      word-break: break-word !important;
    }
    pre code {
      background: transparent !important;
      white-space: pre-wrap !important;
      overflow-wrap: anywhere !important;
      word-break: break-word !important;
    }
  `;

  return normalizeThemeCss(`${baseThemeCss}\n${exportOverrides}`);
}

function updateThemeDebug() {
  if (!themeDebug) return;
  const doc = frame.contentDocument;
  if (!doc) {
    themeDebug.textContent = `Theme debug: frame not ready | cssBytes=${userCssText.length}`;
    return;
  }

  const bodyStyle = doc.defaultView?.getComputedStyle(doc.body);
  const h1 = doc.querySelector('h1');
  const p = doc.querySelector('p');
  const h1Style = h1 ? doc.defaultView.getComputedStyle(h1) : null;
  const pStyle = p ? doc.defaultView.getComputedStyle(p) : null;
  const styleTag = doc.getElementById('user-css');
  const injectedBytes = styleTag?.textContent?.length || 0;
  const adoptedSheets = doc.adoptedStyleSheets ? doc.adoptedStyleSheets.length : 0;
  let sheetRules = 'n/a';
  try {
    sheetRules = styleTag?.sheet?.cssRules?.length ?? 'n/a';
  } catch {
    sheetRules = 'blocked';
  }

  const bodyFont = bodyStyle ? bodyStyle.fontFamily : 'n/a';
  const h1Font = h1Style ? h1Style.fontFamily : 'n/a';
  const pFont = pStyle ? pStyle.fontFamily : 'n/a';
  const pSize = pStyle ? pStyle.fontSize : 'n/a';
  const bodyClass = doc.body.className || '(none)';
  const bodyInlineSize = doc.body.style.fontSize || '(none)';

  const syntaxStatus = syntaxReady ? 'highlight.js(on)' : `highlight.js(off${syntaxError ? `:${syntaxError.slice(0, 70)}` : ''})`;
  const mermaidBase = mermaidApi
    ? `mermaid(on:${mermaidBackend || mermaidApi.backend || 'unknown'})`
    : `mermaid(off${mermaidError ? `:${mermaidError.slice(0, 50)}` : ''})`;
  const mermaidStatus = mermaidPreviewEnabled ? mermaidBase : `${mermaidBase}[preview-off]`;
  themeDebug.textContent = `Theme debug: cssBytes=${userCssText.length} | injectedBytes=${injectedBytes} | adoptedSheets=${adoptedSheets} | sheetRules=${sheetRules} | syntax=${syntaxStatus} | ${mermaidStatus} | bodyClass=${bodyClass} | bodyInlineSize=${bodyInlineSize} | bodyFont=${bodyFont} | h1Font=${h1Font} | pFont=${pFont} | pSize=${pSize}`;
}

async function updateFrameCss() {
  const doc = frame.contentDocument;
  if (!doc) return;
  ensurePreviewChromeCss(doc);
  let userCss = doc.getElementById('user-css');
  let darkFallbackCss = doc.getElementById('dark-fallback-css');
  if (!userCss) {
    const head = doc.head || doc.getElementsByTagName('head')[0];
    if (!head) return;
    userCss = doc.createElement('style');
    userCss.id = 'user-css';
    head.appendChild(userCss);
    darkFallbackCss = doc.createElement('style');
    darkFallbackCss.id = 'dark-fallback-css';
    head.appendChild(darkFallbackCss);
  } else if (!darkFallbackCss) {
    const head = doc.head || doc.getElementsByTagName('head')[0];
    if (!head) return;
    darkFallbackCss = doc.createElement('style');
    darkFallbackCss.id = 'dark-fallback-css';
    head.appendChild(darkFallbackCss);
  }
  try {
    if (userCssPath) {
      const normalizedCss = normalizeThemeCss(userCssText || '');
      userCss.textContent = normalizedCss;
      // Keep style-tag injection as the primary path; adoptedStyleSheets is best-effort only.
      if (doc.adoptedStyleSheets && typeof CSSStyleSheet !== 'undefined') {
        try {
          if (!doc.__monospireBaseSheets) {
            doc.__monospireBaseSheets = [...doc.adoptedStyleSheets];
          }
          if (!doc.__monospireThemeSheet) {
            doc.__monospireThemeSheet = new CSSStyleSheet();
          }
          doc.__monospireThemeSheet.replaceSync(normalizedCss);
          doc.adoptedStyleSheets = [...doc.__monospireBaseSheets, doc.__monospireThemeSheet];
        } catch {
          // Themes with @import can fail in constructable stylesheets. Ignore and continue.
        }
      }
      if (normalizedCss.trim().length > 0) {
        doc.body.classList.remove('use-default-theme');
        doc.body.style.fontSize = '';
        doc.body.style.fontFamily = '';
      } else {
        doc.body.classList.add('use-default-theme');
      }

      const hasDarkCompanion = Boolean(themeDarkCssText && themeDarkCssText.trim().length > 0);
      const shouldUseDarkFallback = darkMode && !hasDarkCompanion;
      darkFallbackCss.textContent = shouldUseDarkFallback
        ? `
          body.theme-dark { background: #121419 !important; color: #e7eaf0 !important; }
          body.theme-dark h1, body.theme-dark h2, body.theme-dark h3, body.theme-dark h4, body.theme-dark h5, body.theme-dark h6 { color: #f3f6fd !important; }
          body.theme-dark a, body.theme-dark a:visited { color: #9fc3ff !important; }
          body.theme-dark blockquote { color: #d4dbeb !important; border-left-color: #4f5768 !important; background: #1a202a !important; }
          body.theme-dark pre { background: #1b2029 !important; border-color: #2f3746 !important; }
          body.theme-dark code { background: #1b2029 !important; border-color: #2f3746 !important; color: #e5e9f2 !important; }
          body.theme-dark table, body.theme-dark th, body.theme-dark td { border-color: #2f3746 !important; }
        `
        : '';
    } else {
      userCss.textContent = '';
      darkFallbackCss.textContent = '';
      if (doc.adoptedStyleSheets && doc.__monospireBaseSheets) {
        doc.adoptedStyleSheets = [...doc.__monospireBaseSheets];
      }
      doc.body.classList.add('use-default-theme');
    }
  } catch {
    userCss.textContent = '';
    if (darkFallbackCss) darkFallbackCss.textContent = '';
    if (doc.adoptedStyleSheets && doc.__monospireBaseSheets) doc.adoptedStyleSheets = [...doc.__monospireBaseSheets];
    doc.body.classList.add('use-default-theme');
  }
  invalidatePreviewAnchorCache();
  updateThemeDebug();
}

function deriveThemePairPaths(selectedPath) {
  if (!selectedPath || !selectedPath.toLowerCase().endsWith('.css')) {
    return { lightPath: selectedPath, darkPath: null };
  }

  if (selectedPath.toLowerCase().endsWith('-dark.css')) {
    return {
      lightPath: selectedPath.slice(0, -9) + '.css',
      darkPath: selectedPath
    };
  }

  return {
    lightPath: selectedPath,
    darkPath: selectedPath.slice(0, -4) + '-dark.css'
  };
}

function setActiveThemeFromMode() {
  if (!themeLightPath && !themeDarkPath) {
    userCssPath = null;
    userCssText = '';
    return;
  }

  const hasDark = Boolean(themeDarkCssText && themeDarkCssText.trim().length > 0);
  const hasLight = Boolean(themeLightCssText && themeLightCssText.trim().length > 0);

  if (darkMode && hasDark) {
    userCssPath = themeDarkPath;
    userCssText = themeDarkCssText;
    return;
  }

  if (hasLight) {
    userCssPath = themeLightPath;
    userCssText = themeLightCssText;
    return;
  }

  userCssPath = themeDarkPath;
  userCssText = themeDarkCssText;
}

async function applyThemeVariantForMode() {
  setActiveThemeFromMode();
  await updateFrameCss();
  const split = splitFrontMatter(markdownState);
  patchFrameHtml(md.render(split.body, { bodyLineOffset: split.bodyLineOffset || 0 }));
  scheduleFrameMermaidRender();
  applyFrameTheme();
  applyFormattedZoom();
  updateMenuChecks();
  notifyNativeMenuState();
}

function patchFrameHtml(html) {
  const doc = frame.contentDocument;
  if (!doc) return;

  const nextHtml = String(html || '').trim().length > 0
    ? html
    : '<div class="preview-empty-state" contenteditable="false"><div><strong>Preview appears here</strong><span>Start writing Markdown in the editor to see it rendered.</span></div></div>';
  const bodyElement = doc.body;
  const tempBody = doc.createElement('body');
  tempBody.setAttribute('contenteditable', 'true');
  tempBody.className = doc.body.className;
  tempBody.innerHTML = nextHtml;

  morphdom(bodyElement, tempBody, {
    childrenOnly: true,
    onBeforeElUpdated: (fromEl) => {
      if (fromEl === doc.body) return true;
      if (fromEl === doc.activeElement && fromEl.isContentEditable) return false;
      return true;
    }
  });
  invalidatePreviewAnchorCache();
  updateThemeDebug();
}

async function renderMermaidBlocksInDocument(doc, options = {}) {
  if (!doc) return;
  const blocks = [...doc.querySelectorAll('[data-mermaid-block]')];
  if (!options.forExport && !mermaidPreviewEnabled) {
    mermaidError = 'preview-disabled';
    for (const block of blocks) {
      const sourcePre = block.querySelector('[data-mermaid-source]');
      const renderTarget = block.querySelector('[data-mermaid-render]');
      if (sourcePre) {
        sourcePre.removeAttribute('hidden');
        sourcePre.setAttribute('aria-hidden', 'false');
        sourcePre.style.removeProperty('display');
      }
      if (renderTarget) {
        renderTarget.innerHTML = '';
      }
      block.classList.remove('mermaid-ready', 'mermaid-error');
    }
    diagnosticLog('mermaid.render.skip', { reason: 'preview-disabled', export: false });
    invalidatePreviewAnchorCache();
    return;
  }
  if (blocks.length === 0) {
    if (options.forExport) diagnosticLog('mermaid.render.skip', { reason: 'no-blocks', export: true });
    return;
  }
  diagnosticLog('mermaid.render.start', { blocks: blocks.length, export: Boolean(options.forExport) });

  const api = await loadMermaidApi();
  if (!api) return;

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const sourcePre = block.querySelector('[data-mermaid-source]');
    if (sourcePre) {
      sourcePre.setAttribute('hidden', 'hidden');
      sourcePre.setAttribute('aria-hidden', 'true');
      sourcePre.style.setProperty('display', 'none', 'important');
    }
    const source = block.querySelector('[data-mermaid-source] code')?.textContent || '';
    const renderTarget = block.querySelector('[data-mermaid-render]');
    if (!renderTarget || !source.trim()) continue;

    try {
      diagnosticLog('mermaid.block.render.start', { blockIndex: index, export: Boolean(options.forExport) });
      const rendered = await renderMermaidWithFallback(source, api.backend, {
        darkMode: options.forExport ? false : darkMode
      });
      if (rendered?.ok && typeof rendered.svg === 'string') {
        renderTarget.innerHTML = rendered.svg;
        block.classList.add('mermaid-ready');
        block.classList.remove('mermaid-error');
        mermaidError = '';
        diagnosticLog('mermaid.block.render.done', { blockIndex: index, export: Boolean(options.forExport) });
      } else {
        mermaidError = String(rendered?.error || 'render failed');
        block.classList.remove('mermaid-ready');
        block.classList.add('mermaid-error');
        renderTarget.innerHTML = `<div class="mermaid-error">Unable to render Mermaid diagram.</div>`;
        diagnosticLog('mermaid.render.error', {
          error: mermaidError,
          blockIndex: index,
          export: Boolean(options.forExport)
        });
        if (options.forExport) {
          renderTarget.innerHTML = '';
        }
      }
    } catch (error) {
      mermaidError = String(error?.message || error || 'render failed');
      diagnosticLog('mermaid.render.error', {
        error: mermaidError,
        blockIndex: index,
        export: Boolean(options.forExport)
      });
      block.classList.remove('mermaid-ready');
      block.classList.add('mermaid-error');
      renderTarget.innerHTML = `<div class="mermaid-error">Unable to render Mermaid diagram.</div>`;
      if (options.forExport) {
        renderTarget.innerHTML = '';
      }
    }
  }
  diagnosticLog('mermaid.render.done', { blocks: blocks.length, export: Boolean(options.forExport) });
  if (!options.forExport) invalidatePreviewAnchorCache();
}

function scheduleFrameMermaidRender() {
  if (!MERMAID_ENABLED) return;
  if (!mermaidPreviewEnabled) return;
  const version = ++mermaidRenderVersion;
  setTimeout(() => {
    void (async () => {
      if (version !== mermaidRenderVersion) return;
      const doc = frame.contentDocument;
      if (!doc) return;
      try {
        await renderMermaidBlocksInDocument(doc);
      } catch (error) {
        mermaidError = String(error?.message || error || 'render scheduling failed');
        diagnosticLog('mermaid.schedule.error', { error: mermaidError });
      }
      updateThemeDebug();
    })();
  }, 0);
}

async function renderMarkdownForExport(markdown) {
  const split = splitFrontMatter(markdown);
  let html = '';
  renderingForExport = true;
  try {
    html = md.render(split.body, { bodyLineOffset: split.bodyLineOffset || 0 });
  } finally {
    renderingForExport = false;
  }
  if (!MERMAID_ENABLED) return html;
  if (!html.includes('data-mermaid-block')) return html;
  const exportDoc = document.implementation.createHTMLDocument('export');
  exportDoc.body.innerHTML = html;
  await renderMermaidBlocksInDocument(exportDoc, { forExport: true });
  return exportDoc.body.innerHTML;
}

function scheduleFormattedNormalization() {
  if (formattedNormalizeTimer) {
    clearTimeout(formattedNormalizeTimer);
  }
  formattedNormalizeTimer = setTimeout(() => {
    const doc = frame.contentDocument;
    if (!doc) return;
    const split = splitFrontMatter(markdownState);
    patchFrameHtml(md.render(split.body, { bodyLineOffset: split.bodyLineOffset || 0 }));
    scheduleFrameMermaidRender();
    applyFrameTheme();
    applyFormattedZoom();
  }, 120);
}

function renderFromMarkdown(source) {
  markdownState = source;
  const split = splitFrontMatter(markdownState);
  const html = md.render(split.body, { bodyLineOffset: split.bodyLineOffset || 0 });

  if (html !== lastRenderedHtml) {
    if (!suppressRawHandler && document.activeElement !== rawEditor) {
      suppressRawHandler = true;
      rawEditor.value = markdownState;
      updateLineNumbers({ force: true });
      suppressRawHandler = false;
      syncRawSnapshot();
    }

    if (!suppressFrameHandler) {
      patchFrameHtml(html);
      applyFormattedZoom();
      scheduleFrameMermaidRender();
    }

    lastRenderedHtml = html;
  }

  updateOutline();
  updateStatusBar();
}

function invalidatePreviewAnchorCache() {
  previewAnchorCache = null;
}

function getPreviewLineAnchors() {
  const doc = frame.contentDocument;
  if (!doc) return null;
  const scrollEl = doc.scrollingElement || doc.documentElement || doc.body;
  if (!scrollEl) return null;

  if (
    previewAnchorCache
    && previewAnchorCache.doc === doc
    && previewAnchorCache.scrollHeight === scrollEl.scrollHeight
    && previewAnchorCache.clientHeight === scrollEl.clientHeight
  ) {
    return previewAnchorCache;
  }

  const anchors = [...doc.querySelectorAll('[data-line]')]
    .map((node) => ({
      line: Number(node.getAttribute('data-line') || 0),
      top: node.getBoundingClientRect().top + scrollEl.scrollTop
    }))
    .filter((item) => Number.isFinite(item.line))
    .sort((a, b) => a.line - b.line);

  previewAnchorCache = {
    doc,
    scrollHeight: scrollEl.scrollHeight,
    clientHeight: scrollEl.clientHeight,
    anchors
  };
  return previewAnchorCache;
}

function shouldUseRatioScrollSync(anchors) {
  if (!Array.isArray(anchors) || anchors.length < 2) return true;
  const uniqueLines = new Set(anchors.map((anchor) => anchor.line)).size;
  return uniqueLines < (anchors.length * 0.65);
}

function syncPreviewScrollWithRaw() {
  if (!syncViewsEnabled) return;
  if (!showRaw || !showFormatted) return;
  if (!frame.contentDocument || !frame.contentWindow) return;

  const doc = frame.contentDocument;
  const scrollEl = doc.scrollingElement || doc.documentElement || doc.body;
  const anchorCache = getPreviewLineAnchors();
  const anchors = anchorCache?.anchors || [];

  let nextPreviewTop = null;
  const rawMax = Math.max(1, rawEditor.scrollHeight - rawEditor.clientHeight);
  const rawRatio = rawEditor.scrollTop / rawMax;
  const useRatioSync = shouldUseRatioScrollSync(anchors);

  if (useRatioSync) {
    const previewMax = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    nextPreviewTop = Math.round(previewMax * rawRatio);
  } else {
    if (anchors.length > 0) {
      const rawPosition = rawLinePositionFromScrollTop(rawEditor.scrollTop);
      const rawVisibleLine = rawPosition.line;
      let anchorIndex = 0;
      for (let i = 0; i < anchors.length; i += 1) {
        if (anchors[i].line <= rawVisibleLine) anchorIndex = i;
        else break;
      }
      const active = anchors[anchorIndex];
      const next = anchors[Math.min(anchorIndex + 1, anchors.length - 1)];
      const startLine = active.line;
      const endLine = Math.max(startLine + 1, next.line || (startLine + 1));
      const lineProgress = Math.max(0, Math.min(1, (rawVisibleLine - startLine) / (endLine - startLine)));

      const activeTop = active.top;
      const nextTop = next
        ? next.top
        : Math.max(activeTop + 1, scrollEl.scrollHeight - scrollEl.clientHeight);
      const blockHeight = Math.max(1, nextTop - activeTop);
      const combinedProgress = Math.max(0, Math.min(1, lineProgress + ((1 / Math.max(1, endLine - startLine)) * rawPosition.progress)));
      nextPreviewTop = Math.round(activeTop + (blockHeight * combinedProgress));
    }
  }

  if (nextPreviewTop === null) {
    const previewMax = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    nextPreviewTop = Math.round(previewMax * rawRatio);
  }
  activeScrollSyncSource = 'raw';
  frame.contentWindow.scrollTo(0, nextPreviewTop);
  requestAnimationFrame(() => {
    if (activeScrollSyncSource === 'raw') activeScrollSyncSource = null;
  });
}

function syncRawScrollWithPreview() {
  if (!syncViewsEnabled) return;
  if (!showRaw || !showFormatted) return;
  if (!frame.contentDocument) return;

  const doc = frame.contentDocument;
  const scrollEl = doc.scrollingElement || doc.documentElement || doc.body;
  const anchorCache = getPreviewLineAnchors();
  const anchors = anchorCache?.anchors || [];

  let nextRawTop = null;
  const previewMax = Math.max(1, scrollEl.scrollHeight - scrollEl.clientHeight);
  const previewRatio = scrollEl.scrollTop / previewMax;
  const useRatioSync = shouldUseRatioScrollSync(anchors);

  if (useRatioSync) {
    const rawMax = Math.max(0, rawEditor.scrollHeight - rawEditor.clientHeight);
    nextRawTop = Math.round(rawMax * previewRatio);
  } else {
    if (anchors.length > 0) {
      const previewTop = scrollEl.scrollTop;
      let anchorIndex = 0;
      for (let i = 0; i < anchors.length; i += 1) {
        const top = anchors[i].top;
        if (top <= previewTop + 1) anchorIndex = i;
        else break;
      }

      const active = anchors[anchorIndex];
      const next = anchors[Math.min(anchorIndex + 1, anchors.length - 1)];
      const activeTop = active.top;
      const nextTop = next
        ? next.top
        : Math.max(activeTop + 1, scrollEl.scrollHeight - scrollEl.clientHeight);
      const blockHeight = Math.max(1, nextTop - activeTop);
      const blockProgress = Math.max(0, Math.min(1, (previewTop - activeTop) / blockHeight));

      const startLine = active.line;
      const endLine = Math.max(startLine + 1, next.line || (startLine + 1));
      const mappedLine = startLine + ((endLine - startLine) * blockProgress);
      const rawLine = Math.floor(mappedLine);
      nextRawTop = rawScrollTopForLinePosition(rawLine, mappedLine - rawLine);
    }
  }

  if (nextRawTop === null) {
    const rawMax = Math.max(0, rawEditor.scrollHeight - rawEditor.clientHeight);
    nextRawTop = Math.round(rawMax * previewRatio);
  }

  const rawMax = Math.max(0, rawEditor.scrollHeight - rawEditor.clientHeight);
  if (nextRawTop > rawMax) nextRawTop = rawMax;
  if (nextRawTop < 0) nextRawTop = 0;
  activeScrollSyncSource = 'preview';
  rawEditor.scrollTop = nextRawTop;
  requestAnimationFrame(() => {
    if (activeScrollSyncSource === 'preview') activeScrollSyncSource = null;
  });
}

function cursorLineFromRawSelection() {
  const text = rawEditor.value || '';
  const index = rawEditor.selectionStart ?? 0;
  const before = text.slice(0, index);
  return before.split('\n').length - 1;
}

function findPreviewElementForLine(lineNumber) {
  const doc = frame.contentDocument;
  if (!doc) return null;
  const candidates = [...doc.querySelectorAll('[data-line]')];
  if (candidates.length === 0) return null;
  let selected = candidates[0];
  for (const node of candidates) {
    const line = Number(node.getAttribute('data-line') || 0);
    if (line <= lineNumber) selected = node;
    else break;
  }
  return selected;
}

function syncPreviewToRawCursor() {
  if (!syncViewsEnabled || !showRaw || !showFormatted) return;
  if (!frame.contentDocument || !frame.contentWindow) return;
  const line = cursorLineFromRawSelection();
  const target = findPreviewElementForLine(line);
  if (!target) {
    syncPreviewScrollWithRaw();
    return;
  }
  target.scrollIntoView({ block: 'center', inline: 'nearest' });
}

function syncRawToPreviewCursor() {
  if (!syncViewsEnabled || !showRaw || !showFormatted) return;
  const doc = frame.contentDocument;
  if (!doc) return;
  const selection = doc.getSelection();
  const anchor = selection?.anchorNode;
  if (!anchor) return;
  const element = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
  const lineNode = element?.closest?.('[data-line]');
  if (!lineNode) return;
  const line = Number(lineNode.getAttribute('data-line') || 0);
  rawEditor.scrollTop = rawScrollTopForLinePosition(line, 0);
  updateLineNumberScroll();
}

function schedulePreviewScrollSync() {
  if (previewScrollSyncRaf !== null) {
    cancelAnimationFrame(previewScrollSyncRaf);
  }
  previewScrollSyncRaf = requestAnimationFrame(() => {
    previewScrollSyncRaf = null;
    syncPreviewScrollWithRaw();
  });
}

function scheduleRawScrollSync() {
  if (rawScrollSyncRaf !== null) {
    cancelAnimationFrame(rawScrollSyncRaf);
  }
  rawScrollSyncRaf = requestAnimationFrame(() => {
    rawScrollSyncRaf = null;
    syncRawScrollWithPreview();
  });
}

function handleRawEdit() {
  if (suppressRawHandler) return;
  if (!isApplyingRawHistory) {
    rawUndoStack.push(lastRawSnapshot);
    if (rawUndoStack.length > 500) rawUndoStack.shift();
    rawRedoStack.length = 0;
  }
  renderFromMarkdown(rawEditor.value);
  updateLineNumbers();
  syncPreviewToRawCursor();
  lastFindOptionsKey = '';
  activeFindMatchIndex = -1;
  syncRawSnapshot();
  updateDirtyFromState();
  publishSessionState();
}

function handleFormattedEdit() {
  if (suppressFrameHandler || !frame.contentDocument) return;

  const html = frame.contentDocument.body.innerHTML;
  const nextBodyMarkdown = turndown.turndown(html);
  const split = splitFrontMatter(markdownState);
  const nextMarkdown = mergeFrontMatterWithBody(split.block, nextBodyMarkdown);

  if (nextMarkdown === markdownState) return;

  suppressFrameHandler = true;
  renderFromMarkdown(nextMarkdown);
  lastFindOptionsKey = '';
  activeFindMatchIndex = -1;
  suppressFrameHandler = false;

  if (rawEditor.value !== markdownState) {
    suppressRawHandler = true;
    rawEditor.value = markdownState;
    updateLineNumbers({ force: true });
    suppressRawHandler = false;
    syncRawSnapshot();
  }

  updateDirtyFromState();
  scheduleFormattedNormalization();
  publishSessionState();
}

function applyHeadingShortcutInFormatted(event) {
  if (event.key !== ' ' || event.metaKey || event.ctrlKey || event.altKey) return false;
  if (!frame.contentDocument) return false;

  const doc = frame.contentDocument;
  const selection = doc.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return false;

  const range = selection.getRangeAt(0);
  const anchorNode = range.startContainer;
  const element = anchorNode.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode.parentElement;
  const block = element?.closest?.('p,div');
  if (!block) return false;

  const prefixRange = doc.createRange();
  prefixRange.selectNodeContents(block);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  const typedPrefix = prefixRange.toString();

  const headingMatch = typedPrefix.match(/^(#{1,4})$/);
  if (!headingMatch) return false;

  // Only apply shortcut when the block currently contains just the heading marker.
  const blockText = (block.textContent || '').replace(/\u00A0/g, ' ').trim();
  if (blockText !== headingMatch[1]) return false;

  event.preventDefault();
  const headingLevel = headingMatch[1].length;

  block.textContent = '';
  doc.body.focus();
  doc.execCommand('formatBlock', false, `h${headingLevel}`);
  handleFormattedEdit();
  return true;
}

function replaceSelectionInRaw(transform) {
  const text = rawEditor.value;
  const start = rawEditor.selectionStart ?? 0;
  const end = rawEditor.selectionEnd ?? start;
  const selected = text.slice(start, end);

  const result = transform({ text, start, end, selected });
  if (!result) return;

  suppressRawHandler = true;
  rawEditor.value = result.text;
  updateLineNumbers({ force: true });
  rawEditor.setSelectionRange(result.selectionStart, result.selectionEnd);
  rawEditor.focus({ preventScroll: true });
  suppressRawHandler = false;

  renderFromMarkdown(result.text);
  syncRawSnapshot();
  rawRedoStack.length = 0;
  updateDirtyFromState();
}

function wrapSelection(prefix, suffix = prefix, placeholder = 'text') {
  replaceSelectionInRaw(({ text, start, end, selected }) => {
    const content = selected || placeholder;
    const replacement = `${prefix}${content}${suffix}`;
    const nextText = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
    const from = start + prefix.length;
    const to = from + content.length;
    return { text: nextText, selectionStart: from, selectionEnd: to };
  });
}

function prefixSelectedLines(prefixFn) {
  replaceSelectionInRaw(({ text, start, end }) => {
    const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const lineEndIndex = text.indexOf('\n', end);
    const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
    const selectedBlock = text.slice(lineStart, lineEnd);
    const nextBlock = selectedBlock
      .split('\n')
      .map((line, index) => `${prefixFn(line, index)}${line}`)
      .join('\n');
    const nextText = `${text.slice(0, lineStart)}${nextBlock}${text.slice(lineEnd)}`;
    return { text: nextText, selectionStart: lineStart, selectionEnd: lineStart + nextBlock.length };
  });
}

function adjustCurrentLineIndent(increase) {
  replaceSelectionInRaw(({ text, start, end }) => {
    const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const lineEndIndex = text.indexOf('\n', end);
    const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
    const line = text.slice(lineStart, lineEnd);

    const updatedLine = increase
      ? `\t${line}`
      : (line.startsWith('\t') ? line.slice(1) : line);

    if (updatedLine === line) return null;

    const nextText = `${text.slice(0, lineStart)}${updatedLine}${text.slice(lineEnd)}`;
    const delta = updatedLine.length - line.length;
    return {
      text: nextText,
      selectionStart: Math.max(lineStart, start + delta),
      selectionEnd: Math.max(lineStart, end + delta)
    };
  });
}

function applyFormatAction(action) {
  if (lastFocusedEditor === 'formatted' && frame.contentDocument) {
    const doc = frame.contentDocument;
    const commandMap = {
      'format-bold': ['bold'],
      'format-italic': ['italic'],
      'format-list-bullet': ['insertUnorderedList'],
      'format-list-number': ['insertOrderedList'],
      'format-quote': ['formatBlock', 'blockquote'],
      'format-heading-1': ['formatBlock', 'h1'],
      'format-heading-2': ['formatBlock', 'h2'],
      'format-heading-3': ['formatBlock', 'h3'],
      'format-link': ['createLink', 'https://example.com'],
      'format-horizontal-rule': ['insertHorizontalRule'],
      'format-increase-indent': ['indent'],
      'format-decrease-indent': ['outdent']
    };
    const mapped = commandMap[action];
    if (mapped) {
      doc.body.focus();
      doc.execCommand(mapped[0], false, mapped[1]);
      doc.body.focus({ preventScroll: true });
      handleFormattedEdit();
      return;
    }
  }

  switch (action) {
    case 'format-bold':
      wrapSelection('**');
      break;
    case 'format-italic':
      wrapSelection('*');
      break;
    case 'format-inline-code':
      wrapSelection('`');
      break;
    case 'format-highlight':
      wrapSelection('==');
      break;
    case 'format-horizontal-rule':
      replaceSelectionInRaw(({ text, start, end }) => {
        const replacement = '\n---\n';
        const nextText = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
        const caret = start + replacement.length;
        return { text: nextText, selectionStart: caret, selectionEnd: caret };
      });
      break;
    case 'format-increase-indent':
      adjustCurrentLineIndent(true);
      break;
    case 'format-decrease-indent':
      adjustCurrentLineIndent(false);
      break;
    case 'format-link':
      replaceSelectionInRaw(({ text, start, end, selected }) => {
        const label = selected || 'link text';
        const replacement = `[${label}](https://example.com)`;
        const nextText = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
        return { text: nextText, selectionStart: start + 1, selectionEnd: start + 1 + label.length };
      });
      break;
    case 'format-code-block':
      replaceSelectionInRaw(({ text, start, end, selected }) => {
        const content = selected || 'code';
        const replacement = `\n\`\`\`\n${content}\n\`\`\`\n`;
        const nextText = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
        const contentStart = start + 5;
        return { text: nextText, selectionStart: contentStart, selectionEnd: contentStart + content.length };
      });
      break;
    case 'format-heading-1':
      prefixSelectedLines(() => '# ');
      break;
    case 'format-heading-2':
      prefixSelectedLines(() => '## ');
      break;
    case 'format-heading-3':
      prefixSelectedLines(() => '### ');
      break;
    case 'format-list-bullet':
      if (listContinuationMode === 'bullet') {
        setListContinuationMode(null);
      } else {
        prefixSelectedLines(() => '- ');
        setListContinuationMode('bullet');
      }
      break;
    case 'format-list-number':
      if (listContinuationMode === 'number') {
        setListContinuationMode(null);
      } else {
        prefixSelectedLines((_line, index) => `${index + 1}. `);
        setListContinuationMode('number');
      }
      break;
    case 'format-quote':
      prefixSelectedLines(() => '> ');
      break;
    default:
      break;
  }
}

function handleRawListContinuationKeydown(event) {
  if (event.key !== 'Enter') return;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if (!listContinuationMode) return;

  const start = rawEditor.selectionStart ?? 0;
  const end = rawEditor.selectionEnd ?? start;
  const text = rawEditor.value;
  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const lineToCaret = text.slice(lineStart, start);

  let continuation = '';
  if (listContinuationMode === 'bullet') {
    const bulletMatch = lineToCaret.match(/^(\s*)-\s(.*)$/);
    if (bulletMatch) {
      if (bulletMatch[2].trim().length === 0) {
        setListContinuationMode(null);
        continuation = '';
      } else {
        continuation = `${bulletMatch[1]}- `;
      }
    } else {
      continuation = '- ';
    }
  } else if (listContinuationMode === 'number') {
    const numberMatch = lineToCaret.match(/^(\s*)(\d+)\.\s(.*)$/);
    if (numberMatch) {
      if (numberMatch[3].trim().length === 0) {
        setListContinuationMode(null);
        continuation = '';
      } else {
        const nextNumber = Number(numberMatch[2]) + 1;
        continuation = `${numberMatch[1]}${nextNumber}. `;
      }
    } else {
      continuation = '1. ';
    }
  }

  event.preventDefault();
  rawUndoStack.push(lastRawSnapshot);
  if (rawUndoStack.length > 500) rawUndoStack.shift();
  rawRedoStack.length = 0;

  replaceSelectionInRaw(({ text: currentText, start: selStart, end: selEnd }) => {
    const replacement = `\n${continuation}`;
    const nextText = `${currentText.slice(0, selStart)}${replacement}${currentText.slice(selEnd)}`;
    const caret = selStart + replacement.length;
    return { text: nextText, selectionStart: caret, selectionEnd: caret };
  });
}

function runEditCommand(action) {
  if (action === 'edit-select-all') {
    if (lastFocusedEditor === 'formatted' && frame.contentDocument) {
      frame.contentDocument.body.focus();
      frame.contentDocument.execCommand('selectAll');
    } else {
      rawEditor.focus();
      rawEditor.select();
    }
    return;
  }

  const commandMap = {
    'edit-undo': 'undo',
    'edit-redo': 'redo',
    'edit-cut': 'cut',
    'edit-copy': 'copy',
    'edit-paste': 'paste'
  };
  const command = commandMap[action];
  if (!command) return;

  if (lastFocusedEditor === 'formatted' && frame.contentDocument) {
    frame.contentDocument.body.focus();
    frame.contentDocument.execCommand(command);
    if (command !== 'copy') {
      handleFormattedEdit();
    }
    return;
  }

  if (command === 'undo') {
    undoRaw();
    return;
  }

  if (command === 'redo') {
    redoRaw();
    return;
  }

  rawEditor.focus();
  document.execCommand(command);
  if (command !== 'copy') {
    handleRawEdit();
  }
}

function setMarkdownProgrammatically(nextMarkdown, selectionStart = null, selectionEnd = null) {
  suppressRawHandler = true;
  rawEditor.value = nextMarkdown;
  updateLineNumbers({ force: true });
  if (typeof selectionStart === 'number' && typeof selectionEnd === 'number') {
    rawEditor.setSelectionRange(selectionStart, selectionEnd);
  }
  rawEditor.focus({ preventScroll: true });
  suppressRawHandler = false;

  renderFromMarkdown(nextMarkdown);
  lastFindOptionsKey = '';
  activeFindMatchIndex = -1;
  syncRawSnapshot();
  updateDirtyFromState();
  publishSessionState();
}

function sanitizeFileStem(value) {
  return String(value || 'image')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'image';
}

function extensionFromMime(mime) {
  const type = String(mime || '').toLowerCase();
  if (type.includes('png')) return '.png';
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
  if (type.includes('gif')) return '.gif';
  if (type.includes('webp')) return '.webp';
  if (type.includes('svg')) return '.svg';
  return '.png';
}

async function resolveImageSaveDir() {
  if (currentFilePath) {
    const baseName = path.basename(currentFilePath, path.extname(currentFilePath));
    return path.join(path.dirname(currentFilePath), `${baseName}_assets`);
  }
  return path.join(os.homedir(), 'Pictures', 'Monospire Uploads');
}

function insertMarkdownAtCursor(insertText) {
  const start = rawEditor.selectionStart ?? 0;
  const end = rawEditor.selectionEnd ?? start;
  const text = rawEditor.value || '';
  const next = `${text.slice(0, start)}${insertText}${text.slice(end)}`;
  const nextPos = start + insertText.length;
  rawUndoStack.push(captureRawSnapshot());
  if (rawUndoStack.length > 500) rawUndoStack.shift();
  rawRedoStack.length = 0;
  setMarkdownProgrammatically(next, nextPos, nextPos);
}

async function importImageFile(file) {
  if (!file) return null;
  const name = file.name || 'image';
  const stem = sanitizeFileStem(name);
  const ext = path.extname(name) || extensionFromMime(file.type);
  const imageDir = await resolveImageSaveDir();
  await fs.mkdir(imageDir, { recursive: true });

  const now = new Date();
  const timestamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  const targetPath = path.join(imageDir, `${stem}-${timestamp}${ext}`);

  if (file.path && fsSync.existsSync(file.path)) {
    await fs.copyFile(file.path, targetPath);
  } else {
    const bytes = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(targetPath, bytes);
  }

  let linkPath;
  if (currentFilePath) {
    linkPath = path.relative(path.dirname(currentFilePath), targetPath).split(path.sep).join('/');
  } else {
    linkPath = pathToFileURL(targetPath).href;
  }
  return `![${stem}](${encodeURI(linkPath)})`;
}

async function importImagesAndInsert(files) {
  const imageFiles = (Array.isArray(files) ? files : []).filter((file) => file && String(file.type || '').startsWith('image/'));
  if (imageFiles.length === 0) return;
  const markdownLines = [];
  for (const file of imageFiles) {
    // eslint-disable-next-line no-await-in-loop
    const line = await importImageFile(file);
    if (line) markdownLines.push(line);
  }
  if (markdownLines.length === 0) return;
  const insertion = `${markdownLines.join('\n')}\n`;
  insertMarkdownAtCursor(insertion);
}

function extractMarkdownLinks(source) {
  const links = [];
  const text = String(source || '');
  const regex = /!?\[[^\]]*]\(([^)\n]+)\)|<((?:https?:\/\/|mailto:|file:\/\/)[^>\s]+)>|href\s*=\s*"([^"]+)"|src\s*=\s*"([^"]+)"/gi;
  let match = regex.exec(text);
  while (match) {
    const raw = (match[1] || match[2] || match[3] || match[4] || '').trim();
    if (raw) {
      const line = text.slice(0, match.index).split('\n').length;
      const firstToken = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw.split(/\s+/)[0];
      links.push({ url: firstToken, line });
    }
    match = regex.exec(text);
  }
  return links;
}

function localLinkStatus(url) {
  if (!url || url.startsWith('#') || url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('data:')) {
    return { kind: 'skip', ok: true, message: 'Skipped' };
  }
  try {
    if (url.startsWith('http://') || url.startsWith('https://')) return { kind: 'remote' };
    let localPath = url;
    if (localPath.startsWith('file://')) {
      localPath = decodeURIComponent(new URL(localPath).pathname);
    } else {
      localPath = decodeURIComponent(localPath.split('#')[0].split('?')[0]);
      const base = currentFilePath ? path.dirname(currentFilePath) : process.cwd();
      localPath = path.resolve(base, localPath);
    }
    const exists = fsSync.existsSync(localPath);
    return exists
      ? { kind: 'local', ok: true, message: 'OK' }
      : { kind: 'local', ok: false, message: 'Missing local file' };
  } catch {
    return { kind: 'local', ok: false, message: 'Invalid local path' };
  }
}

function renderLinkCheckResults(results) {
  if (!linkCheckList || !linkCheckSummary) return;
  const total = results.length;
  const bad = results.filter((item) => item.ok === false).length;
  linkCheckSummary.textContent = bad === 0 ? `Checked ${total} link(s): no issues found.` : `Checked ${total} link(s): ${bad} issue(s) found.`;
  linkCheckList.innerHTML = '';
  for (const item of results) {
    const row = document.createElement('div');
    row.className = `link-check-item ${item.ok ? 'good' : 'bad'}`;
    const status = item.ok ? 'OK' : 'Issue';
    const line1 = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = status;
    line1.appendChild(strong);
    line1.appendChild(document.createTextNode(` - ${item.url}`));
    const line2 = document.createElement('div');
    line2.className = 'link-line';
    line2.textContent = `Line ${item.line}${item.message ? ` - ${item.message}` : ''}`;
    row.appendChild(line1);
    row.appendChild(line2);
    linkCheckList.appendChild(row);
  }
}

function openLinkCheckModal() {
  if (linkCheckModal) linkCheckModal.classList.remove('hidden');
}

function closeLinkCheckModal() {
  if (linkCheckModal) linkCheckModal.classList.add('hidden');
}

async function runLinkCheck() {
  const discovered = extractMarkdownLinks(markdownState);
  if (discovered.length === 0) {
    renderLinkCheckResults([]);
    openLinkCheckModal();
    return;
  }

  const localResults = [];
  const remoteUrls = [];
  for (const link of discovered) {
    const status = localLinkStatus(link.url);
    if (status.kind === 'remote') {
      remoteUrls.push(link.url);
      localResults.push({
        url: link.url,
        line: link.line,
        ok: null,
        message: 'Checking remote URL...'
      });
    } else {
      localResults.push({
        url: link.url,
        line: link.line,
        ok: status.ok,
        message: status.message
      });
    }
  }

  const remoteResponse = await window.nativeApi.checkLinks({ urls: remoteUrls });
  const remoteMap = new Map((remoteResponse?.results || []).map((item) => [item.url, item]));
  const finalResults = localResults.map((entry) => {
    if (entry.ok !== null) return entry;
    const checked = remoteMap.get(entry.url);
    if (!checked) return { ...entry, ok: false, message: 'No response' };
    if (checked.ok) return { ...entry, ok: true, message: `HTTP ${checked.status}` };
    return { ...entry, ok: false, message: checked.error ? checked.error : `HTTP ${checked.status}` };
  });
  renderLinkCheckResults(finalResults);
  openLinkCheckModal();
}

function buildFindRegex(query, options) {
  if (!query) return null;
  const regexEnabled = options?.regex === true;
  const caseSensitive = options?.caseSensitive === true;
  const wholeWord = options?.wholeWord === true;

  const base = regexEnabled ? query : escapeRegex(query);
  const source = wholeWord ? `\\b(?:${base})\\b` : base;
  const flags = caseSensitive ? 'g' : 'gi';
  return new RegExp(source, flags);
}

function getFindOptions() {
  return {
    regex: Boolean(findRegex?.checked),
    caseSensitive: Boolean(findCase?.checked),
    wholeWord: Boolean(findWord?.checked)
  };
}

function updateFindStatus(message) {
  if (findReplaceStatus) findReplaceStatus.textContent = message;
}

function collectFindMatches(query, options) {
  const text = rawEditor.value || '';
  const pattern = buildFindRegex(query, options);
  if (!pattern) return [];

  const matches = [];
  let match = pattern.exec(text);
  while (match) {
    const start = match.index;
    const value = match[0] || '';
    const end = start + value.length;
    if (end > start) {
      matches.push({ start, end, value });
    } else {
      pattern.lastIndex += 1;
    }
    match = pattern.exec(text);
  }
  return matches;
}

function findOptionsKey(query, options) {
  return JSON.stringify({
    query,
    regex: options.regex,
    case: options.caseSensitive,
    word: options.wholeWord
  });
}

function selectFindMatch(match, index, total) {
  if (!match) return;
  rawEditor.focus({ preventScroll: true });
  rawEditor.setSelectionRange(match.start, match.end);
  const text = rawEditor.value || '';
  rawEditor.scrollTop = rawEditor.scrollHeight * (match.start / Math.max(1, text.length));
  updateFindStatus(`Match ${index + 1} of ${total}`);
}

function refreshFindMatches(force = false) {
  const query = findInput?.value || '';
  const options = getFindOptions();
  const key = findOptionsKey(query, options);
  if (!force && key === lastFindOptionsKey) return findMatches;
  lastFindOptionsKey = key;
  try {
    findMatches = collectFindMatches(query, options);
  } catch (error) {
    findMatches = [];
    updateFindStatus(`Regex error: ${String(error?.message || error)}`);
  }
  activeFindMatchIndex = -1;
  return findMatches;
}

function openFindReplaceDialog(withReplace = false) {
  if (!findReplaceModal || !findInput || !replaceInput) return;
  findReplaceModal.classList.remove('hidden');
  if (!findInput.value && lastFindQuery) findInput.value = lastFindQuery;
  refreshFindMatches(true);
  updateFindStatus('Ready');
  if (withReplace) {
    replaceInput.focus();
    replaceInput.select();
  } else {
    findInput.focus();
    findInput.select();
  }
}

function closeFindReplaceDialog() {
  if (!findReplaceModal) return;
  findReplaceModal.classList.add('hidden');
}

function runFindNext() {
  const query = findInput?.value || '';
  if (!query) {
    updateFindStatus('Enter text to find.');
    return false;
  }
  lastFindQuery = query;
  const matches = refreshFindMatches();
  if (matches.length === 0) {
    updateFindStatus(`No matches for "${query}".`);
    return false;
  }

  const selectionEnd = rawEditor.selectionEnd ?? 0;
  let nextIndex = matches.findIndex((item) => item.start >= selectionEnd);
  if (nextIndex === -1) nextIndex = 0;
  if (activeFindMatchIndex >= 0 && matches[activeFindMatchIndex]?.start === selectionEnd) {
    nextIndex = (activeFindMatchIndex + 1) % matches.length;
  }
  activeFindMatchIndex = nextIndex;
  selectFindMatch(matches[nextIndex], nextIndex, matches.length);
  return true;
}

function replaceCurrentSelection(replacement) {
  const start = rawEditor.selectionStart ?? 0;
  const end = rawEditor.selectionEnd ?? start;
  const text = rawEditor.value || '';
  const nextText = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
  rawUndoStack.push(captureRawSnapshot());
  if (rawUndoStack.length > 500) rawUndoStack.shift();
  rawRedoStack.length = 0;
  setMarkdownProgrammatically(nextText, start, start + replacement.length);
}

function runReplaceNext() {
  const query = findInput?.value || '';
  const replacement = replaceInput?.value || '';
  if (!query) {
    updateFindStatus('Enter text to find.');
    return;
  }

  const options = getFindOptions();
  const pattern = buildFindRegex(query, options);
  if (!pattern) return;

  const selected = rawEditor.value.slice(rawEditor.selectionStart ?? 0, rawEditor.selectionEnd ?? 0);
  const isCurrentMatch = selected.length > 0 && selected.match(new RegExp(`^(?:${pattern.source})$`, options.caseSensitive ? '' : 'i'));
  if (!isCurrentMatch && !runFindNext()) return;

  const selectionText = rawEditor.value.slice(rawEditor.selectionStart ?? 0, rawEditor.selectionEnd ?? 0);
  let replaced = replacement;
  if (options.regex) {
    replaced = selectionText.replace(buildFindRegex(query, options.caseSensitive ? { regex: true, caseSensitive: true, wholeWord: options.wholeWord } : options), replacement);
  }
  replaceCurrentSelection(replaced);
  refreshFindMatches(true);
  runFindNext();
}

function runReplaceAll() {
  const query = findInput?.value || '';
  const replacement = replaceInput?.value || '';
  if (!query) {
    updateFindStatus('Enter text to find.');
    return;
  }

  const options = getFindOptions();
  let pattern;
  try {
    pattern = buildFindRegex(query, options);
  } catch (error) {
    updateFindStatus(`Regex error: ${String(error?.message || error)}`);
    return;
  }
  if (!pattern) return;

  const source = rawEditor.value || '';
  const matches = source.match(pattern);
  const count = matches ? matches.length : 0;
  if (count === 0) {
    updateFindStatus(`No matches for "${query}".`);
    return;
  }

  const nextText = source.replace(pattern, replacement);
  rawUndoStack.push(captureRawSnapshot());
  if (rawUndoStack.length > 500) rawUndoStack.shift();
  rawRedoStack.length = 0;
  setMarkdownProgrammatically(nextText);
  refreshFindMatches(true);
  updateFindStatus(`Replaced ${count} occurrence${count === 1 ? '' : 's'}.`);
}

function runFindDialog() {
  openFindReplaceDialog(false);
}

function runReplaceDialog() {
  openFindReplaceDialog(true);
}

function applyLoadedDocument(loaded) {
  currentFilePath = loaded.path;
  currentFileName = loaded.name || basename(loaded.path);
  docSessionKey = loaded.path || docSessionKey;
  markdownState = loaded.content;
  lastSavedAt = loaded.lastSavedAt || null;
  rawEditor.value = markdownState;
  updateLineNumbers({ force: true });

  renderFromMarkdown(markdownState);
  savedBaseline = markdownState;
  rawUndoStack.length = 0;
  rawRedoStack.length = 0;
  syncRawSnapshot();
  setDirty(false);
  updateWindowTitle();
  publishSessionState();
}

async function loadFileFromDisk() {
  const canProceed = await confirmUnsavedChanges('loading another file');
  if (!canProceed) return;

  const loaded = await window.nativeApi.openFile();
  if (!loaded) return;

  applyLoadedDocument(loaded);
  await addRecentFile(loaded.path);
}

async function loadRecentFile(filePath) {
  const canProceed = await confirmUnsavedChanges('opening a recent file');
  if (!canProceed) return;

  const loaded = await window.nativeApi.openFilePath({ path: filePath });
  if (!loaded) {
    window.alert('Unable to open the selected recent file.');
    await refreshRecentFilesMenu();
    return;
  }

  applyLoadedDocument(loaded);
  await addRecentFile(loaded.path);
}

async function loadFileByPath(filePath, context = 'opening a file') {
  if (!filePath) return;
  const canProceed = await confirmUnsavedChanges(context);
  if (!canProceed) return;

  const loaded = await window.nativeApi.openFilePath({ path: filePath });
  if (!loaded) {
    window.alert('Unable to open the selected file.');
    await refreshRecentFilesMenu();
    return;
  }

  applyLoadedDocument(loaded);
  await addRecentFile(loaded.path);
}

async function createNewDocument(options = {}) {
  const initialContent = options?.initialContent ?? '';
  const markDirty = Boolean(options?.markDirty);
  const canProceed = await confirmUnsavedChanges('creating a new document');
  if (!canProceed) return;

  currentFilePath = null;
  currentFileName = 'Untitled.md';
  docSessionKey = `untitled-${Math.random().toString(36).slice(2, 10)}`;
  markdownState = initialContent;
  lastSavedAt = null;
  rawEditor.value = markdownState;
  updateLineNumbers({ force: true });
  renderFromMarkdown(markdownState);
  savedBaseline = markDirty ? '' : markdownState;
  rawUndoStack.length = 0;
  rawRedoStack.length = 0;
  syncRawSnapshot();
  updateDirtyFromState();
  updateWindowTitle();
  publishSessionState();
}

async function createNewDocumentFromTemplate() {
  const template = await window.nativeApi.chooseTemplateFile();
  if (!template?.path) return;
  const templateContent = applyTemplateTokens(template.content || '');
  await createNewDocument({
    initialContent: templateContent,
    markDirty: templateContent.length > 0
  });
}

async function setDefaultTemplate() {
  const template = await window.nativeApi.chooseTemplateFile();
  if (!template?.path) return;
  await window.nativeApi.saveDefaultTemplatePreference({ path: template.path });
  defaultTemplatePath = template.path;
  const name = template.name || basename(template.path);
  window.alert(`Default template set to "${name}".`);
}

async function resetDefaultTemplate() {
  await window.nativeApi.saveDefaultTemplatePreference({ path: null });
  defaultTemplatePath = null;
  window.alert('Default template has been reset.');
}

async function loadDefaultTemplate() {
  const saved = await window.nativeApi.loadDefaultTemplatePreference();
  if (!saved?.loaded) {
    defaultTemplatePath = null;
    if (saved?.invalidPath) {
      await window.nativeApi.showTemplateLoadErrorDialog({ path: saved.invalidPath });
    }
    return null;
  }

  defaultTemplatePath = saved.path || null;
  return saved;
}

async function saveCurrentFile(saveAs = false, options = {}) {
  const fromAutosave = options?.fromAutosave === true;
  if (!saveAs && currentFilePath && isExportOnlyExtension(currentFilePath)) {
    if (fromAutosave) {
      diagnosticLog('save.skip.export-only-path.autosave', { path: currentFilePath });
      return false;
    }
    // Avoid implicit re-export side effects (for example, launching Pages automation).
    return saveCurrentFile(true, options);
  }

  const renderedHtml = await renderMarkdownForExport(markdownState);
  const payload = {
    path: currentFilePath,
    content: markdownState,
    renderedHtml,
    themeCssText: buildExportThemeCss(),
    darkMode: false,
    exportPresets: {
      html: exportHtmlPreset,
      pdf: exportPdfPreset,
      docx: exportDocxPreset,
      pages: exportPagesPreset
    }
  };

  const result = saveAs ? await window.nativeApi.saveFileAs(payload) : await window.nativeApi.saveFile(payload);

  if (result?.requiresPath) {
    return saveCurrentFile(true);
  }

  if (!result?.saved) {
    if (result?.error) {
      window.alert(`Save failed: ${result.error}`);
    }
    return false;
  }

  currentFilePath = result.path;
  currentFileName = result.name || basename(result.path);
  docSessionKey = currentFilePath || docSessionKey;
  lastSavedAt = result.savedAt || new Date().toISOString();
  savedBaseline = markdownState;
  setDirty(false);
  updateWindowTitle();
  updateStatusBar();
  await addRecentFile(currentFilePath);
  await maybeSnapshot('manual');
  publishSessionState();
  return true;
}

async function exportToPages() {
  const renderedHtml = await renderMarkdownForExport(markdownState);
  const payload = {
    path: currentFilePath,
    content: markdownState,
    renderedHtml,
    themeCssText: buildExportThemeCss(),
    darkMode: false,
    exportPresets: {
      html: exportHtmlPreset,
      pdf: exportPdfPreset,
      docx: exportDocxPreset,
      pages: exportPagesPreset
    }
  };
  const result = await window.nativeApi.exportToPages(payload);
  if (!result?.saved) {
    if (result?.error) window.alert(`Export to Pages failed: ${result.error}`);
    return false;
  }
  return true;
}

async function loadThemeCss() {
  try {
    diagnosticLog('theme.load.request');
    const theme = await window.nativeApi.chooseCssTheme();
    if (!theme?.path) {
      diagnosticLog('theme.load.cancelled');
      return;
    }

    const persistPath = await applySelectedTheme(theme.path, theme.cssText || '');
    await window.nativeApi.saveThemePreference({ path: persistPath });
    diagnosticLog('theme.load.applied', { path: persistPath, darkPair: Boolean(themeDarkCssText) });
  } catch (error) {
    const message = String(error?.message || error || 'Theme load failed');
    diagnosticLog('theme.load.error', { error: message });
    window.alert(`Load Theme failed: ${message}`);
  }
}

async function applySelectedTheme(selectedPath, selectedCssText) {
  if (!selectedPath) {
    themeLightPath = null;
    themeDarkPath = null;
    themeLightCssText = '';
    themeDarkCssText = '';
    userCssPath = null;
    userCssText = '';
    await applyThemeVariantForMode();
    return null;
  }

  const pair = deriveThemePairPaths(selectedPath);
  const selectedIsDark = selectedPath.toLowerCase().endsWith('-dark.css');

  themeLightPath = pair.lightPath;
  themeDarkPath = pair.darkPath;
  themeLightCssText = selectedIsDark ? '' : (selectedCssText || '');
  themeDarkCssText = selectedIsDark ? (selectedCssText || '') : '';

  if (themeDarkPath && !selectedIsDark) {
    const darkCss = await window.nativeApi.readCssFile(themeDarkPath);
    if (darkCss && darkCss.trim().length > 0) themeDarkCssText = darkCss;
  }

  if (themeLightPath && selectedIsDark) {
    const lightCss = await window.nativeApi.readCssFile(themeLightPath);
    if (lightCss && lightCss.trim().length > 0) themeLightCssText = lightCss;
  }

  const persistPath = themeLightCssText && themeLightCssText.trim().length > 0 ? (themeLightPath || selectedPath) : selectedPath;
  await applyThemeVariantForMode();
  return persistPath;
}

async function loadBundledThemeCss(fileName) {
  try {
    diagnosticLog('theme.bundled.request', { fileName });
    const theme = await window.nativeApi.loadBundledTheme({ fileName });
    if (!theme?.loaded) {
      const message = theme?.error || 'Bundled theme not found.';
      diagnosticLog('theme.bundled.error', { fileName, error: message });
      window.alert(`Load Theme failed: ${message}`);
      return;
    }
    const persistPath = await applySelectedTheme(theme.path || null, theme.cssText || '');
    await window.nativeApi.saveThemePreference({ path: persistPath });
    diagnosticLog('theme.bundled.applied', { fileName, path: persistPath, darkPair: Boolean(themeDarkCssText) });
  } catch (error) {
    const message = String(error?.message || error || 'Bundled theme load failed');
    diagnosticLog('theme.bundled.error', { fileName, error: message });
    window.alert(`Load Theme failed: ${message}`);
  }
}

async function loadSavedThemeOnStartup() {
  const saved = await window.nativeApi.loadThemePreference();
  if (!saved?.loaded) {
    themeLightPath = null;
    themeDarkPath = null;
    themeLightCssText = '';
    themeDarkCssText = '';
    userCssPath = null;
    userCssText = '';
    await updateFrameCss();
    updateMenuChecks();
    notifyNativeMenuState();
    if (saved?.invalidPath) {
      await window.nativeApi.showThemeLoadErrorDialog({ path: saved.invalidPath });
    }
    return;
  }

  const pair = deriveThemePairPaths(saved.path);
  themeLightPath = pair.lightPath;
  themeDarkPath = pair.darkPath;
  themeLightCssText = saved.cssText || '';
  themeDarkCssText = '';

  if (themeDarkPath) {
    const darkCss = await window.nativeApi.readCssFile(themeDarkPath);
    if (darkCss && darkCss.trim().length > 0) themeDarkCssText = darkCss;
  }

  await applyThemeVariantForMode();
}

function closeAllMenus() {
  for (const group of menuGroups) {
    group.classList.remove('open');
  }
}

async function confirmUnsavedChanges(context) {
  if (!isDirty) return true;

  const choice = await window.nativeApi.showUnsavedDialog({ context });
  if (choice === 'discard') return true;
  if (choice === 'cancel') return false;
  if (choice === 'save') {
    const saved = await saveCurrentFile(false);
    return Boolean(saved);
  }
  return false;
}

async function handleAction(action, payload = {}) {
  switch (action) {
    case 'file-new':
      {
        const defaultTemplate = await loadDefaultTemplate();
        if (defaultTemplate?.loaded) {
          const templateContent = applyTemplateTokens(defaultTemplate.content || '');
          await createNewDocument({
            initialContent: templateContent,
            markDirty: templateContent.length > 0
          });
        } else {
          await createNewDocument();
        }
      }
      break;
    case 'file-new-from-template':
      await createNewDocumentFromTemplate();
      break;
    case 'file-set-default-template':
      await setDefaultTemplate();
      break;
    case 'file-reset-default-template':
      await resetDefaultTemplate();
      break;
    case 'file-new-window':
      window.nativeApi.newWindow();
      break;
    case 'file-load':
      await loadFileFromDisk();
      break;
    case 'file-open-recent':
      if (payload.path) {
        await loadRecentFile(payload.path);
      }
      break;
    case 'file-open-path':
      if (payload.path) {
        await loadFileByPath(payload.path, 'opening a file');
      }
      break;
    case 'file-clear-recent':
      await clearRecentFilesMenu();
      break;
    case 'file-save':
      await saveCurrentFile(false);
      break;
    case 'file-save-as':
      await saveCurrentFile(true);
      break;
    case 'file-export-pages':
      await exportToPages();
      break;
    case 'app-exit':
      window.nativeApi.quitApp();
      break;
    case 'request-close': {
      const canClose = await confirmUnsavedChanges('closing this file');
      if (canClose) {
        await window.nativeApi.confirmCloseWindow();
      }
      break;
    }
    case 'edit-undo':
    case 'edit-redo':
    case 'edit-cut':
    case 'edit-copy':
    case 'edit-paste':
    case 'edit-select-all':
      runEditCommand(action);
      break;
    case 'edit-find':
      runFindDialog();
      break;
    case 'edit-replace':
      runReplaceDialog();
      break;
    case 'find-next':
      runFindNext();
      break;
    case 'replace-next':
      runReplaceNext();
      break;
    case 'replace-all':
      runReplaceAll();
      break;
    case 'close-find-replace':
      closeFindReplaceDialog();
      break;
    case 'check-links':
      await runLinkCheck();
      break;
    case 'close-link-check':
      closeLinkCheckModal();
      break;
    case 'open-keybindings':
      openKeybindingsModal();
      break;
    case 'save-keybindings':
      await saveKeybindingsFromEditor();
      break;
    case 'reset-keybindings':
      await resetKeybindingsToDefault();
      break;
    case 'close-keybindings':
      closeKeybindingsModal();
      break;
    case 'open-version-history':
      openVersionHistoryModal();
      break;
    case 'close-version-history':
      closeVersionHistoryModal();
      break;
    case 'restore-selected-snapshot':
      await restoreSelectedSnapshot();
      break;
    case 'restore-session':
      if (payload?.state) {
        applySessionState(payload.state);
      }
      break;
    case 'open-command-palette':
      openCommandPalette();
      break;
    case 'format-bold':
    case 'format-italic':
    case 'format-inline-code':
    case 'format-code-block':
    case 'format-highlight':
    case 'format-horizontal-rule':
    case 'format-increase-indent':
    case 'format-decrease-indent':
    case 'format-heading-1':
    case 'format-heading-2':
    case 'format-heading-3':
    case 'format-list-bullet':
    case 'format-list-number':
    case 'format-quote':
    case 'format-link':
      applyFormatAction(action);
      break;

    case 'mode-raw':
      setViewVisibility(true, false);
      break;
    case 'mode-formatted':
      setViewVisibility(false, true);
      break;
    case 'mode-split':
      setViewVisibility(true, true);
      break;
    case 'toggle-raw-view':
      setViewVisibility(payload.enabled ?? !showRaw, showFormatted);
      break;
    case 'toggle-formatted-view':
      setViewVisibility(showRaw, payload.enabled ?? !showFormatted);
      break;

    case 'zoom-raw-in':
      rawZoom = Math.min(2.2, rawZoom + 0.1);
      applyRawZoom();
      break;
    case 'zoom-raw-out':
      rawZoom = Math.max(0.7, rawZoom - 0.1);
      applyRawZoom();
      break;
    case 'zoom-raw-reset':
      rawZoom = 1;
      applyRawZoom();
      break;
    case 'zoom-formatted-in':
      formattedZoom = Math.min(2.2, formattedZoom + 0.1);
      applyFormattedZoom();
      break;
    case 'zoom-formatted-out':
      formattedZoom = Math.max(0.7, formattedZoom - 0.1);
      applyFormattedZoom();
      break;
    case 'zoom-formatted-reset':
      formattedZoom = 1;
      applyFormattedZoom();
      break;

    case 'load-theme':
      await loadThemeCss();
      break;
    case 'load-bundled-theme':
      if (typeof payload.fileName === 'string' && payload.fileName.trim()) {
        await loadBundledThemeCss(payload.fileName.trim());
      }
      break;
    case 'set-export-html-preset':
      if (payload.preset === 'default' || payload.preset === 'article' || payload.preset === 'compact') {
        exportHtmlPreset = payload.preset;
        updateMenuChecks();
        notifyNativeMenuState();
      }
      break;
    case 'set-export-pdf-preset':
      if (payload.preset === 'default' || payload.preset === 'serif' || payload.preset === 'dark') {
        exportPdfPreset = payload.preset;
        updateMenuChecks();
        notifyNativeMenuState();
      }
      break;
    case 'set-export-docx-preset':
      if (payload.preset === 'default' || payload.preset === 'classic' || payload.preset === 'report') {
        exportDocxPreset = payload.preset;
        updateMenuChecks();
        notifyNativeMenuState();
      }
      break;
    case 'set-export-pages-preset':
      if (payload.preset === 'default' || payload.preset === 'manuscript' || payload.preset === 'presentation') {
        exportPagesPreset = payload.preset;
        updateMenuChecks();
        notifyNativeMenuState();
      }
      break;
    case 'show-about':
      await window.nativeApi.showAboutDialog();
      break;
    case 'ribbon-icons':
      setRibbonMode('icons');
      break;
    case 'ribbon-text':
      setRibbonMode('text');
      break;
    case 'ribbon-both':
      setRibbonMode('both');
      break;
    case 'ribbon-display':
      if (payload.mode === 'icons' || payload.mode === 'text' || payload.mode === 'both') {
        setRibbonMode(payload.mode);
      }
      break;
    case 'horizontal-view':
      setSplitOrientation('horizontal');
      break;
    case 'vertical-view':
      setSplitOrientation('vertical');
      break;
    case 'set-split-orientation':
      if (payload.orientation === 'horizontal' || payload.orientation === 'vertical') {
        setSplitOrientation(payload.orientation);
      }
      break;
    case 'toggle-spellcheck':
      setSpellcheckEnabled(!spellcheckEnabled);
      break;
    case 'set-spellcheck':
      setSpellcheckEnabled(Boolean(payload.enabled));
      break;
    case 'dictionary-en-us':
      await setDictionaryLanguage('en-US');
      break;
    case 'dictionary-en-gb':
      await setDictionaryLanguage('en-GB');
      break;
    case 'set-dictionary-language':
      if (payload.language === 'en-US' || payload.language === 'en-GB') {
        await setDictionaryLanguage(payload.language);
      }
      break;
    case 'toggle-embedded-menu':
      setEmbeddedMenu(!embeddedMenu);
      break;
    case 'set-embedded-menu':
      setEmbeddedMenu(Boolean(payload.enabled));
      break;
    case 'toggle-theme-debug':
      setThemeDebugVisible(!themeDebugVisible);
      break;
    case 'set-theme-debug':
      setThemeDebugVisible(Boolean(payload.enabled));
      break;
    case 'toggle-sync-views':
      setSyncViewsEnabled(!syncViewsEnabled);
      break;
    case 'set-sync-views':
      setSyncViewsEnabled(Boolean(payload.enabled));
      break;
    case 'toggle-word-wrap':
      setWordWrapEnabled(!wordWrapEnabled);
      break;
    case 'set-word-wrap':
      setWordWrapEnabled(Boolean(payload.enabled));
      break;
    case 'toggle-line-numbers':
      setLineNumbersEnabled(!lineNumbersEnabled);
      break;
    case 'set-line-numbers':
      setLineNumbersEnabled(Boolean(payload.enabled));
      break;
    case 'set-editor-font-family':
      setEditorFontFamily(payload.family || '');
      break;
    case 'toggle-mermaid-preview':
      setMermaidPreviewEnabled(!mermaidPreviewEnabled);
      break;
    case 'set-mermaid-preview':
      setMermaidPreviewEnabled(Boolean(payload.enabled));
      break;
    case 'toggle-outline-view':
      setOutlineVisible(!outlineVisible);
      break;
    case 'set-outline-view':
      setOutlineVisible(Boolean(payload.enabled));
      break;
    case 'outline-left':
      setOutlinePosition('left');
      break;
    case 'outline-right':
      setOutlinePosition('right');
      break;
    case 'set-outline-position':
      if (payload.position === 'left' || payload.position === 'right') {
        setOutlinePosition(payload.position);
      }
      break;
    case 'toggle-dark-mode':
      await setDarkModeMode(darkModeMode === 'light' ? 'dark' : darkModeMode === 'dark' ? 'auto' : 'light');
      break;
    case 'set-dark-mode':
      await setDarkModeMode(payload.enabled ? 'dark' : 'light');
      break;
    case 'set-dark-mode-mode':
      await setDarkModeMode(payload.mode);
      break;
    case 'toggle-dark-mode-sync':
      await setDarkModeMode(darkModeMode === 'auto' ? (darkMode ? 'dark' : 'light') : 'auto');
      break;
    case 'set-dark-mode-sync':
      await setDarkModeMode(payload.enabled ? 'auto' : (darkMode ? 'dark' : 'light'));
      break;
    case 'system-dark-mode-changed':
      if (darkModeMode === 'auto') {
        setDarkMode(Boolean(payload.enabled), { persist: false });
      }
      break;
    case 'open-settings':
      openSettings();
      break;
    case 'close-settings':
      closeSettings();
      break;
    case 'edit-front-matter':
      openFrontMatterEditor();
      break;
    case 'add-front-matter-row': {
      const rows = collectFrontMatterRows();
      rows.push({ key: '', value: '' });
      renderFrontMatterRows(rows);
      break;
    }
    case 'save-front-matter':
      saveFrontMatterFromEditor();
      break;
    case 'close-front-matter':
      closeFrontMatterEditor();
      break;
    case 'close-command-palette':
      closeCommandPalette();
      break;
    default:
      break;
  }

  closeAllMenus();
}

function wireMenus() {
  for (const trigger of menuTriggers) {
    trigger.addEventListener('click', (event) => {
      const group = event.currentTarget.closest('.menu-group');
      const willOpen = !group.classList.contains('open');
      closeAllMenus();
      if (willOpen) group.classList.add('open');
    });
  }

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!target.closest('.menu-group')) closeAllMenus();
  });

  for (const button of actionButtons) {
    button.addEventListener('click', () => {
      const action = button.getAttribute('data-action');
      if (action) {
        const payload = {};
        if (button.dataset.preset) payload.preset = button.dataset.preset;
        if (button.dataset.mode) payload.mode = button.dataset.mode;
        void handleAction(action, payload);
      }
    });
  }

  if (recentFilesMenu) {
    recentFilesMenu.addEventListener('click', (event) => {
      const target = event.target;
      const button = target.closest('button[data-action="file-open-recent"]');
      if (!button) return;
      const filePath = button.dataset.path;
      if (filePath) {
        void handleAction('file-open-recent', { path: filePath });
      }
    });
  }

  if (tocList) {
    tocList.addEventListener('click', (event) => {
      const target = event.target;
      const button = target.closest('.toc-item[data-slug]');
      if (!button) return;
      const slug = button.dataset.slug;
      const line = Number(button.dataset.line || 0);
      jumpToOutlineItem({ slug, line });
    });
  }

  if (paletteInput) {
    paletteInput.addEventListener('input', () => {
      paletteActiveIndex = 0;
      renderCommandPaletteList(paletteInput.value);
    });
    paletteInput.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        paletteActiveIndex = Math.min(paletteItems.length - 1, paletteActiveIndex + 1);
        renderCommandPaletteList(paletteInput.value);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        paletteActiveIndex = Math.max(0, paletteActiveIndex - 1);
        renderCommandPaletteList(paletteInput.value);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        executeCommandPaletteIndex(paletteActiveIndex);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCommandPalette();
      }
    });
  }

  if (paletteList) {
    paletteList.addEventListener('click', (event) => {
      const target = event.target;
      const button = target.closest('.palette-item[data-index]');
      if (!button) return;
      executeCommandPaletteIndex(Number(button.dataset.index));
    });
  }

  if (frontMatterRows) {
    frontMatterRows.addEventListener('click', (event) => {
      const target = event.target;
      const button = target.closest('button[data-action="remove-front-matter-row"]');
      if (!button) return;
      const index = Number(button.dataset.index);
      const rows = collectFrontMatterRows();
      rows.splice(index, 1);
      renderFrontMatterRows(rows);
    });
  }
}

function wireKeyboardShortcuts() {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (commandPalette && !commandPalette.classList.contains('hidden')) {
        event.preventDefault();
        closeCommandPalette();
        return;
      }
      if (frontMatterModal && !frontMatterModal.classList.contains('hidden')) {
        event.preventDefault();
        closeFrontMatterEditor();
        return;
      }
      if (findReplaceModal && !findReplaceModal.classList.contains('hidden')) {
        event.preventDefault();
        closeFindReplaceDialog();
        return;
      }
      if (linkCheckModal && !linkCheckModal.classList.contains('hidden')) {
        event.preventDefault();
        closeLinkCheckModal();
        return;
      }
      if (settingsModal && !settingsModal.classList.contains('hidden')) {
        event.preventDefault();
        closeSettings();
        return;
      }
      if (versionHistoryModal && !versionHistoryModal.classList.contains('hidden')) {
        event.preventDefault();
        closeVersionHistoryModal();
        return;
      }
    }

    const target = event.target;
    const editableTarget = target instanceof HTMLElement && (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable
    );

    const combo = comboFromKeyboardEvent(event);
    if (!combo) return;

    let action = null;
    for (const [candidateAction, candidateCombo] of Object.entries(keybindings)) {
      if (normalizeKeyComboString(candidateCombo) === combo) {
        action = candidateAction;
        break;
      }
    }
    if (!action) return;
    if (editableTarget && !['edit-find', 'edit-replace', 'find-next', 'open-command-palette'].includes(action)) return;
    event.preventDefault();
    void handleAction(action);
  });
}

function wireEvents() {
  window.addEventListener('resize', () => {
    invalidatePreviewAnchorCache();
    updateLineNumbers({ force: true });
  });
  if (editorFontMenu) {
    editorFontMenu.addEventListener('click', (event) => {
      const target = event.target;
      const button = target.closest('button[data-editor-font-family]');
      if (!button) return;
      setEditorFontFamily(button.dataset.editorFontFamily || '');
      closeAllMenus();
    });
  }
  if (settingsRibbonMode) {
    settingsRibbonMode.addEventListener('change', () => setRibbonMode(settingsRibbonMode.value));
  }
  if (settingsThemeMode) {
    settingsThemeMode.addEventListener('change', () => {
      void setDarkModeMode(settingsThemeMode.value);
    });
  }
  if (settingsEmbeddedMenu) {
    settingsEmbeddedMenu.addEventListener('change', () => setEmbeddedMenu(settingsEmbeddedMenu.checked));
  }
  if (settingsEditorFont) {
    settingsEditorFont.addEventListener('change', () => setEditorFontFamily(settingsEditorFont.value));
  }
  if (settingsWordWrap) {
    settingsWordWrap.addEventListener('change', () => setWordWrapEnabled(settingsWordWrap.checked));
  }
  if (settingsLineNumbers) {
    settingsLineNumbers.addEventListener('change', () => setLineNumbersEnabled(settingsLineNumbers.checked));
  }
  if (settingsSpellcheck) {
    settingsSpellcheck.addEventListener('change', () => setSpellcheckEnabled(settingsSpellcheck.checked));
  }
  if (settingsDictionaryLanguage) {
    settingsDictionaryLanguage.addEventListener('change', () => {
      void setDictionaryLanguage(settingsDictionaryLanguage.value);
    });
  }
  if (settingsMermaidPreview) {
    settingsMermaidPreview.addEventListener('change', () => setMermaidPreviewEnabled(settingsMermaidPreview.checked));
  }
  if (settingsThemeDebug) {
    settingsThemeDebug.addEventListener('change', () => setThemeDebugVisible(settingsThemeDebug.checked));
  }
  if (typeof ResizeObserver !== 'undefined') {
    const rawEditorResizeObserver = new ResizeObserver(() => {
      updateLineNumbers({ force: true });
    });
    rawEditorResizeObserver.observe(rawEditor);
  }

  rawEditor.addEventListener('input', handleRawEdit);
  rawEditor.addEventListener('keyup', () => {
    syncPreviewToRawCursor();
    publishSessionState();
  });
  rawEditor.addEventListener('click', () => {
    syncPreviewToRawCursor();
    publishSessionState();
  });
  rawEditor.addEventListener('scroll', () => {
    updateLineNumberScroll();
    if (activeScrollSyncSource === 'preview') {
      publishSessionState();
      return;
    }
    schedulePreviewScrollSync();
    publishSessionState();
  });
  rawEditor.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])];
    const hasImage = files.some((file) => String(file.type || '').startsWith('image/'));
    if (!hasImage) return;
    event.preventDefault();
    void importImagesAndInsert(files);
  });
  rawEditor.addEventListener('dragover', (event) => {
    const hasImage = [...(event.dataTransfer?.files || [])].some((file) => String(file.type || '').startsWith('image/'));
    if (!hasImage) return;
    event.preventDefault();
    rawEditor.classList.add('drag-target');
  });
  rawEditor.addEventListener('dragleave', () => {
    rawEditor.classList.remove('drag-target');
  });
  rawEditor.addEventListener('drop', (event) => {
    const files = [...(event.dataTransfer?.files || [])];
    const hasImage = files.some((file) => String(file.type || '').startsWith('image/'));
    if (!hasImage) return;
    event.preventDefault();
    rawEditor.classList.remove('drag-target');
    void importImagesAndInsert(files);
  });
  workspace.addEventListener('dragover', (event) => {
    const hasImage = [...(event.dataTransfer?.files || [])].some((file) => String(file.type || '').startsWith('image/'));
    if (!hasImage) return;
    event.preventDefault();
  });
  workspace.addEventListener('drop', (event) => {
    const files = [...(event.dataTransfer?.files || [])];
    const hasImage = files.some((file) => String(file.type || '').startsWith('image/'));
    if (!hasImage) return;
    event.preventDefault();
    rawEditor.classList.remove('drag-target');
    rawEditor.focus({ preventScroll: true });
    void importImagesAndInsert(files);
  });
  rawEditor.addEventListener('keydown', handleRawListContinuationKeydown);
  rawEditor.addEventListener('focus', () => {
    lastFocusedEditor = 'raw';
  });

  frame.addEventListener('load', () => {
    diagnosticLog('renderer.frame.load');
    invalidatePreviewAnchorCache();
    void updateFrameCss();
    applyFrameTheme();
    const split = splitFrontMatter(markdownState);
    patchFrameHtml(md.render(split.body, { bodyLineOffset: split.bodyLineOffset || 0 }));
    scheduleFrameMermaidRender();
    applyFormattedZoom();
    applySpellcheckSetting();

    const doc = frame.contentDocument;
    doc.body.addEventListener('focus', () => {
      lastFocusedEditor = 'formatted';
    });
    doc.body.addEventListener('keydown', (event) => {
      if (!showFormatted) return;
      applyHeadingShortcutInFormatted(event);
    });
    doc.body.addEventListener('input', () => {
      if (!showFormatted) return;
      handleFormattedEdit();
    });
    doc.addEventListener('selectionchange', () => {
      if (lastFocusedEditor !== 'formatted') return;
      syncRawToPreviewCursor();
      publishSessionState();
    });
    const onPreviewScroll = () => {
      if (activeScrollSyncSource === 'raw') {
        publishSessionState();
        return;
      }
      scheduleRawScrollSync();
      publishSessionState();
    };
    doc.addEventListener('scroll', onPreviewScroll, true);
    const scrollEl = doc.scrollingElement || doc.documentElement || doc.body;
    if (scrollEl) {
      scrollEl.addEventListener('scroll', onPreviewScroll, { passive: true });
    }
    if (frame.contentWindow) {
      frame.contentWindow.addEventListener('scroll', onPreviewScroll, { passive: true });
    }
    schedulePreviewScrollSync();
    updateThemeDebug();
  });

  window.nativeApi.onMenuAction(({ action, payload }) => {
    void handleAction(action, payload);
  });

  if (findInput) {
    findInput.addEventListener('input', () => {
      refreshFindMatches(true);
      updateFindStatus('Ready');
    });
    findInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runFindNext();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeFindReplaceDialog();
      }
    });
  }

  if (replaceInput) {
    replaceInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runReplaceNext();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeFindReplaceDialog();
      }
    });
  }

  for (const checkbox of [findRegex, findCase, findWord]) {
    if (!checkbox) continue;
    checkbox.addEventListener('change', () => {
      refreshFindMatches(true);
      updateFindStatus('Ready');
    });
  }

  if (keybindingsList) {
    keybindingsList.addEventListener('keydown', (event) => {
      const target = event.target;
      const input = target.closest('input[data-action]');
      if (!input) return;
      const combo = comboFromKeyboardEvent(event);
      if (!combo) return;
      event.preventDefault();
      input.value = formatKeyComboForPlatform(combo);
    });
  }

  if (versionHistoryList) {
    versionHistoryList.addEventListener('click', (event) => {
      const target = event.target;
      const row = target.closest('.snapshot-item[data-snapshot-id]');
      if (!row) return;
      selectedSnapshotId = row.dataset.snapshotId || '';
      for (const item of [...versionHistoryList.querySelectorAll('.snapshot-item')]) {
        item.classList.toggle('active', item.dataset.snapshotId === selectedSnapshotId);
      }
    });
  }

  window.addEventListener('beforeunload', () => {
    publishSessionState();
  });
}

function bootstrap() {
  diagnosticLog('renderer.bootstrap.start');
  ensureFrameDocument();
  diagnosticLog('renderer.ensure-frame-document.done');
  setTimeout(() => {
    initializeSyntaxHighlighter();
  }, 0);
  wireMenus();
  diagnosticLog('renderer.wire-menus.done');
  wireKeyboardShortcuts();
  diagnosticLog('renderer.wire-shortcuts.done');
  wireEvents();
  diagnosticLog('renderer.wire-events.done');

  rawEditor.value = markdownState;
  updateLineNumbers({ force: true });
  savedBaseline = markdownState;
  rawUndoStack.length = 0;
  rawRedoStack.length = 0;
  syncRawSnapshot();
  applyRawZoom();
  setViewVisibility(true, true);
  setSplitOrientation('horizontal');
  setOutlinePosition('right', { persist: false });
  setOutlineVisible(true, { persist: false });
  setSpellcheckEnabled(true);
  setListContinuationMode(null);
  void setDictionaryLanguage('en-US');
  setRibbonMode('both', { persist: false });
  setEmbeddedMenu(false);
  setThemeDebugVisible(false);
  setSyncViewsEnabled(true, { persist: false });
  setWordWrapEnabled(false, { persist: false });
  setLineNumbersEnabled(false, { persist: false });
  setMermaidPreviewEnabled(false, { persist: false });
  void setDarkModeMode('light', { persist: false });
  setDirty(false);
  updateWindowTitle();
  updateStatusBar();
  void refreshRecentFilesMenu();
  startAutosaveLoop();
  diagnosticLog('renderer.autosave.started');
  void (async () => {
    diagnosticLog('renderer.startup.async.begin');
    await loadKeybindingsPreference();
    diagnosticLog('renderer.startup.keybindings.loaded');
    if (!hasRestoredSessionState) {
      const defaultTemplate = await loadDefaultTemplate();
      if (defaultTemplate?.loaded) {
        const templateContent = applyTemplateTokens(defaultTemplate.content || '');
        markdownState = templateContent;
        rawEditor.value = templateContent;
        updateLineNumbers({ force: true });
        renderFromMarkdown(templateContent);
        savedBaseline = templateContent;
        currentFilePath = null;
        currentFileName = 'Untitled.md';
        lastSavedAt = null;
        rawUndoStack.length = 0;
        rawRedoStack.length = 0;
        syncRawSnapshot();
        setDirty(false);
        updateWindowTitle();
        updateStatusBar();
        diagnosticLog('renderer.startup.default-template.loaded', {
          length: templateContent.length
        });
      } else {
        diagnosticLog('renderer.startup.default-template.none');
      }
    }

    const savedDarkModeMode = await loadDarkModePreference();
    await setDarkModeMode(savedDarkModeMode, { persist: false });
    diagnosticLog('renderer.startup.dark-mode.loaded', {
      enabled: darkMode,
      mode: darkModeMode,
      source: darkModeMode === 'auto' ? 'system' : 'saved'
    });

    const savedRibbonMode = await loadRibbonModePreference();
    setRibbonMode(savedRibbonMode, { persist: false });
    diagnosticLog('renderer.startup.ribbon-mode.loaded', { mode: savedRibbonMode });

    const savedEditorFont = await loadEditorFontPreference();
    setEditorFontFamily(savedEditorFont, { persist: false });
    void populateEditorFontMenu();
    diagnosticLog('renderer.startup.editor-font.loaded', { family: editorFontFamily || 'system' });

    const savedSyncViews = await loadSyncViewsPreference();
    setSyncViewsEnabled(savedSyncViews, { persist: false });
    diagnosticLog('renderer.startup.sync-views.loaded', { enabled: savedSyncViews });

    const savedWordWrap = await loadWordWrapPreference();
    setWordWrapEnabled(savedWordWrap, { persist: false });
    diagnosticLog('renderer.startup.word-wrap.loaded', { enabled: savedWordWrap });

    const savedLineNumbers = await loadLineNumbersPreference();
    setLineNumbersEnabled(savedLineNumbers, { persist: false });
    diagnosticLog('renderer.startup.line-numbers.loaded', { enabled: savedLineNumbers });

    const savedMermaidPreview = await loadMermaidPreviewPreference();
    setMermaidPreviewEnabled(savedMermaidPreview, { persist: false });
    diagnosticLog('renderer.startup.mermaid-preview.loaded', { enabled: savedMermaidPreview });

    const mermaidCrashNotice = await window.nativeApi.loadMermaidPreviewCrashNotice();
    if (mermaidCrashNotice?.enabled) {
      if (mermaidPreviewEnabled) {
        setMermaidPreviewEnabled(false);
      }
      await window.nativeApi.clearMermaidPreviewCrashNotice();
      await window.nativeApi.showMermaidPreviewDisabledDialog();
      diagnosticLog('renderer.startup.mermaid-preview.auto-disabled');
    }

    const savedOutline = await loadOutlinePreference();
    setOutlinePosition(savedOutline.position, { persist: false });
    setOutlineVisible(savedOutline.visible, { persist: false });
    diagnosticLog('renderer.startup.outline.loaded', savedOutline);

    await loadSavedThemeOnStartup();
    diagnosticLog('renderer.startup.theme.loaded');
    const split = splitFrontMatter(markdownState);
    patchFrameHtml(md.render(split.body, { bodyLineOffset: split.bodyLineOffset || 0 }));
    scheduleFrameMermaidRender();
    applyFormattedZoom();
    updateThemeDebug();
    publishSessionState();
    diagnosticLog('renderer.startup.async.done');
  })();
}

bootstrap();

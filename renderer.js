const MarkdownIt = require('markdown-it');
const markdownItFootnote = require('markdown-it-footnote');
const TurndownService = require('turndown');
const morphdom = require('morphdom');
const katex = require('katex');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const { fileURLToPath, pathToFileURL } = require('url');
const {
  normalizeMindmapLayout
} = require('./mindmap-core');
const { createPaneLayoutController, normalizePaneSizeWeights } = require('./renderer-pane-layout');
const { createMindmapViewController } = require('./renderer-mindmap-view');
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
md.use(markdownItFootnote);

let katexCssText = '';
try {
  const katexCssPath = require.resolve('katex/dist/katex.min.css');
  const katexCssDir = path.dirname(katexCssPath);
  katexCssText = fsSync
    .readFileSync(katexCssPath, 'utf8')
    .replace(/url\((fonts\/[^)]+)\)/g, (_match, fontPath) => `url("${pathToFileURL(path.join(katexCssDir, fontPath)).href}")`);
} catch {
  katexCssText = '';
}

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
const MARKDOWN_INDENT = '   ';

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

function isMarkdownTagBoundary(value) {
  if (!value) return true;
  return /[\s([{"'`<]/.test(value);
}

md.inline.ruler.before('emphasis', 'markdown_tag', (state, silent) => {
  const start = state.pos;
  const src = state.src;
  if (src.charCodeAt(start) !== 0x23) return false;
  if (!isMarkdownTagBoundary(src[start - 1])) return false;
  if (!/[A-Za-z0-9]/.test(src[start + 1] || '')) return false;

  let end = start + 2;
  while (end < src.length && /[A-Za-z0-9/_-]/.test(src[end])) {
    end += 1;
  }

  const tag = src.slice(start + 1, end).replace(/[/-]+$/g, '');
  if (!tag) return false;
  const actualEnd = start + 1 + tag.length;
  const next = src[actualEnd] || '';
  if (next && /[A-Za-z0-9_/-]/.test(next)) return false;
  if (silent) return false;

  const token = state.push('markdown_tag', 'span', 0);
  token.content = tag;
  state.pos = actualEnd;
  return true;
});

md.inline.ruler.before('escape', 'inline_math', (state, silent) => {
  const start = state.pos;
  const src = state.src;
  if (src.charCodeAt(start) !== 0x24) return false;
  if (src.charCodeAt(start + 1) === 0x24) return false;
  if (start > 0 && src.charCodeAt(start - 1) === 0x5c) return false;

  let end = start + 1;
  while (end < src.length) {
    if (src.charCodeAt(end) === 0x24 && src.charCodeAt(end - 1) !== 0x5c) break;
    end += 1;
  }
  if (end >= src.length || end === start + 1) return false;
  const content = src.slice(start + 1, end);
  if (/^\s|\s$/.test(content) || content.includes('\n')) return false;
  if (silent) return false;

  const token = state.push('math_inline', 'span', 0);
  token.content = content;
  state.pos = end + 1;
  return true;
});

function markdownLineText(state, line) {
  return state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
}

function isDefinitionLine(value) {
  return /^\s{0,3}:\s*(.*)$/.exec(value || '');
}

function hasDefinitionPair(state, line, endLine) {
  if (line + 1 >= endLine) return false;
  const term = markdownLineText(state, line).trim();
  if (!term) return false;
  return Boolean(isDefinitionLine(markdownLineText(state, line + 1)));
}

md.block.ruler.before('paragraph', 'definition_list', (state, startLine, endLine, silent) => {
  if (!hasDefinitionPair(state, startLine, endLine)) return false;
  if (silent) return true;

  const listOpen = state.push('dl_open', 'dl', 1);
  listOpen.map = [startLine, startLine];
  let line = startLine;

  while (line < endLine && hasDefinitionPair(state, line, endLine)) {
    const term = markdownLineText(state, line).trim();
    const termOpen = state.push('dt_open', 'dt', 1);
    termOpen.map = [line, line + 1];
    const termInline = state.push('inline', '', 0);
    termInline.content = term;
    termInline.map = [line, line + 1];
    termInline.children = [];
    state.push('dt_close', 'dt', -1);
    line += 1;

    while (line < endLine) {
      const definitionMatch = isDefinitionLine(markdownLineText(state, line));
      if (!definitionMatch) break;
      const definition = definitionMatch[1].trim();
      const definitionOpen = state.push('dd_open', 'dd', 1);
      definitionOpen.map = [line, line + 1];
      const paragraphOpen = state.push('paragraph_open', 'p', 1);
      paragraphOpen.map = [line, line + 1];
      const definitionInline = state.push('inline', '', 0);
      definitionInline.content = definition;
      definitionInline.map = [line, line + 1];
      definitionInline.children = [];
      state.push('paragraph_close', 'p', -1);
      state.push('dd_close', 'dd', -1);
      line += 1;

      if (line < endLine && markdownLineText(state, line).trim() === '') {
        const nextPairLine = line + 1;
        if (hasDefinitionPair(state, nextPairLine, endLine)) {
          line = nextPairLine;
        }
        break;
      }

      if (hasDefinitionPair(state, line, endLine)) break;
      if (line >= endLine || !isDefinitionLine(markdownLineText(state, line))) break;
    }
    if (line < endLine && markdownLineText(state, line).trim() === '') break;
  }

  listOpen.map[1] = line;
  state.push('dl_close', 'dl', -1);
  state.line = line;
  return true;
});

md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
  const firstLine = markdownLineText(state, startLine).trim();
  if (firstLine !== '$$') return false;

  let nextLine = startLine + 1;
  while (nextLine < endLine) {
    if (markdownLineText(state, nextLine).trim() === '$$') break;
    nextLine += 1;
  }
  if (nextLine >= endLine) return false;
  if (silent) return true;

  const token = state.push('math_block', 'div', 0);
  token.block = true;
  token.content = state.src
    .split(/\r?\n/)
    .slice(startLine + 1, nextLine)
    .join('\n')
    .trim();
  token.map = [startLine, nextLine + 1];
  state.line = nextLine + 1;
  return true;
});

md.core.ruler.after('inline', 'task_list_items', (state) => {
  const tokens = state.tokens || [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'inline' || !Array.isArray(token.children) || token.children.length === 0) continue;
    if (tokens[index - 1]?.type !== 'paragraph_open') continue;

    let listItemOpen = null;
    for (let cursor = index - 2; cursor >= 0; cursor -= 1) {
      if (tokens[cursor].type === 'list_item_close') break;
      if (tokens[cursor].type === 'list_item_open') {
        listItemOpen = tokens[cursor];
        break;
      }
    }
    if (!listItemOpen) continue;

    const firstChild = token.children[0];
    if (firstChild.type !== 'text') continue;
    const match = firstChild.content.match(/^\[([ xX])]\s+/);
    if (!match) continue;

    const checked = match[1].toLowerCase() === 'x';
    firstChild.content = firstChild.content.slice(match[0].length);
    const checkbox = new state.Token('task_checkbox', 'span', 0);
    const sourceLine = Array.isArray(token.map) ? token.map[0] + (state.env?.bodyLineOffset || 0) : null;
    checkbox.meta = { checked, sourceLine };
    token.children.unshift(checkbox);
    listItemOpen.attrJoin('class', 'task-list-item');
    listItemOpen.attrJoin('class', checked ? 'task-list-item-checked' : 'task-list-item-unchecked');
  }
});

const CALLOUT_TYPES = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution'
};

md.core.ruler.after('task_list_items', 'github_callouts', (state) => {
  const tokens = state.tokens || [];
  for (let index = 0; index < tokens.length; index += 1) {
    const blockquote = tokens[index];
    if (blockquote.type !== 'blockquote_open') continue;
    const paragraph = tokens[index + 1];
    const inline = tokens[index + 2];
    if (paragraph?.type !== 'paragraph_open' || inline?.type !== 'inline') continue;
    if (!Array.isArray(inline.children) || inline.children.length === 0) continue;

    const firstChild = inline.children[0];
    if (firstChild.type !== 'text') continue;
    const match = firstChild.content.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)]\s*/i);
    if (!match) continue;

    const type = match[1].toLowerCase();
    firstChild.content = firstChild.content.slice(match[0].length);
    if (!firstChild.content && inline.children[1]?.type === 'softbreak') {
      inline.children.splice(0, 2);
    } else if (!firstChild.content) {
      inline.children.shift();
    }

    blockquote.attrJoin('class', 'markdown-callout');
    blockquote.attrJoin('class', `markdown-callout-${type}`);
    blockquote.attrSet('data-callout-title', CALLOUT_TYPES[type]);
  }
});

md.renderer.rules.task_checkbox = (tokens, idx) => {
  const checked = tokens[idx].meta?.checked === true;
  const sourceLine = Number.isInteger(tokens[idx].meta?.sourceLine) ? ` data-line="${tokens[idx].meta.sourceLine}"` : '';
  return `<input class="task-list-checkbox${checked ? ' checked' : ''}" type="checkbox"${checked ? ' checked' : ''}${sourceLine} aria-label="${checked ? 'Completed' : 'Not completed'}" title="Toggle task" contenteditable="false" />`;
};

function renderMathWithKatex(value, displayMode = false) {
  try {
    return katex.renderToString(String(value || ''), {
      displayMode,
      throwOnError: false,
      trust: false,
      strict: 'warn',
      output: 'htmlAndMathml'
    });
  } catch {
    return md.utils.escapeHtml(value);
  }
}

md.renderer.rules.math_inline = (tokens, idx) => `<span class="math-inline">${renderMathWithKatex(tokens[idx].content, false)}</span>`;

md.renderer.rules.math_block = (tokens, idx) => `<div class="math-block">${renderMathWithKatex(tokens[idx].content, true)}</div>\n`;

md.renderer.rules.markdown_tag = (tokens, idx) => {
  const tag = tokens[idx].content || '';
  const escapedTag = md.utils.escapeHtml(tag);
  const escapedAttr = md.utils.escapeHtml(tag).replace(/"/g, '&quot;');
  return `<span class="markdown-tag-chip" data-tag="${escapedAttr}" title="#${escapedAttr}" contenteditable="false">${escapedTag}</span>`;
};

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

turndown.addRule('markdownTagChips', {
  filter: (node) => node.nodeName === 'SPAN' && node.classList?.contains('markdown-tag-chip'),
  replacement: (content, node) => `#${node.getAttribute('data-tag') || content}`
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
const rawPane = document.getElementById('raw-pane');
const formattedPane = document.getElementById('formatted-pane');
const rawEditor = document.getElementById('raw-editor');
const rawEditorShell = document.getElementById('raw-editor-shell');
const rawFoldGutter = document.getElementById('raw-fold-gutter');
const rawFoldList = document.getElementById('raw-fold-list');
const rawLineNumberList = document.getElementById('raw-line-number-list');
const frame = document.getElementById('formatted-frame');
const mindmapPane = document.getElementById('mindmap-pane');
const mindmapViewport = document.getElementById('mindmap-viewport');
const mindmapCanvas = document.getElementById('mindmap-canvas');
const mindmapDiagnostics = document.getElementById('mindmap-diagnostics');
const paneSplitters = [...document.querySelectorAll('.pane-splitter[data-splitter]')];
const titlebarText = document.getElementById('titlebar-text');
const themeDebug = document.getElementById('theme-debug');
const ribbonThemeModeButtons = [...document.querySelectorAll('[data-theme-mode]')];
const recentFilesMenu = document.getElementById('recent-files-menu');
const tocPane = document.getElementById('toc-pane');
const tocList = document.getElementById('toc-list');
const notesTreePane = document.getElementById('notes-tree-pane');
const notesTreeRoot = document.getElementById('notes-tree-root');
const notesTreeList = document.getElementById('notes-tree-list');
const notesTreeResizer = document.getElementById('notes-tree-resizer');
const notesTreeSortMenu = document.getElementById('notes-tree-sort-menu');
const notesTreeContextMenu = document.getElementById('notes-tree-context-menu');
const paneHeaderPositionClassNames = Array.from({ length: 10 }, (_item, index) => `pane-position-${index}`);
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
const keybindingsModal = document.getElementById('keybindings-modal');
const keybindingsList = document.getElementById('keybindings-list');
const settingsRibbonDisplay = document.getElementById('settings-ribbon-display');
const settingsThemeMode = document.getElementById('settings-theme-mode');
const settingsEmbeddedMenu = document.getElementById('settings-embedded-menu');
const settingsEditorFont = document.getElementById('settings-editor-font');
const settingsWordWrap = document.getElementById('settings-word-wrap');
const settingsLineNumbers = document.getElementById('settings-line-numbers');
const settingsContinuePrefixes = document.getElementById('settings-continue-prefixes');
const settingsCollapsibleText = document.getElementById('settings-collapsible-text');
const settingsSpellcheck = document.getElementById('settings-spellcheck');
const settingsDictionary = document.getElementById('settings-dictionary');
const settingsMermaidPreview = document.getElementById('settings-mermaid-preview');
const settingsThemeDebug = document.getElementById('settings-theme-debug');
const versionHistoryModal = document.getElementById('version-history-modal');
const versionHistoryList = document.getElementById('version-history-list');
const folderEmojiModal = document.getElementById('folder-emoji-modal');
const folderEmojiInput = document.getElementById('folder-emoji-input');
const statusLastSaved = document.getElementById('status-last-saved');
const statusLineCount = document.getElementById('status-line-count');
const statusWordCount = document.getElementById('status-word-count');
const statusCharCount = document.getElementById('status-char-count');
const statusImageCount = document.getElementById('status-image-count');
const boundPreviewDocuments = new WeakSet();

const paneLayout = createPaneLayoutController({
  body,
  workspace,
  panes: {
    raw: rawPane,
    formatted: formattedPane,
    mindmap: mindmapPane
  },
  splitters: paneSplitters,
  getVisibility: () => ({
    raw: showRaw,
    formatted: showFormatted,
    mindmap: showMindmap
  }),
  getOrientation: () => splitOrientation,
  onResize: () => scheduleMindmapRender(),
  onChange: () => publishSessionState()
});

const mindmapView = createMindmapViewController({
  canvas: mindmapCanvas,
  viewport: mindmapViewport,
  diagnosticsElement: mindmapDiagnostics,
  nativeApi: window.nativeApi,
  getMarkdown: () => markdownState,
  getFileName: () => currentFileName,
  getFilePath: () => currentFilePath,
  isVisible: () => showMindmap,
  isDarkMode: () => darkMode,
  canScrollRaw: () => showRaw,
  onScrollToLine: (line) => scrollRawToLine(line),
  onStateChange: () => publishSessionState(),
  alertUser: (message) => window.alert(message)
});

let markdownState = '';
let lastRenderedHtml = '';
let userCssPath = null;
let userCssText = '';
let themeLightPath = null;
let themeLightCssText = '';
let themeDarkPath = null;
let themeDarkCssText = '';
let renderingForExport = false;
let defaultTemplatePath = null;
let templatesEnabled = false;
let currentFilePath = null;
let currentFileName = 'Untitled.md';
let isDirty = false;
let savedBaseline = markdownState;
let lastSavedAt = null;

let showRaw = true;
let showFormatted = true;
let showMindmap = false;
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
let collapsibleTextEnabled = false;
let continuePrefixesEnabled = true;
let mermaidPreviewEnabled = false;
let outlineVisible = true;
let outlinePosition = 'right';
let notesTreeVisible = false;
let notesTreePosition = 'left';
let notesTreeRootPath = null;
let notesTreeData = null;
let notesTreeError = '';
let notesTreeTruncated = false;
let notesTreeItemLimit = 0;
let notesTreeLoading = false;
let notesTreeFolderEmojis = {};
let notesTreeWidth = 270;
let notesTreeZoom = 1;
let notesTreeSort = {
  folders: { field: 'name', direction: 'asc' },
  files: { field: 'name', direction: 'asc' }
};
let notesTreeRainbowFolders = false;
let activeFolderEmojiPath = '';
let activeNotesTreeContextPath = '';
const notesTreeExpandedPaths = new Set();
const NOTES_TREE_MIN_WIDTH = 200;
const NOTES_TREE_DEFAULT_WIDTH = 270;
const NOTES_TREE_MAX_WIDTH = 520;
const NOTES_TREE_MIN_ZOOM = 0.7;
const NOTES_TREE_MAX_ZOOM = 2.2;
const NOTES_TREE_SORT_FIELDS = new Set(['name', 'created', 'modified']);
const NOTES_TREE_SORT_DIRECTIONS = new Set(['asc', 'desc']);
const NOTES_TREE_SORT_FIELD_LABELS = {
  name: 'Alphabetically',
  created: 'Creation Date',
  modified: 'Modified Date'
};
const NOTES_TREE_RAINBOW_COLORS = [
  '#ff4d6d',
  '#ff8c1a',
  '#f6c945',
  '#62d26f',
  '#20c997',
  '#22b8ff',
  '#6c8cff',
  '#b36bff',
  '#ff66d8'
];
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
let activeRawFolds = [];
let rawFoldDisplayRows = [];
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
  'toggle-theme-debug': 'CmdOrCtrl+Shift+D'
};
let keybindings = { ...DEFAULT_KEYBINDINGS };
let editorFont = 'system-mono';

const KEYBINDING_GROUPS = [
  {
    label: 'File',
    actions: ['file-new', 'file-new-window', 'file-new-from-template', 'file-load', 'file-save', 'file-save-as', 'app-exit']
  },
  {
    label: 'Edit',
    actions: ['edit-find', 'edit-replace', 'find-next', 'open-command-palette']
  },
  {
    label: 'Format',
    actions: ['format-bold', 'format-italic', 'format-inline-code']
  },
  {
    label: 'View',
    actions: ['zoom-raw-in', 'zoom-raw-out', 'zoom-raw-reset', 'toggle-theme-debug']
  }
];

const KEYBINDING_LABELS = {
  'file-new': 'New Document',
  'file-new-window': 'New Window',
  'file-new-from-template': 'New from Template',
  'file-load': 'Open',
  'file-save': 'Save',
  'file-save-as': 'Export',
  'app-exit': 'Exit',
  'edit-find': 'Find',
  'edit-replace': 'Replace',
  'find-next': 'Find Next',
  'open-command-palette': 'Command Palette',
  'format-bold': 'Bold',
  'format-italic': 'Italic',
  'format-inline-code': 'Inline Code',
  'zoom-raw-in': 'Markdown Zoom In',
  'zoom-raw-out': 'Markdown Zoom Out',
  'zoom-raw-reset': 'Reset Markdown Zoom',
  'toggle-theme-debug': 'Show Theme Debug'
};

const menuTriggers = [...document.querySelectorAll('.menu-trigger')];
const menuGroups = [...document.querySelectorAll('.menu-group')];
const actionButtons = [...document.querySelectorAll('[data-action]')];
const calloutMenu = document.getElementById('callout-menu');

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
  return [
    wordWrapEnabled ? 'wrap' : 'nowrap',
    rawEditor.clientWidth,
    rawEditor.style.fontSize || '',
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
  if (rawFoldList) {
    rawFoldList.style.transform = `translateY(-${rawEditor.scrollTop || 0}px)`;
  }
}

function discoverRawFoldRegions(source = markdownState) {
  const lines = String(source || '').split('\n');
  const regions = [];
  if (lines[0] === '---') {
    let end = -1;
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index] === '---') {
        end = index;
        break;
      }
    }
    if (end > 0) {
      regions.push({ key: 'metadata:0', type: 'metadata', start: 0, end, level: 0 });
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+\S/.exec(lines[index] || '');
    if (!match) continue;
    const level = match[1].length;
    let end = lines.length - 1;
    for (let next = index + 1; next < lines.length; next += 1) {
      const nextMatch = /^(#{1,6})\s+\S/.exec(lines[next] || '');
      if (nextMatch && nextMatch[1].length <= level) {
        end = next - 1;
        break;
      }
    }
    if (end > index) {
      regions.push({ key: `heading:${index}`, type: 'heading', start: index, end, level });
    }
  }
  return regions;
}

function foldedRegionForLine(lineIndex) {
  return activeRawFolds.find((region) => region.start === lineIndex) || null;
}

function isLineInsideFold(lineIndex) {
  return activeRawFolds.some((region) => lineIndex > region.start && lineIndex <= region.end);
}

function pruneRawFolds() {
  const regions = discoverRawFoldRegions(markdownState);
  activeRawFolds = activeRawFolds
    .map((fold) => regions.find((region) => region.key === fold.key) || null)
    .filter(Boolean);
}

function buildRawEditorDisplay() {
  const source = String(markdownState || '');
  const lines = source.split('\n');
  rawFoldDisplayRows = [];
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (isLineInsideFold(index)) continue;
    output.push(lines[index]);
    rawFoldDisplayRows.push({ sourceLine: index, placeholder: false });
    const fold = foldedRegionForLine(index);
    if (fold) {
      const hiddenCount = Math.max(1, fold.end - fold.start);
      output.push(`⋯ ${hiddenCount} line${hiddenCount === 1 ? '' : 's'} folded`);
      rawFoldDisplayRows.push({ sourceLine: index, placeholder: true, fold });
    }
  }
  return output.join('\n');
}

function applyRawEditorDisplay(options = {}) {
  const selectionStart = options.selectionStart ?? rawEditor.selectionStart;
  const selectionEnd = options.selectionEnd ?? rawEditor.selectionEnd;
  suppressRawHandler = true;
  if (activeRawFolds.length === 0) {
    rawFoldDisplayRows = [];
  }
  rawEditor.value = activeRawFolds.length > 0 ? buildRawEditorDisplay() : markdownState;
  updateLineNumbers({ force: true });
  if (activeRawFolds.length === 0 && typeof selectionStart === 'number' && typeof selectionEnd === 'number') {
    rawEditor.setSelectionRange(Math.min(selectionStart, rawEditor.value.length), Math.min(selectionEnd, rawEditor.value.length));
  }
  suppressRawHandler = false;
  syncRawSnapshot();
}

function expandAllRawFolds(options = {}) {
  if (activeRawFolds.length === 0) return false;
  activeRawFolds = [];
  applyRawEditorDisplay(options);
  return true;
}

function toggleRawFold(region) {
  if (!collapsibleTextEnabled || !region) return;
  const existingIndex = activeRawFolds.findIndex((fold) => fold.key === region.key);
  if (existingIndex >= 0) {
    activeRawFolds.splice(existingIndex, 1);
  } else {
    activeRawFolds = activeRawFolds.filter((fold) => !(fold.start > region.start && fold.end <= region.end));
    activeRawFolds.push(region);
  }
  pruneRawFolds();
  applyRawEditorDisplay();
}

function updateLineNumbers({ force = false } = {}) {
  if (!rawLineNumberList) return;
  const metrics = getRawLineMetrics({ force });
  const lines = metrics.lines;
  const lineCount = countRawEditorLines();
  const signature = `${lineCount}:${metrics.signature}`;

  if (force || signature !== lastLineNumberSignature || lineCount !== lastLineNumberCount) {
    rawLineNumberList.replaceChildren();
    rawFoldList?.replaceChildren();
    const foldRegions = collapsibleTextEnabled ? discoverRawFoldRegions(markdownState) : [];
    for (let index = 0; index < lineCount; index += 1) {
      const rowInfo = rawFoldDisplayRows[index] || { sourceLine: index, placeholder: false };
      const row = document.createElement('div');
      row.className = 'raw-line-number-row';
      row.textContent = rowInfo.placeholder ? '' : String((rowInfo.sourceLine ?? index) + 1);
      row.style.height = `${metrics.heights[index] || getRawEditorLineHeight()}px`;
      rawLineNumberList.appendChild(row);

      if (rawFoldList) {
        const foldRow = document.createElement('button');
        foldRow.type = 'button';
        foldRow.className = 'raw-fold-row';
        foldRow.style.height = row.style.height;
        const region = foldRegions.find((candidate) => candidate.start === rowInfo.sourceLine);
        const active = region && activeRawFolds.some((fold) => fold.key === region.key);
        foldRow.textContent = region ? (active ? '▸' : '▾') : '';
        foldRow.disabled = !region;
        if (region) foldRow.dataset.foldKey = region.key;
        rawFoldList.appendChild(foldRow);
      }
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

function renderKeybindingsEditor() {
  if (!keybindingsList) return;
  keybindingsList.innerHTML = '';
  for (const group of KEYBINDING_GROUPS) {
    const groupElement = document.createElement('section');
    groupElement.className = 'keybinding-group';
    const heading = document.createElement('div');
    heading.className = 'keybinding-group-title';
    heading.textContent = group.label;
    groupElement.appendChild(heading);

    for (const action of group.actions) {
      const defaultCombo = DEFAULT_KEYBINDINGS[action];
      if (!defaultCombo) continue;
      const row = document.createElement('div');
      row.className = 'keybinding-row';
      const labelWrap = document.createElement('div');
      labelWrap.className = 'keybinding-label';
      const label = document.createElement('label');
      label.textContent = keybindingDisplayName(action);
      const hint = document.createElement('div');
      hint.className = 'keybinding-default';
      hint.textContent = `Default ${defaultCombo}`;
      const input = document.createElement('input');
      input.type = 'text';
      input.dataset.action = action;
      input.value = keybindings[action] || defaultCombo;
      labelWrap.appendChild(label);
      labelWrap.appendChild(hint);
      row.appendChild(labelWrap);
      row.appendChild(input);
      groupElement.appendChild(row);
    }
    keybindingsList.appendChild(groupElement);
  }
}

function keybindingDisplayName(action) {
  if (KEYBINDING_LABELS[action]) return KEYBINDING_LABELS[action];
  return String(action || '')
    .replace(/^(file|edit|format|view|tools)-/, '')
    .split('-')
    .map((word) => word ? `${word[0].toUpperCase()}${word.slice(1)}` : '')
    .join(' ');
}

function renderSettingsControls() {
  if (settingsRibbonDisplay) settingsRibbonDisplay.value = ribbonMode;
  if (settingsThemeMode) settingsThemeMode.value = darkModeMode;
  if (settingsEmbeddedMenu) settingsEmbeddedMenu.checked = embeddedMenu;
  if (settingsEditorFont) settingsEditorFont.value = editorFont;
  if (settingsWordWrap) settingsWordWrap.checked = wordWrapEnabled;
  if (settingsLineNumbers) settingsLineNumbers.checked = lineNumbersEnabled;
  if (settingsContinuePrefixes) settingsContinuePrefixes.checked = continuePrefixesEnabled;
  if (settingsCollapsibleText) settingsCollapsibleText.checked = collapsibleTextEnabled;
  if (settingsSpellcheck) settingsSpellcheck.checked = spellcheckEnabled;
  if (settingsDictionary) {
    settingsDictionary.value = dictionaryLanguage;
    settingsDictionary.disabled = !spellcheckEnabled;
  }
  if (settingsMermaidPreview) settingsMermaidPreview.checked = mermaidPreviewEnabled;
  if (settingsThemeDebug) settingsThemeDebug.checked = themeDebugVisible;
}

function openKeybindingsModal() {
  if (!keybindingsModal) return;
  renderSettingsControls();
  renderKeybindingsEditor();
  keybindingsModal.classList.remove('hidden');
}

function closeKeybindingsModal() {
  if (!keybindingsModal) return;
  keybindingsModal.classList.add('hidden');
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
      showMindmap,
      mindmapZoom: mindmapView.getZoom(),
      mindmapLayout: mindmapView.getLayout(),
      paneSizeWeights: paneLayout.getWeights(),
      mindmapScrollLeft: mindmapView.getScrollState().scrollLeft,
      mindmapScrollTop: mindmapView.getScrollState().scrollTop,
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
  paneLayout.setWeights(normalizePaneSizeWeights(state.paneSizeWeights));
  setViewVisibility(state.showRaw !== false, state.showFormatted !== false, state.showMindmap === true);
  mindmapView.setZoom(Number.isFinite(state.mindmapZoom) ? Math.max(0.35, Math.min(2.4, state.mindmapZoom)) : 1);
  mindmapView.setLayout(normalizeMindmapLayout(state.mindmapLayout));
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
    mindmapView.setScrollState({ scrollLeft: state.mindmapScrollLeft, scrollTop: state.mindmapScrollTop });
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

function formatTemplateDateToken(token, now) {
  const monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthsLong = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const replacements = {
    yyyy: String(now.getFullYear()),
    MMMM: monthsLong[now.getMonth()],
    MMM: monthsShort[now.getMonth()],
    MM: pad2(now.getMonth() + 1),
    dd: pad2(now.getDate())
  };

  return token.replace(/yyyy|MMMM|MMM|MM|dd/g, (match) => replacements[match] || match);
}

function formatTemplateTimeToken(token, now) {
  const hours24 = now.getHours();
  const hours12 = hours24 % 12 || 12;
  const replacements = {
    HH: pad2(hours24),
    hh: pad2(hours12),
    mm: pad2(now.getMinutes())
  };

  return token.replace(/HH|hh|mm/g, (match) => replacements[match] || match);
}

function applyTemplateTokens(content) {
  const source = String(content || '');
  const now = new Date();
  const dateValue = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const timeValue = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

  const withLegacyTokens = source
    .replace(/\{\{date\}\}/g, dateValue)
    .replace(/\{\{time\}\}/g, timeValue);
  return withLegacyTokens.replace(/\{\{([^{}]+)\}\}/g, (match, token) => {
    const trimmed = String(token || '').trim();
    if (/^(?=.*yyyy)(?=.*d)(?=.*M)[yMd\-/.\s]+$/.test(trimmed)) {
      return formatTemplateDateToken(trimmed, now);
    }
    if (/^(?:HH|hh):mm$/.test(trimmed)) {
      return formatTemplateTimeToken(trimmed, now);
    }
    return match;
  });
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
    const empty = document.createElement('button');
    empty.type = 'button';
    empty.className = 'toc-item';
    empty.disabled = true;
    empty.textContent = 'No headings';
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

function updateSidePaneLayoutClasses() {
  if (!workspace) return;
  workspace.classList.toggle('with-outline', outlineVisible);
  workspace.classList.toggle('with-notes-tree', notesTreeVisible);
  workspace.classList.toggle('outline-left', outlineVisible && outlinePosition === 'left');
  workspace.classList.toggle('outline-right', outlineVisible && outlinePosition === 'right');
  workspace.classList.toggle('notes-tree-left', notesTreeVisible && notesTreePosition === 'left');
  workspace.classList.toggle('notes-tree-right', notesTreeVisible && notesTreePosition === 'right');
  applyNotesTreeWidth();
  updatePaneHeaderPositionClasses();
}

function clampNotesTreeWidth(value) {
  const availableWidth = workspace?.getBoundingClientRect().width || window.innerWidth || NOTES_TREE_MAX_WIDTH;
  const maxWidth = Math.max(NOTES_TREE_MIN_WIDTH, Math.min(NOTES_TREE_MAX_WIDTH, availableWidth - 420));
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return NOTES_TREE_DEFAULT_WIDTH;
  return Math.max(NOTES_TREE_MIN_WIDTH, Math.min(maxWidth, Math.round(numeric)));
}

function applyNotesTreeWidth() {
  notesTreeWidth = clampNotesTreeWidth(notesTreeWidth);
  if (workspace) workspace.style.setProperty('--notes-tree-width', `${notesTreeWidth}px`);
}

function setNotesTreeWidth(width, options = {}) {
  notesTreeWidth = clampNotesTreeWidth(width);
  applyNotesTreeWidth();
  if (options.persist !== false) saveNotesTreePreference();
}

function clampNotesTreeZoom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(NOTES_TREE_MIN_ZOOM, Math.min(NOTES_TREE_MAX_ZOOM, Math.round(numeric * 100) / 100));
}

function applyNotesTreeZoom() {
  notesTreeZoom = clampNotesTreeZoom(notesTreeZoom);
  if (notesTreePane) notesTreePane.style.setProperty('--notes-tree-zoom', String(notesTreeZoom));
}

function setNotesTreeZoom(value, options = {}) {
  notesTreeZoom = clampNotesTreeZoom(value);
  applyNotesTreeZoom();
  if (options.persist !== false) saveNotesTreePreference();
}

function headerElementForPaneKey(key) {
  if (key === 'notesTree') return notesTreePane?.querySelector('.pane-header-notes-tree') || null;
  if (key === 'outline') return tocPane?.querySelector('.pane-header-outline') || null;
  if (key === 'raw') return rawPane?.querySelector('.pane-header-markdown') || null;
  if (key === 'formatted') return formattedPane?.querySelector('.pane-header-preview') || null;
  if (key === 'mindmap') return mindmapPane?.querySelector('.mindmap-toolbar') || null;
  return null;
}

function updatePaneHeaderPositionClasses() {
  const paneOrder = [];

  if (notesTreeVisible && notesTreePosition === 'left') paneOrder.push('notesTree');
  if (outlineVisible && outlinePosition === 'left') paneOrder.push('outline');
  if (showRaw) paneOrder.push('raw');
  if (showFormatted) paneOrder.push('formatted');
  if (showMindmap) paneOrder.push('mindmap');
  if (outlineVisible && outlinePosition === 'right') paneOrder.push('outline');
  if (notesTreeVisible && notesTreePosition === 'right') paneOrder.push('notesTree');

  for (const key of ['notesTree', 'outline', 'raw', 'formatted', 'mindmap']) {
    const header = headerElementForPaneKey(key);
    if (!header) continue;
    header.classList.remove(...paneHeaderPositionClassNames);
    const index = paneOrder.indexOf(key);
    if (index >= 0) {
      header.classList.add(`pane-position-${Math.min(index, paneHeaderPositionClassNames.length - 1)}`);
    }
  }
}

function notesTreeFolderEmoji(folderPath) {
  return notesTreeFolderEmojis?.[folderPath] || '';
}

function normalizeNotesTreeSortPreference(value) {
  const source = value && typeof value === 'object' ? value : {};
  const normalizeGroup = (group) => ({
    field: NOTES_TREE_SORT_FIELDS.has(group?.field) ? group.field : 'name',
    direction: NOTES_TREE_SORT_DIRECTIONS.has(group?.direction) ? group.direction : 'asc'
  });
  return {
    folders: normalizeGroup(source.folders),
    files: normalizeGroup(source.files)
  };
}

function notesTreeSortDirectionLabel(field, direction) {
  if (field === 'name') return direction === 'desc' ? 'Z-A' : 'A-Z';
  return direction === 'desc' ? 'Latest first' : 'Oldest first';
}

function notesTreeSortSummary() {
  const folderSort = notesTreeSort.folders;
  const fileSort = notesTreeSort.files;
  return `Folders: ${NOTES_TREE_SORT_FIELD_LABELS[folderSort.field]}, ${notesTreeSortDirectionLabel(folderSort.field, folderSort.direction)}. Files: ${NOTES_TREE_SORT_FIELD_LABELS[fileSort.field]}, ${notesTreeSortDirectionLabel(fileSort.field, fileSort.direction)}.`;
}

function closeNotesTreeSortMenu() {
  notesTreeSortMenu?.classList.add('hidden');
}

function closeNotesTreeContextMenu() {
  notesTreeContextMenu?.classList.add('hidden');
  activeNotesTreeContextPath = '';
}

function openNotesTreeContextMenu(filePath, clientX, clientY) {
  if (!notesTreeContextMenu || !filePath) return;
  closeAllMenus();
  activeNotesTreeContextPath = filePath;
  notesTreeContextMenu.classList.remove('hidden');
  const menuRect = notesTreeContextMenu.getBoundingClientRect();
  const left = Math.min(Math.max(8, clientX), Math.max(8, window.innerWidth - menuRect.width - 8));
  const top = Math.min(Math.max(8, clientY), Math.max(8, window.innerHeight - menuRect.height - 8));
  notesTreeContextMenu.style.left = `${left}px`;
  notesTreeContextMenu.style.top = `${top}px`;
  notesTreeContextMenu.querySelector('button')?.focus({ preventScroll: true });
}

function renderNotesTreeSortMenu() {
  if (!notesTreeSortMenu) return;
  notesTreeSortMenu.innerHTML = '';

  const groups = [
    { key: 'folders', title: 'Folders' },
    { key: 'files', title: 'Files' }
  ];

  for (const group of groups) {
    const section = document.createElement('section');
    section.className = 'notes-tree-sort-section';

    const title = document.createElement('div');
    title.className = 'notes-tree-sort-title';
    title.textContent = group.title;
    section.appendChild(title);

    const fields = document.createElement('div');
    fields.className = 'notes-tree-sort-options';
    for (const field of ['name', 'created', 'modified']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.action = 'set-notes-tree-sort-field';
      button.dataset.group = group.key;
      button.dataset.field = field;
      button.classList.toggle('active', notesTreeSort[group.key].field === field);
      button.textContent = NOTES_TREE_SORT_FIELD_LABELS[field];
      fields.appendChild(button);
    }
    section.appendChild(fields);

    const directions = document.createElement('div');
    directions.className = 'notes-tree-sort-options';
    for (const direction of ['asc', 'desc']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.action = 'set-notes-tree-sort-direction';
      button.dataset.group = group.key;
      button.dataset.direction = direction;
      button.classList.toggle('active', notesTreeSort[group.key].direction === direction);
      button.textContent = notesTreeSortDirectionLabel(notesTreeSort[group.key].field, direction);
      directions.appendChild(button);
    }
    section.appendChild(directions);
    notesTreeSortMenu.appendChild(section);
  }
}

function toggleNotesTreeSortMenu(anchor) {
  if (!notesTreeSortMenu || !anchor) return;
  if (!notesTreeSortMenu.classList.contains('hidden')) {
    closeNotesTreeSortMenu();
    return;
  }

  closeAllMenus();
  renderNotesTreeSortMenu();
  const rect = anchor.getBoundingClientRect();
  notesTreeSortMenu.classList.remove('hidden');
  const menuRect = notesTreeSortMenu.getBoundingClientRect();
  const left = Math.min(Math.max(8, rect.right - menuRect.width), Math.max(8, window.innerWidth - menuRect.width - 8));
  const top = Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - menuRect.height - 8));
  notesTreeSortMenu.style.left = `${left}px`;
  notesTreeSortMenu.style.top = `${top}px`;
  notesTreeSortMenu.querySelector('button')?.focus({ preventScroll: true });
}

async function setNotesTreeSort(group, patch) {
  if (group !== 'folders' && group !== 'files') return;
  notesTreeSort = normalizeNotesTreeSortPreference({
    ...notesTreeSort,
    [group]: {
      ...notesTreeSort[group],
      ...patch
    }
  });
  saveNotesTreePreference();
  renderNotesTreeSortMenu();
  await refreshNotesTree();
}

function openFolderEmojiEditor(folderPath) {
  if (!folderEmojiModal || !folderEmojiInput || !folderPath) return;
  activeFolderEmojiPath = folderPath;
  folderEmojiInput.value = notesTreeFolderEmoji(folderPath);
  folderEmojiModal.classList.remove('hidden');
  window.setTimeout(() => {
    folderEmojiInput.focus();
    folderEmojiInput.select();
  }, 0);
}

function closeFolderEmojiEditor() {
  if (folderEmojiModal) folderEmojiModal.classList.add('hidden');
  activeFolderEmojiPath = '';
}

function saveFolderEmojiFromEditor(options = {}) {
  if (!activeFolderEmojiPath) return;
  const rawValue = options.clear ? '' : (folderEmojiInput?.value || '');
  const trimmed = rawValue.trim();
  if (trimmed) {
    notesTreeFolderEmojis[activeFolderEmojiPath] = [...trimmed][0] || trimmed;
  } else {
    delete notesTreeFolderEmojis[activeFolderEmojiPath];
  }
  saveNotesTreePreference();
  renderNotesTree();
  closeFolderEmojiEditor();
}

function beginNotesTreeResize(event) {
  if (!notesTreeVisible || !notesTreePane) return;
  event.preventDefault();
  notesTreeResizer?.classList.add('active');
  body.classList.add('resizing-panes');
  const startX = event.clientX;
  const startWidth = notesTreePane.getBoundingClientRect().width || notesTreeWidth;

  const onPointerMove = (moveEvent) => {
    const deltaX = moveEvent.clientX - startX;
    const direction = notesTreePosition === 'left' ? 1 : -1;
    setNotesTreeWidth(startWidth + (deltaX * direction), { persist: false });
  };

  const onPointerUp = () => {
    notesTreeResizer?.classList.remove('active');
    body.classList.remove('resizing-panes');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    saveNotesTreePreference();
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
}

function renderNotesTreeRoot() {
  if (!notesTreeRoot) return;
  notesTreeRoot.innerHTML = '';

  const selectButton = document.createElement('button');
  selectButton.type = 'button';
  selectButton.className = 'notes-tree-root-button';
  selectButton.dataset.action = 'choose-notes-tree-root';
  selectButton.textContent = notesTreeRootPath ? path.basename(notesTreeRootPath) || notesTreeRootPath : 'Choose notes folder';
  notesTreeRoot.appendChild(selectButton);

  if (notesTreeRootPath) {
    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.className = 'notes-tree-refresh-button';
    refreshButton.dataset.action = 'refresh-notes-tree';
    refreshButton.title = 'Refresh notes tree';
    refreshButton.setAttribute('aria-label', 'Refresh notes tree');
    refreshButton.textContent = '↻';
    notesTreeRoot.appendChild(refreshButton);

    const sortButton = document.createElement('button');
    sortButton.type = 'button';
    sortButton.className = 'notes-tree-sort-button';
    sortButton.dataset.action = 'show-notes-tree-sort-menu';
    sortButton.title = notesTreeSortSummary();
    sortButton.setAttribute('aria-label', 'Sort notes tree');
    sortButton.textContent = '⇅';
    notesTreeRoot.appendChild(sortButton);
  }
}

function notesTreeRainbowColorForIndex(index) {
  return NOTES_TREE_RAINBOW_COLORS[index % NOTES_TREE_RAINBOW_COLORS.length];
}

function renderNotesTreeNode(node, depth = 0, inheritedColor = '', siblingIndex = 0) {
  const row = document.createElement('div');
  row.className = `notes-tree-row notes-tree-${node.type}`;
  row.style.setProperty('--depth', String(depth));
  row.dataset.path = node.path;
  row.dataset.type = node.type;
  const rowColor = notesTreeRainbowFolders
    ? (depth === 1 && node.type === 'folder' ? notesTreeRainbowColorForIndex(siblingIndex) : inheritedColor)
    : '';
  if (rowColor) {
    row.classList.add('rainbow');
    row.style.setProperty('--notes-tree-rainbow-color', rowColor);
  }

  if (node.type === 'folder') {
    const expanded = notesTreeExpandedPaths.has(node.path);
    row.classList.toggle('expanded', expanded);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'notes-tree-disclosure';
    toggle.dataset.action = 'toggle-notes-tree-folder';
    toggle.dataset.path = node.path;
    toggle.textContent = expanded ? '⌄' : '›';
    row.appendChild(toggle);

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'notes-tree-label';
    label.dataset.action = 'toggle-notes-tree-folder';
    label.dataset.path = node.path;
    const emoji = notesTreeFolderEmoji(node.path);
    label.textContent = `${emoji ? `${emoji} ` : ''}${node.name}`;
    row.appendChild(label);

    const emojiButton = document.createElement('button');
    emojiButton.type = 'button';
    emojiButton.className = 'notes-tree-emoji-button';
    emojiButton.dataset.action = 'set-notes-tree-folder-emoji';
    emojiButton.dataset.path = node.path;
    emojiButton.title = emoji ? 'Change folder emoji' : 'Add folder emoji';
    emojiButton.setAttribute('aria-label', `${emoji ? 'Change' : 'Add'} emoji for ${node.name}`);
    emojiButton.textContent = emoji || '+';
    row.appendChild(emojiButton);

    const fragment = document.createDocumentFragment();
    fragment.appendChild(row);
    if (expanded) {
      for (const [index, child] of (node.children || []).entries()) {
        fragment.appendChild(renderNotesTreeNode(child, depth + 1, rowColor, index));
      }
    }
    return fragment;
  }

  const spacer = document.createElement('span');
  spacer.className = 'notes-tree-file-spacer';
  row.appendChild(spacer);

  const label = document.createElement('button');
  label.type = 'button';
  label.className = 'notes-tree-label';
  label.dataset.action = 'open-notes-tree-file';
  label.dataset.path = node.path;
  label.textContent = node.name;
  row.appendChild(label);
  return row;
}

function renderNotesTree() {
  renderNotesTreeRoot();
  if (!notesTreeList) return;
  notesTreeList.innerHTML = '';

  if (notesTreeLoading) {
    const empty = document.createElement('div');
    empty.className = 'notes-tree-empty';
    empty.textContent = 'Loading notes...';
    notesTreeList.appendChild(empty);
    return;
  }

  if (!notesTreeRootPath) {
    const empty = document.createElement('div');
    empty.className = 'notes-tree-empty';
    empty.textContent = 'No notes folder selected';
    notesTreeList.appendChild(empty);
    return;
  }

  if (notesTreeError) {
    const empty = document.createElement('div');
    empty.className = 'notes-tree-empty';
    empty.textContent = notesTreeError;
    notesTreeList.appendChild(empty);
    return;
  }

  if (!notesTreeData) {
    const empty = document.createElement('div');
    empty.className = 'notes-tree-empty';
    empty.textContent = 'No notes found';
    notesTreeList.appendChild(empty);
    return;
  }

  notesTreeList.appendChild(renderNotesTreeNode(notesTreeData, 0));
  if (notesTreeTruncated) {
    const truncated = document.createElement('div');
    truncated.className = 'notes-tree-empty';
    truncated.textContent = notesTreeItemLimit > 0
      ? `Only the first ${notesTreeItemLimit.toLocaleString()} notes tree items are shown. Choose a smaller folder if something is missing.`
      : 'Only part of the notes tree is shown. Choose a smaller folder if something is missing.';
    notesTreeList.appendChild(truncated);
  }
}

function saveNotesTreePreference() {
  void window.nativeApi.saveNotesTreePreference({
    visible: notesTreeVisible,
    position: notesTreePosition,
    rootPath: notesTreeRootPath,
    folderEmojis: notesTreeFolderEmojis,
    sort: notesTreeSort,
    rainbowFolders: notesTreeRainbowFolders,
    zoom: notesTreeZoom,
    width: notesTreeWidth
  });
}

async function refreshNotesTree() {
  if (!notesTreeRootPath) {
    notesTreeData = null;
    notesTreeError = '';
    notesTreeTruncated = false;
    notesTreeItemLimit = 0;
    renderNotesTree();
    return;
  }

  notesTreeLoading = true;
  notesTreeError = '';
  renderNotesTree();
  const result = await window.nativeApi.readNotesTree({ rootPath: notesTreeRootPath, sort: notesTreeSort });
  notesTreeLoading = false;
  if (!result?.loaded) {
    notesTreeData = null;
    notesTreeError = result?.error || 'Unable to load notes folder';
    notesTreeTruncated = false;
    notesTreeItemLimit = 0;
  } else {
    notesTreeData = result.tree;
    notesTreeError = '';
    notesTreeTruncated = result.truncated === true;
    notesTreeItemLimit = Number(result.itemLimit || 0);
    if (notesTreeData?.path) notesTreeExpandedPaths.add(notesTreeData.path);
  }
  renderNotesTree();
}

async function chooseNotesTreeRoot() {
  const selected = await window.nativeApi.chooseNotesTreeRoot();
  if (!selected) return;
  notesTreeRootPath = selected;
  notesTreeVisible = true;
  notesTreeExpandedPaths.clear();
  notesTreeExpandedPaths.add(selected);
  updateSidePaneLayoutClasses();
  updateMenuChecks();
  saveNotesTreePreference();
  await refreshNotesTree();
}

function setNotesTreeVisible(enabled, options = {}) {
  const persist = options.persist !== false;
  notesTreeVisible = enabled === true;
  updateSidePaneLayoutClasses();
  renderNotesTree();
  updateMenuChecks();
  notifyNativeMenuState();
  if (persist) saveNotesTreePreference();
}

function setNotesTreePosition(position, options = {}) {
  const persist = options.persist !== false;
  notesTreePosition = position === 'right' ? 'right' : 'left';
  updateSidePaneLayoutClasses();
  updateMenuChecks();
  notifyNativeMenuState();
  if (persist) saveNotesTreePreference();
}

function setNotesTreeRainbowFolders(enabled, options = {}) {
  const persist = options.persist !== false;
  notesTreeRainbowFolders = enabled === true;
  renderNotesTree();
  updateMenuChecks();
  notifyNativeMenuState();
  if (persist) saveNotesTreePreference();
}

async function loadNotesTreePreference() {
  const result = await window.nativeApi.loadNotesTreePreference();
  if (!result?.loaded) {
    return {
      visible: false,
      position: 'left',
      rootPath: null,
      folderEmojis: {},
      sort: normalizeNotesTreeSortPreference(),
      rainbowFolders: false,
      zoom: 1,
      width: NOTES_TREE_DEFAULT_WIDTH
    };
  }
  return {
    visible: result.visible === true,
    position: result.position === 'right' ? 'right' : 'left',
    rootPath: result.rootPath || null,
    folderEmojis: result.folderEmojis && typeof result.folderEmojis === 'object' ? result.folderEmojis : {},
    sort: normalizeNotesTreeSortPreference(result.sort),
    rainbowFolders: result.rainbowFolders === true,
    zoom: clampNotesTreeZoom(result.zoom),
    width: clampNotesTreeWidth(result.width)
  };
}

function updateOutline() {
  outlineItems = buildOutlineFromMarkdown(markdownState);
  renderOutlineList();
}

function setOutlineVisible(enabled, options = {}) {
  const persist = options.persist !== false;
  outlineVisible = enabled !== false;
  updateSidePaneLayoutClasses();
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
  updateSidePaneLayoutClasses();
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

function scheduleMindmapRender() {
  mindmapView.scheduleRender();
}

function renderMindmapImmediately() {
  mindmapView.renderImmediately();
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
    { label: 'Tools: Keyboard Shortcuts...', action: 'open-keybindings' },
    { label: 'File: Version History...', action: 'open-version-history' },
    { label: 'View: Show Markdown Editor', action: 'toggle-raw-view', payload: { enabled: true } },
    { label: 'View: Show Preview', action: 'toggle-formatted-view', payload: { enabled: true } },
    { label: 'View: Toggle Mindmap', action: 'toggle-mindmap-view' },
    { label: 'View: Show Mindmap', action: 'toggle-mindmap-view', payload: { enabled: true } },
    { label: 'Mindmap Layout: Balanced', action: 'set-mindmap-layout', payload: { layout: 'balanced' } },
    { label: 'Mindmap Layout: Right', action: 'set-mindmap-layout', payload: { layout: 'right' } },
    { label: 'Mindmap Layout: Left', action: 'set-mindmap-layout', payload: { layout: 'left' } },
    { label: 'Mindmap Layout: Vertical', action: 'set-mindmap-layout', payload: { layout: 'vertical' } },
    { label: 'Mindmap Layout: Radial', action: 'set-mindmap-layout', payload: { layout: 'radial' } },
    { label: 'Mindmap: Export...', action: 'export-mindmap-svg' },
    { label: 'View: Toggle Outline', action: 'toggle-outline-view' },
    { label: 'View: Outline Left', action: 'outline-left' },
    { label: 'View: Outline Right', action: 'outline-right' },
    { label: 'View: Syncronise Views', action: 'toggle-sync-views' },
    { label: 'View: Toggle Word Wrap', action: 'toggle-word-wrap' },
    { label: 'View: Toggle Line Numbers', action: 'toggle-line-numbers' },
    { label: 'Tools: Edit Front Matter', action: 'edit-front-matter' },
    { label: 'Tools: Load Theme', action: 'load-theme' },
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
  const mindmapToggle = document.querySelector('[data-toggle="mindmap"]');
  const mindmapRibbonToggle = document.querySelector('[data-toggle="mindmap-ribbon"]');
  const mindmapLayoutBalancedToggle = document.querySelector('[data-toggle="mindmap-layout-balanced"]');
  const mindmapLayoutRightToggle = document.querySelector('[data-toggle="mindmap-layout-right"]');
  const mindmapLayoutLeftToggle = document.querySelector('[data-toggle="mindmap-layout-left"]');
  const mindmapLayoutVerticalToggle = document.querySelector('[data-toggle="mindmap-layout-vertical"]');
  const mindmapLayoutRadialToggle = document.querySelector('[data-toggle="mindmap-layout-radial"]');
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
  const continuePrefixesToggle = document.querySelector('[data-toggle="continue-prefixes"]');
  const collapsibleTextToggle = document.querySelector('[data-toggle="collapsible-text"]');
  const templatesEnabledToggle = document.querySelector('[data-toggle="templates-enabled"]');
  const mermaidPreviewToggle = document.querySelector('[data-toggle="mermaid-preview"]');
  const outlineToggle = document.querySelector('[data-toggle="outline-view"]');
  const outlineLeftToggle = document.querySelector('[data-toggle="outline-left"]');
  const outlineRightToggle = document.querySelector('[data-toggle="outline-right"]');
  const notesTreeToggle = document.querySelector('[data-toggle="notes-tree-view"]');
  const notesTreeLeftToggle = document.querySelector('[data-toggle="notes-tree-left"]');
  const notesTreeRightToggle = document.querySelector('[data-toggle="notes-tree-right"]');
  const notesTreeRainbowToggle = document.querySelector('[data-toggle="notes-tree-rainbow"]');
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
  if (mindmapToggle) mindmapToggle.classList.toggle('checked', showMindmap);
  if (mindmapRibbonToggle) mindmapRibbonToggle.classList.toggle('checked', showMindmap);
  const currentMindmapLayout = mindmapView.getLayout();
  if (mindmapLayoutBalancedToggle) mindmapLayoutBalancedToggle.classList.toggle('checked', currentMindmapLayout === 'balanced');
  if (mindmapLayoutRightToggle) mindmapLayoutRightToggle.classList.toggle('checked', currentMindmapLayout === 'right');
  if (mindmapLayoutLeftToggle) mindmapLayoutLeftToggle.classList.toggle('checked', currentMindmapLayout === 'left');
  if (mindmapLayoutVerticalToggle) mindmapLayoutVerticalToggle.classList.toggle('checked', currentMindmapLayout === 'vertical');
  if (mindmapLayoutRadialToggle) mindmapLayoutRadialToggle.classList.toggle('checked', currentMindmapLayout === 'radial');
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
  if (continuePrefixesToggle) continuePrefixesToggle.classList.toggle('checked', continuePrefixesEnabled);
  if (collapsibleTextToggle) collapsibleTextToggle.classList.toggle('checked', collapsibleTextEnabled);
  if (templatesEnabledToggle) templatesEnabledToggle.classList.toggle('checked', templatesEnabled);
  if (mermaidPreviewToggle) mermaidPreviewToggle.classList.toggle('checked', mermaidPreviewEnabled);
  if (outlineToggle) outlineToggle.classList.toggle('checked', outlineVisible);
  if (outlineLeftToggle) outlineLeftToggle.classList.toggle('checked', outlinePosition === 'left');
  if (outlineRightToggle) outlineRightToggle.classList.toggle('checked', outlinePosition === 'right');
  if (outlineLeftToggle) outlineLeftToggle.disabled = !outlineVisible;
  if (outlineRightToggle) outlineRightToggle.disabled = !outlineVisible;
  if (notesTreeToggle) notesTreeToggle.classList.toggle('checked', notesTreeVisible);
  if (notesTreeLeftToggle) notesTreeLeftToggle.classList.toggle('checked', notesTreePosition === 'left');
  if (notesTreeRightToggle) notesTreeRightToggle.classList.toggle('checked', notesTreePosition === 'right');
  if (notesTreeRainbowToggle) notesTreeRainbowToggle.classList.toggle('checked', notesTreeRainbowFolders);
  if (notesTreeLeftToggle) notesTreeLeftToggle.disabled = !notesTreeVisible;
  if (notesTreeRightToggle) notesTreeRightToggle.disabled = !notesTreeVisible;
  if (notesTreeRainbowToggle) notesTreeRainbowToggle.disabled = !notesTreeVisible;
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
    showMindmap,
    currentFilePath,
    mindmapLayout: mindmapView.getLayout(),
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
    continuePrefixesEnabled,
    collapsibleTextEnabled,
    templatesEnabled,
    mermaidPreviewEnabled,
    outlineVisible,
    outlinePosition,
    notesTreeVisible,
    notesTreePosition,
    notesTreeRainbowFolders,
    exportHtmlPreset,
    exportPdfPreset,
    exportDocxPreset,
    exportPagesPreset,
    activeThemeFileName
  });
}

function applySplitOrientation() {
  workspace.classList.remove('split-horizontal', 'split-vertical');
  workspace.classList.add(splitOrientation === 'vertical' ? 'split-vertical' : 'split-horizontal');
  invalidatePreviewAnchorCache();
  paneLayout.apply();
}

function updateListModeButtons() {
  const bulletButton = document.querySelector('.ribbon-button[data-action="format-list-bullet"]');
  const numberButton = document.querySelector('.ribbon-button[data-action="format-list-number"]');
  if (bulletButton) bulletButton.classList.toggle('active', listContinuationMode === 'bullet');
  if (numberButton) numberButton.classList.toggle('active', listContinuationMode === 'number');
}

function closeCalloutMenu() {
  calloutMenu?.classList.add('hidden');
}

function toggleCalloutMenu(anchor) {
  if (!calloutMenu || !anchor) return;
  if (!calloutMenu.classList.contains('hidden')) {
    closeCalloutMenu();
    return;
  }

  closeAllMenus();
  const rect = anchor.getBoundingClientRect();
  calloutMenu.classList.remove('hidden');
  const menuRect = calloutMenu.getBoundingClientRect();
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - menuRect.width - 8));
  const top = Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - menuRect.height - 8));
  calloutMenu.style.left = `${left}px`;
  calloutMenu.style.top = `${top}px`;
  calloutMenu.querySelector('button')?.focus({ preventScroll: true });
}

function setListContinuationMode(nextMode) {
  if (nextMode !== null && nextMode !== 'bullet' && nextMode !== 'number') return;
  listContinuationMode = nextMode;
  updateListModeButtons();
}

function setModeFromVisibility() {
  workspace.classList.remove(
    'mode-raw',
    'mode-formatted',
    'mode-mindmap',
    'mode-split',
    'mode-raw-formatted',
    'mode-raw-mindmap',
    'mode-formatted-mindmap',
    'mode-all'
  );

  const visibleCount = [showRaw, showFormatted, showMindmap].filter(Boolean).length;
  workspace.style.setProperty('--visible-pane-count', String(Math.max(1, visibleCount)));

  if (showRaw && showFormatted && showMindmap) {
    workspace.classList.add('mode-all');
  } else if (showRaw && showFormatted) {
    workspace.classList.add('mode-raw-formatted', 'mode-split');
  } else if (showRaw && showMindmap) {
    workspace.classList.add('mode-raw-mindmap');
  } else if (showFormatted && showMindmap) {
    workspace.classList.add('mode-formatted-mindmap');
  } else if (showRaw) {
    workspace.classList.add('mode-raw');
  } else if (showFormatted) {
    workspace.classList.add('mode-formatted');
  } else {
    workspace.classList.add('mode-mindmap');
  }

  applySplitOrientation();
  updatePaneHeaderPositionClasses();
  updateMenuChecks();
  notifyNativeMenuState();
}

function setViewVisibility(nextRaw, nextFormatted, nextMindmap = showMindmap) {
  if (!nextRaw && !nextFormatted && !nextMindmap) {
    return;
  }

  showRaw = nextRaw;
  showFormatted = nextFormatted;
  showMindmap = nextMindmap;
  setModeFromVisibility();
  invalidatePreviewAnchorCache();
  scheduleMindmapRender();
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

function applyEditorFont() {
  const fontStacks = {
    'system-mono': "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
    'system-sans': "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
    serif: "Georgia, 'Times New Roman', serif"
  };
  rawEditor.style.fontFamily = fontStacks[editorFont] || fontStacks['system-mono'];
  if (rawLineNumberList) {
    rawLineNumberList.style.fontFamily = fontStacks['system-mono'];
  }
  updateLineNumbers({ force: true });
}

function setEditorFont(nextFont) {
  if (nextFont !== 'system-sans' && nextFont !== 'serif') {
    editorFont = 'system-mono';
  } else {
    editorFont = nextFont;
  }
  applyEditorFont();
  renderSettingsControls();
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
  scheduleMindmapRender();
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

async function loadContinuePrefixesPreference() {
  const result = await window.nativeApi.loadContinuePrefixesPreference();
  if (!result?.loaded) return result?.enabled !== false;
  return result.enabled === true;
}

async function loadMermaidPreviewPreference() {
  const result = await window.nativeApi.loadMermaidPreviewPreference();
  if (!result?.loaded) return result?.enabled !== false;
  return result.enabled === true;
}

async function loadMindmapPreference() {
  const result = await window.nativeApi.loadMindmapPreference();
  if (!result?.loaded) return { enabled: false, layout: 'balanced' };
  return {
    enabled: result.enabled === true,
    layout: normalizeMindmapLayout(result.layout)
  };
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

function setCollapsibleTextEnabled(enabled, options = {}) {
  const persist = options.persist !== false;
  collapsibleTextEnabled = enabled === true;
  rawEditorShell?.classList.toggle('collapsible-text-enabled', collapsibleTextEnabled);
  if (!collapsibleTextEnabled) {
    activeRawFolds = [];
  }
  applyRawEditorDisplay();
  if (persist) {
    void window.nativeApi.saveCollapsibleTextPreference({ enabled: collapsibleTextEnabled });
  }
  renderSettingsControls();
  updateMenuChecks();
  notifyNativeMenuState();
}

async function loadLineNumbersPreference() {
  const result = await window.nativeApi.loadLineNumbersPreference();
  if (!result?.loaded) return false;
  return result.enabled === true;
}

async function loadCollapsibleTextPreference() {
  const result = await window.nativeApi.loadCollapsibleTextPreference();
  if (!result?.loaded) return false;
  return result.enabled === true;
}

function setContinuePrefixesEnabled(enabled, options = {}) {
  const persist = options.persist !== false;
  continuePrefixesEnabled = enabled !== false;
  if (persist) {
    void window.nativeApi.saveContinuePrefixesPreference({ enabled: continuePrefixesEnabled });
  }
  updateMenuChecks();
  notifyNativeMenuState();
}

function setMindmapVisible(enabled, options = {}) {
  const persist = options.persist !== false;
  setViewVisibility(showRaw, showFormatted, enabled === true);
  if (persist) {
    void window.nativeApi.saveMindmapPreference({
      enabled: showMindmap,
      layout: mindmapView.getLayout()
    });
  }
  updateMenuChecks();
  notifyNativeMenuState();
}

function setMindmapLayout(layout, options = {}) {
  const persist = options.persist !== false;
  mindmapView.setLayout(normalizeMindmapLayout(layout));
  updateMenuChecks();
  notifyNativeMenuState();
  publishSessionState();
  if (persist) {
    void window.nativeApi.saveMindmapPreference({
      enabled: showMindmap,
      layout: mindmapView.getLayout()
    });
  }
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
    ${katexCssText}
    body {
      box-sizing: border-box !important;
      padding: 14px 28px 32px 28px !important;
    }
    body > :first-child {
      margin-top: 0 !important;
    }
    .task-list-item {
      list-style: none;
      margin-left: -1.35em;
    }
    .task-list-checkbox {
      appearance: none;
      -webkit-appearance: none;
      display: inline-block;
      position: relative;
      box-sizing: border-box;
      width: 1.05em;
      height: 1.05em;
      padding: 0;
      margin-top: 0;
      margin-bottom: 0;
      margin-left: 0;
      margin-right: 0.48em;
      border: 1.5px solid #8d96a8;
      border-radius: 4px;
      color: #ffffff;
      background: transparent;
      font-size: 0.82em;
      font-weight: 800;
      line-height: 1;
      vertical-align: -0.12em;
      cursor: pointer;
    }
    .task-list-checkbox.checked,
    .task-list-checkbox:checked {
      border-color: #0a84ff;
      background: #0a84ff;
    }
    .task-list-checkbox.checked::after,
    .task-list-checkbox:checked::after {
      content: "✓";
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -54%);
      color: #ffffff;
    }
    .task-list-checkbox:focus-visible {
      outline: 2px solid #0a84ff;
      outline-offset: 2px;
    }
    body.theme-dark .task-list-checkbox {
      border-color: #aeb6c7;
    }
    body.theme-dark .task-list-checkbox.checked,
    body.theme-dark .task-list-checkbox:checked {
      border-color: #76b7ff;
      background: #76b7ff;
      color: #111827;
    }
    body.theme-dark .task-list-checkbox.checked::after,
    body.theme-dark .task-list-checkbox:checked::after {
      color: #111827;
    }
    .markdown-callout {
      margin: 1em 0;
      padding: 0.82em 1em 0.82em 1.05em;
      border-left: 4px solid var(--callout-accent, #8d96a8);
      border-radius: 7px;
      color: inherit;
      background: color-mix(in srgb, var(--callout-accent, #8d96a8) 10%, transparent);
    }
    .markdown-callout::before {
      content: attr(data-callout-title);
      display: block;
      margin-bottom: 0.35em;
      color: var(--callout-accent, #59636e);
      font-size: 0.78em;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .markdown-callout > :first-child {
      margin-top: 0;
    }
    .markdown-callout > :last-child {
      margin-bottom: 0;
    }
    .markdown-callout-note { --callout-accent: #0a84ff; }
    .markdown-callout-tip { --callout-accent: #16a34a; }
    .markdown-callout-important { --callout-accent: #7c3aed; }
    .markdown-callout-warning { --callout-accent: #d97706; }
    .markdown-callout-caution { --callout-accent: #dc2626; }
    body.theme-dark .markdown-callout-note { --callout-accent: #76b7ff; }
    body.theme-dark .markdown-callout-tip { --callout-accent: #7ddf9a; }
    body.theme-dark .markdown-callout-important { --callout-accent: #c7a6ff; }
    body.theme-dark .markdown-callout-warning { --callout-accent: #ffc06e; }
    body.theme-dark .markdown-callout-caution { --callout-accent: #ff8f8f; }
    dl {
      margin: 1em 0;
    }
    dt {
      margin-top: 0.75em;
      font-weight: 800;
      color: inherit;
    }
    dd {
      margin: 0.2em 0 0.65em 1.35em;
      color: inherit;
    }
    dd > :first-child {
      margin-top: 0;
    }
    dd > :last-child {
      margin-bottom: 0;
    }
    .math-inline {
      white-space: nowrap;
    }
    .markdown-tag-chip {
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      padding: 0.12em 0.5em 0.15em;
      border: 1px solid rgba(127, 136, 151, 0.34);
      border-radius: 999px;
      color: #4f5b6d;
      background: rgba(127, 136, 151, 0.1);
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
      font-size: 0.78em;
      font-weight: 600;
      line-height: 1.25;
      vertical-align: 0.08em;
      white-space: nowrap;
    }
    .markdown-tag-chip::after {
      content: "×";
      margin-left: 0.36em;
      color: currentColor;
      opacity: 0.58;
      font-size: 0.95em;
      line-height: 1;
    }
    body.theme-dark .markdown-tag-chip {
      border-color: rgba(190, 198, 214, 0.24);
      color: #c2c9d6;
      background: rgba(190, 198, 214, 0.1);
    }
    .math-block {
      display: block;
      margin: 1em 0;
      padding: 0.85em 1em;
      overflow-x: auto;
      border-radius: 7px;
      background: rgba(127, 127, 145, 0.1);
      text-align: center;
    }
    .footnote-ref {
      font-size: 0.78em;
      line-height: 0;
    }
    .footnote-ref a,
    .footnote-backref {
      text-decoration: none;
    }
    .footnotes-sep {
      margin: 2em 0 0.9em;
      border: 0;
      border-top: 1px solid rgba(127, 127, 145, 0.35);
    }
    .footnotes {
      color: inherit;
      font-size: 0.9em;
    }
    .footnotes-list {
      padding-left: 1.35em;
    }
    .footnote-item:target {
      background: rgba(10, 132, 255, 0.12);
    }
    img {
      display: block;
      max-width: 100%;
      max-height: 360px;
      width: auto;
      height: auto;
      object-fit: contain;
    }
    .preview-empty-state {
      min-height: calc(100vh - 60px);
      display: grid;
      place-items: center;
      text-align: center;
      color: #7a8497;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
      font-size: 13px;
      line-height: 1.5;
    }
    .preview-empty-state strong {
      display: block;
      margin-bottom: 6px;
      color: #575d6b;
      font-size: 13px;
    }
    body.theme-dark .preview-empty-state {
      color: #aeb6c7;
    }
    body.theme-dark .preview-empty-state strong {
      color: #d3d7e0;
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
      ${katexCssText}
      body {
        box-sizing: border-box !important;
        padding: 14px 28px 32px 28px !important;
      }
      body > :first-child {
        margin-top: 0 !important;
      }
      .task-list-item {
        list-style: none;
        margin-left: -1.35em;
      }
      .task-list-checkbox {
        appearance: none;
        -webkit-appearance: none;
        display: inline-block;
        position: relative;
        box-sizing: border-box;
        width: 1.05em;
        height: 1.05em;
        padding: 0;
        margin-top: 0;
        margin-bottom: 0;
        margin-left: 0;
        margin-right: 0.48em;
        border: 1.5px solid #8d96a8;
        border-radius: 4px;
        color: #ffffff;
        background: transparent;
        font-size: 0.82em;
        font-weight: 800;
        line-height: 1;
        vertical-align: -0.12em;
        cursor: pointer;
      }
      .task-list-checkbox.checked,
      .task-list-checkbox:checked {
        border-color: #0a84ff;
        background: #0a84ff;
      }
      .task-list-checkbox.checked::after,
      .task-list-checkbox:checked::after {
        content: "✓";
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -54%);
        color: #ffffff;
      }
      .task-list-checkbox:focus-visible {
        outline: 2px solid #0a84ff;
        outline-offset: 2px;
      }
      body.theme-dark .task-list-checkbox {
        border-color: #aeb6c7;
      }
      body.theme-dark .task-list-checkbox.checked,
      body.theme-dark .task-list-checkbox:checked {
        border-color: #76b7ff;
        background: #76b7ff;
        color: #111827;
      }
      body.theme-dark .task-list-checkbox.checked::after,
      body.theme-dark .task-list-checkbox:checked::after {
        color: #111827;
      }
      .markdown-callout {
        margin: 1em 0;
        padding: 0.82em 1em 0.82em 1.05em;
        border-left: 4px solid var(--callout-accent, #8d96a8);
        border-radius: 7px;
        color: inherit;
        background: color-mix(in srgb, var(--callout-accent, #8d96a8) 10%, transparent);
      }
      .markdown-callout::before {
        content: attr(data-callout-title);
        display: block;
        margin-bottom: 0.35em;
        color: var(--callout-accent, #59636e);
        font-size: 0.78em;
        font-weight: 800;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .markdown-callout > :first-child {
        margin-top: 0;
      }
      .markdown-callout > :last-child {
        margin-bottom: 0;
      }
      .markdown-callout-note { --callout-accent: #0a84ff; }
      .markdown-callout-tip { --callout-accent: #16a34a; }
      .markdown-callout-important { --callout-accent: #7c3aed; }
      .markdown-callout-warning { --callout-accent: #d97706; }
      .markdown-callout-caution { --callout-accent: #dc2626; }
      body.theme-dark .markdown-callout-note { --callout-accent: #76b7ff; }
      body.theme-dark .markdown-callout-tip { --callout-accent: #7ddf9a; }
      body.theme-dark .markdown-callout-important { --callout-accent: #c7a6ff; }
      body.theme-dark .markdown-callout-warning { --callout-accent: #ffc06e; }
      body.theme-dark .markdown-callout-caution { --callout-accent: #ff8f8f; }
      dl {
        margin: 1em 0;
      }
      dt {
        margin-top: 0.75em;
        font-weight: 800;
        color: inherit;
      }
      dd {
        margin: 0.2em 0 0.65em 1.35em;
        color: inherit;
      }
      dd > :first-child {
        margin-top: 0;
      }
      dd > :last-child {
        margin-bottom: 0;
      }
      .math-inline {
        white-space: nowrap;
      }
      .markdown-tag-chip {
        display: inline-flex;
        align-items: center;
        max-width: 100%;
        padding: 0.12em 0.5em 0.15em;
        border: 1px solid rgba(127, 136, 151, 0.34);
        border-radius: 999px;
        color: #4f5b6d;
        background: rgba(127, 136, 151, 0.1);
        font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
        font-size: 0.78em;
        font-weight: 600;
        line-height: 1.25;
        vertical-align: 0.08em;
        white-space: nowrap;
      }
      .markdown-tag-chip::after {
        content: "×";
        margin-left: 0.36em;
        color: currentColor;
        opacity: 0.58;
        font-size: 0.95em;
        line-height: 1;
      }
      body.theme-dark .markdown-tag-chip {
        border-color: rgba(190, 198, 214, 0.24);
        color: #c2c9d6;
        background: rgba(190, 198, 214, 0.1);
      }
      .math-block {
        display: block;
        margin: 1em 0;
        padding: 0.85em 1em;
        overflow-x: auto;
        border-radius: 7px;
        background: rgba(127, 127, 145, 0.1);
        text-align: center;
      }
      .footnote-ref {
        font-size: 0.78em;
        line-height: 0;
      }
      .footnote-ref a,
      .footnote-backref {
        text-decoration: none;
      }
      .footnotes-sep {
        margin: 2em 0 0.9em;
        border: 0;
        border-top: 1px solid rgba(127, 127, 145, 0.35);
      }
      .footnotes {
        color: inherit;
        font-size: 0.9em;
      }
      .footnotes-list {
        padding-left: 1.35em;
      }
      .footnote-item:target {
        background: rgba(10, 132, 255, 0.12);
      }
      img {
        display: block;
        max-width: 100%;
        max-height: 360px;
        width: auto;
        height: auto;
        object-fit: contain;
      }
      .preview-empty-state {
        min-height: calc(100vh - 60px);
        display: grid;
        place-items: center;
        text-align: center;
        color: #7a8497;
        font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
        font-size: 13px;
        line-height: 1.5;
      }
      .preview-empty-state strong {
        display: block;
        margin-bottom: 6px;
        color: #575d6b;
        font-size: 13px;
      }
      body.theme-dark .preview-empty-state {
        color: #aeb6c7;
      }
      body.theme-dark .preview-empty-state strong {
        color: #d3d7e0;
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
    .task-list-item {
      list-style: none !important;
      margin-left: -1.35em !important;
    }
    .task-list-checkbox {
      appearance: none !important;
      -webkit-appearance: none !important;
      display: inline-block !important;
      position: relative !important;
      box-sizing: border-box !important;
      width: 1.05em !important;
      height: 1.05em !important;
      padding: 0 !important;
      margin-top: 0 !important;
      margin-bottom: 0 !important;
      margin-left: 0 !important;
      margin-right: 0.48em !important;
      border: 1.5px solid #8d96a8 !important;
      border-radius: 4px !important;
      color: #ffffff !important;
      background: transparent !important;
      font-size: 0.82em !important;
      font-weight: 800 !important;
      line-height: 1 !important;
      vertical-align: -0.12em !important;
      cursor: pointer !important;
    }
    .task-list-checkbox.checked,
    .task-list-checkbox:checked {
      border-color: #0a84ff !important;
      background: #0a84ff !important;
    }
    .task-list-checkbox.checked::after,
    .task-list-checkbox:checked::after {
      content: "✓" !important;
      position: absolute !important;
      left: 50% !important;
      top: 50% !important;
      transform: translate(-50%, -54%) !important;
      color: #ffffff !important;
    }
    .markdown-callout {
      margin: 1em 0 !important;
      padding: 0.82em 1em 0.82em 1.05em !important;
      border-left: 4px solid var(--callout-accent, #8d96a8) !important;
      border-radius: 7px !important;
      color: inherit !important;
      background: color-mix(in srgb, var(--callout-accent, #8d96a8) 10%, transparent) !important;
    }
    .markdown-callout::before {
      content: attr(data-callout-title) !important;
      display: block !important;
      margin-bottom: 0.35em !important;
      color: var(--callout-accent, #59636e) !important;
      font-size: 0.78em !important;
      font-weight: 800 !important;
      letter-spacing: 0.04em !important;
      text-transform: uppercase !important;
    }
    .markdown-callout > :first-child {
      margin-top: 0 !important;
    }
    .markdown-callout > :last-child {
      margin-bottom: 0 !important;
    }
    .markdown-callout-note { --callout-accent: #0a84ff; }
    .markdown-callout-tip { --callout-accent: #16a34a; }
    .markdown-callout-important { --callout-accent: #7c3aed; }
    .markdown-callout-warning { --callout-accent: #d97706; }
    .markdown-callout-caution { --callout-accent: #dc2626; }
    dl {
      margin: 1em 0 !important;
    }
    dt {
      margin-top: 0.75em !important;
      font-weight: 800 !important;
      color: inherit !important;
    }
    dd {
      margin: 0.2em 0 0.65em 1.35em !important;
      color: inherit !important;
    }
    dd > :first-child {
      margin-top: 0 !important;
    }
    dd > :last-child {
      margin-bottom: 0 !important;
    }
    .math-inline {
      white-space: nowrap !important;
    }
    .markdown-tag-chip {
      display: inline-flex !important;
      align-items: center !important;
      max-width: 100% !important;
      padding: 0.12em 0.5em 0.15em !important;
      border: 1px solid rgba(127, 136, 151, 0.34) !important;
      border-radius: 999px !important;
      color: #4f5b6d !important;
      background: rgba(127, 136, 151, 0.1) !important;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif !important;
      font-size: 0.78em !important;
      font-weight: 600 !important;
      line-height: 1.25 !important;
      vertical-align: 0.08em !important;
      white-space: nowrap !important;
    }
    .markdown-tag-chip::after {
      content: "×" !important;
      margin-left: 0.36em !important;
      color: currentColor !important;
      opacity: 0.58 !important;
      font-size: 0.95em !important;
      line-height: 1 !important;
    }
    .math-block {
      display: block !important;
      margin: 1em 0 !important;
      padding: 0.85em 1em !important;
      overflow-x: auto !important;
      border-radius: 7px !important;
      background: rgba(127, 127, 145, 0.1) !important;
      text-align: center !important;
    }
    .footnote-ref {
      font-size: 0.78em !important;
      line-height: 0 !important;
    }
    .footnote-ref a,
    .footnote-backref {
      text-decoration: none !important;
    }
    .footnotes-sep {
      margin: 2em 0 0.9em !important;
      border: 0 !important;
      border-top: 1px solid rgba(127, 127, 145, 0.35) !important;
    }
    .footnotes {
      color: inherit !important;
      font-size: 0.9em !important;
    }
    .footnotes-list {
      padding-left: 1.35em !important;
    }
    img {
      display: block !important;
      max-width: 100% !important;
      max-height: 320px !important;
      width: auto !important;
      height: auto !important;
      object-fit: contain !important;
    }
  `;

  return normalizeThemeCss(`${katexCssText}\n${baseThemeCss}\n${exportOverrides}`);
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

  const bodyElement = doc.body;
  const tempBody = doc.createElement('body');
  tempBody.setAttribute('contenteditable', 'true');
  tempBody.className = doc.body.className;
  tempBody.innerHTML = String(html || '').trim()
    ? html
    : '<div class="preview-empty-state" contenteditable="false"><div><strong>Preview appears here</strong><span>Start writing Markdown in the editor to see it rendered.</span></div></div>';

  morphdom(bodyElement, tempBody, {
    childrenOnly: true,
    onBeforeElUpdated: (fromEl) => {
      if (fromEl === doc.body) return true;
      if (fromEl === doc.activeElement && fromEl.isContentEditable) return false;
      return true;
    }
  });
  syncPreviewTaskCheckboxStates(doc);
  invalidatePreviewAnchorCache();
  updateThemeDebug();
}

function syncPreviewTaskCheckboxStates(doc = frame.contentDocument) {
  if (!doc) return;
  for (const checkbox of [...doc.querySelectorAll('.task-list-checkbox')]) {
    const checked = checkbox.hasAttribute('checked') || checkbox.classList.contains('checked');
    checkbox.checked = checked;
    checkbox.defaultChecked = checked;
    checkbox.classList.toggle('checked', checked);
  }
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

function mimeTypeForImagePath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.bmp') return 'image/bmp';
  return 'application/octet-stream';
}

function localImagePathFromSrc(src) {
  const raw = String(src || '').trim();
  if (!raw || raw.startsWith('data:')) return null;
  if (/^https?:\/\//i.test(raw)) return null;
  if (/^file:/i.test(raw)) {
    try {
      return fileURLToPath(raw);
    } catch {
      return null;
    }
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;

  const withoutFragment = raw.split('#')[0].split('?')[0];
  const decoded = decodeURIComponent(withoutFragment);
  const baseDir = currentFilePath ? path.dirname(currentFilePath) : process.cwd();
  return path.resolve(baseDir, decoded);
}

async function inlineLocalImagesForExport(doc) {
  if (!doc) return;
  const images = [...doc.querySelectorAll('img[src]')];
  for (const image of images) {
    const src = image.getAttribute('src');
    const localPath = localImagePathFromSrc(src);
    if (!localPath) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const bytes = await fs.readFile(localPath);
      image.setAttribute('src', `data:${mimeTypeForImagePath(localPath)};base64,${bytes.toString('base64')}`);
    } catch (error) {
      diagnosticLog('export.image.inline.failed', {
        src,
        path: localPath,
        error: String(error?.message || error || 'Unable to inline image')
      });
    }
  }
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
  const exportDoc = document.implementation.createHTMLDocument('export');
  exportDoc.body.innerHTML = html;
  await inlineLocalImagesForExport(exportDoc);
  if (MERMAID_ENABLED && html.includes('data-mermaid-block')) {
    await renderMermaidBlocksInDocument(exportDoc, { forExport: true });
  }
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
      pruneRawFolds();
      rawEditor.value = activeRawFolds.length > 0 ? buildRawEditorDisplay() : markdownState;
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
  scheduleMindmapRender();
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
  if (activeRawFolds.length > 0) {
    expandAllRawFolds();
    return;
  }
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
    const selectionEndsAtLineStart = end > start && text[end - 1] === '\n';
    const effectiveEnd = selectionEndsAtLineStart ? end - 1 : end;
    const lineEndIndex = text.indexOf('\n', effectiveEnd);
    const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
    const block = text.slice(lineStart, lineEnd);
    let changed = false;
    let firstDelta = 0;
    let totalDelta = 0;
    const updatedBlock = block
      .split('\n')
      .map((line, index) => {
        let updatedLine = line;
        if (increase) {
          updatedLine = `${MARKDOWN_INDENT}${line}`;
        } else if (line.startsWith('\t')) {
          updatedLine = line.slice(1);
        } else if (line.startsWith(MARKDOWN_INDENT)) {
          updatedLine = line.slice(MARKDOWN_INDENT.length);
        } else if (line.startsWith('  ')) {
          updatedLine = line.slice(2);
        } else if (line.startsWith(' ')) {
          updatedLine = line.slice(1);
        }
        const delta = updatedLine.length - line.length;
        if (delta !== 0) {
          changed = true;
          if (index === 0) firstDelta = delta;
          totalDelta += delta;
        }
        return updatedLine;
      })
      .join('\n');

    if (!changed) return null;

    const nextText = `${text.slice(0, lineStart)}${updatedBlock}${text.slice(lineEnd)}`;
    return {
      text: nextText,
      selectionStart: Math.max(lineStart, start + firstDelta),
      selectionEnd: Math.max(lineStart, end + totalDelta)
    };
  });
}

function formatCallout(type) {
  const normalized = String(type || '').toLowerCase();
  const title = CALLOUT_TYPES[normalized];
  if (!title) return;

  replaceSelectionInRaw(({ text, start, end, selected }) => {
    const body = selected && selected.trim().length > 0
      ? selected.replace(/\s+$/g, '')
      : `${title} text`;
    const quotedBody = body
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join('\n');
    const before = start > 0 && text[start - 1] !== '\n' ? '\n' : '';
    const after = end < text.length && text[end] !== '\n' ? '\n' : '';
    const replacement = `${before}> [!${normalized.toUpperCase()}]\n${quotedBody}${after}`;
    const nextText = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
    const bodyStart = start + before.length + `> [!${normalized.toUpperCase()}]\n> `.length;
    return {
      text: nextText,
      selectionStart: bodyStart,
      selectionEnd: bodyStart + body.length
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
    case 'format-callout':
      formatCallout('note');
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

function deriveMarkdownContinuationPrefix(lineToCaret) {
  const quoteMatch = String(lineToCaret || '').match(/^(\s*(?:>\s*)+)(.*)$/);
  const quotePrefix = quoteMatch ? quoteMatch[1] : '';
  const editablePart = quoteMatch ? quoteMatch[2] : String(lineToCaret || '');

  const taskMatch = editablePart.match(/^(\s*)([-*+]|\d+[.)])\s+\[([ xX])]\s+(.*)$/);
  if (taskMatch) {
    if (taskMatch[4].trim().length === 0) return null;
    const marker = /^\d/.test(taskMatch[2])
      ? `${Number.parseInt(taskMatch[2], 10) + 1}${taskMatch[2].endsWith(')') ? ')' : '.'}`
      : taskMatch[2];
    return `${quotePrefix}${taskMatch[1]}${marker} [ ] `;
  }

  const bulletMatch = editablePart.match(/^(\s*)([-*+])\s+(.*)$/);
  if (bulletMatch) {
    if (bulletMatch[3].trim().length === 0) return null;
    return `${quotePrefix}${bulletMatch[1]}${bulletMatch[2]} `;
  }

  const orderedMatch = editablePart.match(/^(\s*)(\d+)([.)])\s+(.*)$/);
  if (orderedMatch) {
    if (orderedMatch[4].trim().length === 0) return null;
    return `${quotePrefix}${orderedMatch[1]}${Number(orderedMatch[2]) + 1}${orderedMatch[3]} `;
  }

  if (quotePrefix && editablePart.trim().length > 0) {
    return quotePrefix.endsWith(' ') ? quotePrefix : `${quotePrefix} `;
  }

  return null;
}

function handleRawMarkdownContinuationKeydown(event) {
  if (!continuePrefixesEnabled) return false;
  if (event.key !== 'Enter') return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;

  const start = rawEditor.selectionStart ?? 0;
  const text = rawEditor.value;
  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const lineToCaret = text.slice(lineStart, start);
  const continuation = deriveMarkdownContinuationPrefix(lineToCaret);
  if (continuation === null) return false;

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
  return true;
}

function handleRawEditorKeydown(event) {
  if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    applyFormatAction(event.shiftKey ? 'format-decrease-indent' : 'format-increase-indent');
    return;
  }

  if (handleRawMarkdownContinuationKeydown(event)) return;
  handleRawListContinuationKeydown(event);
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

function setMarkdownProgrammatically(nextMarkdown, selectionStart = null, selectionEnd = null, options = {}) {
  const focusRaw = options.focusRaw !== false;
  activeRawFolds = [];
  rawFoldDisplayRows = [];
  suppressRawHandler = true;
  rawEditor.value = nextMarkdown;
  updateLineNumbers({ force: true });
  if (typeof selectionStart === 'number' && typeof selectionEnd === 'number') {
    rawEditor.setSelectionRange(selectionStart, selectionEnd);
  }
  if (focusRaw) {
    rawEditor.focus({ preventScroll: true });
  }
  suppressRawHandler = false;

  renderFromMarkdown(nextMarkdown);
  lastFindOptionsKey = '';
  activeFindMatchIndex = -1;
  syncRawSnapshot();
  updateDirtyFromState();
  publishSessionState();
}

function toggleTaskAtSourceLine(lineNumber) {
  const sourceLine = Number(lineNumber);
  if (!Number.isInteger(sourceLine) || sourceLine < 0) return false;

  const lines = markdownState.split('\n');
  if (sourceLine >= lines.length) return false;

  const match = lines[sourceLine].match(/^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])](\s+)/);
  if (!match) return false;

  const nextMarker = match[2].toLowerCase() === 'x' ? ' ' : 'x';
  lines[sourceLine] = `${match[1]}[${nextMarker}]${match[3]}${lines[sourceLine].slice(match[0].length)}`;
  const nextMarkdown = lines.join('\n');
  const selectionStart = rawEditor.selectionStart ?? 0;
  const selectionEnd = rawEditor.selectionEnd ?? selectionStart;

  rawUndoStack.push(captureRawSnapshot());
  if (rawUndoStack.length > 500) rawUndoStack.shift();
  rawRedoStack.length = 0;
  setMarkdownProgrammatically(nextMarkdown, selectionStart, selectionEnd, { focusRaw: false });
  return true;
}

function toggleTaskAtOrdinal(taskIndex) {
  const targetIndex = Number(taskIndex);
  if (!Number.isInteger(targetIndex) || targetIndex < 0) return false;

  const lines = markdownState.split('\n');
  let currentIndex = -1;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (!/^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])](\s+)/.test(lines[lineIndex])) continue;
    currentIndex += 1;
    if (currentIndex === targetIndex) {
      return toggleTaskAtSourceLine(lineIndex);
    }
  }
  return false;
}

function togglePreviewTaskCheckbox(target) {
  const checkbox = target?.closest?.('.task-list-checkbox');
  if (!checkbox) return false;
  const item = checkbox.closest('.task-list-item[data-line]');
  const line = item?.dataset.line ?? checkbox.dataset.line;
  if (toggleTaskAtSourceLine(Number(line))) return true;

  const doc = checkbox.ownerDocument;
  const taskCheckboxes = doc ? [...doc.querySelectorAll('.task-list-checkbox')] : [];
  return toggleTaskAtOrdinal(taskCheckboxes.indexOf(checkbox));
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
  currentFilePath = loaded.imported ? null : loaded.path;
  currentFileName = loaded.name || (loaded.path ? basename(loaded.path) : 'Untitled.md');
  docSessionKey = loaded.path || loaded.sourcePath || docSessionKey;
  markdownState = loaded.content;
  activeRawFolds = [];
  rawFoldDisplayRows = [];
  lastSavedAt = loaded.lastSavedAt || null;
  rawEditor.value = markdownState;
  updateLineNumbers({ force: true });

  renderFromMarkdown(markdownState);
  savedBaseline = loaded.imported ? '' : markdownState;
  rawUndoStack.length = 0;
  rawRedoStack.length = 0;
  syncRawSnapshot();
  setDirty(Boolean(loaded.imported));
  updateWindowTitle();
  publishSessionState();
}

async function loadFileFromDisk() {
  const canProceed = await confirmUnsavedChanges('loading another file');
  if (!canProceed) return;

  const loaded = await window.nativeApi.openFile();
  if (!loaded) return;

  applyLoadedDocument(loaded);
  await addRecentFile(loaded.sourcePath || loaded.path);
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
  await addRecentFile(loaded.sourcePath || loaded.path);
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
  await addRecentFile(loaded.sourcePath || loaded.path);
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
  activeRawFolds = [];
  rawFoldDisplayRows = [];
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

async function createNewDocumentUsingTemplate(template) {
  const templateContent = applyTemplateTokens(template?.content || '');
  await createNewDocument({
    initialContent: templateContent,
    markDirty: templateContent.length > 0
  });
}

async function createNewDocumentWithTemplatePreference() {
  const saved = await loadDefaultTemplate();
  if (!templatesEnabled) {
    await createNewDocument();
    return;
  }

  if (saved?.loaded) {
    await createNewDocumentUsingTemplate(saved);
    return;
  }

  const template = await window.nativeApi.chooseTemplateFile();
  if (!template?.path) return;
  await createNewDocumentUsingTemplate(template);
}

async function setDefaultTemplate() {
  const template = await window.nativeApi.chooseTemplateFile();
  if (!template?.path) return;
  templatesEnabled = true;
  await window.nativeApi.saveDefaultTemplatePreference({ path: template.path, enabled: templatesEnabled });
  defaultTemplatePath = template.path;
  updateMenuChecks();
  notifyNativeMenuState();
  const name = template.name || basename(template.path);
  window.alert(`Default template set to "${name}".`);
}

async function resetDefaultTemplate() {
  await window.nativeApi.saveDefaultTemplatePreference({ path: null, enabled: templatesEnabled });
  defaultTemplatePath = null;
  window.alert('Default template has been reset.');
}

async function setTemplatesEnabled(enabled, options = {}) {
  const persist = options.persist !== false;
  templatesEnabled = enabled === true;
  updateMenuChecks();
  notifyNativeMenuState();
  if (persist) {
    await window.nativeApi.saveDefaultTemplatePreference({ path: defaultTemplatePath, enabled: templatesEnabled });
  }
}

async function loadDefaultTemplate() {
  const saved = await window.nativeApi.loadDefaultTemplatePreference();
  templatesEnabled = saved?.enabled === true;
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

async function setDefaultSaveFolder() {
  const result = await window.nativeApi.chooseDefaultSaveFolder();
  if (!result?.saved) return;
  window.alert(`Default save folder set to "${result.name || result.path}".`);
}

async function resetDefaultSaveFolder() {
  const result = await window.nativeApi.resetDefaultSaveFolder();
  if (result?.saved) {
    window.alert('Default save folder has been reset.');
  }
}

function applyMovedCurrentFile(result) {
  currentFilePath = result.path;
  currentFileName = result.name || basename(result.path);
  docSessionKey = currentFilePath || docSessionKey;
  updateWindowTitle();
  publishSessionState();
  void refreshRecentFilesMenu();
}

async function moveFilePath(filePath, options = {}) {
  if (!filePath) return null;
  const result = await window.nativeApi.moveFile({ path: filePath });
  if (!result?.moved) {
    if (result?.error) window.alert(`Move failed: ${result.error}`);
    return null;
  }
  if (options.updateCurrent || filePath === currentFilePath) {
    applyMovedCurrentFile(result);
    await addRecentFile(result.path);
  }
  await refreshNotesTree();
  return result;
}

async function moveCurrentFile() {
  if (!currentFilePath) {
    window.alert('Save the document before moving it.');
    return;
  }
  if (isDirty) {
    const saved = await saveCurrentFile(false);
    if (!saved) return;
  }
  await moveFilePath(currentFilePath, { updateCurrent: true });
}

async function duplicateFilePath(filePath) {
  if (!filePath) return null;
  const result = await window.nativeApi.duplicateFile({ path: filePath });
  if (!result?.duplicated) {
    if (result?.error) window.alert(`Duplicate failed: ${result.error}`);
    return null;
  }
  await refreshNotesTree();
  return result;
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
    path: saveAs ? (currentFilePath || currentFileName) : currentFilePath,
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
  closeCalloutMenu();
  closeNotesTreeSortMenu();
  closeNotesTreeContextMenu();
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
      await createNewDocumentWithTemplatePreference();
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
    case 'toggle-templates-enabled':
      await setTemplatesEnabled(!templatesEnabled);
      break;
    case 'set-templates-enabled':
      await setTemplatesEnabled(Boolean(payload.enabled));
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
    case 'file-set-default-save-folder':
      await setDefaultSaveFolder();
      break;
    case 'file-reset-default-save-folder':
      await resetDefaultSaveFolder();
      break;
    case 'file-move-current':
      await moveCurrentFile();
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
    case 'save-folder-emoji':
      saveFolderEmojiFromEditor();
      break;
    case 'clear-folder-emoji':
      saveFolderEmojiFromEditor({ clear: true });
      break;
    case 'close-folder-emoji':
      closeFolderEmojiEditor();
      break;
    case 'restore-session':
      if (payload?.state) {
        applySessionState(payload.state);
      }
      break;
    case 'open-command-palette':
      openCommandPalette();
      break;
    case 'show-callout-menu':
      toggleCalloutMenu(payload?.trigger);
      return;
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
    case 'format-callout':
      formatCallout(payload?.callout || 'note');
      break;

    case 'mode-raw':
      setViewVisibility(true, false, false);
      break;
    case 'mode-formatted':
      setViewVisibility(false, true, false);
      break;
    case 'mode-split':
      setViewVisibility(true, true, false);
      break;
    case 'toggle-raw-view':
      setViewVisibility(payload.enabled ?? !showRaw, showFormatted, showMindmap);
      break;
    case 'toggle-formatted-view':
      setViewVisibility(showRaw, payload.enabled ?? !showFormatted, showMindmap);
      break;
    case 'toggle-mindmap-view':
      setMindmapVisible(payload.enabled ?? !showMindmap);
      break;
    case 'set-mindmap-view':
      setMindmapVisible(Boolean(payload.enabled));
      break;
    case 'set-mindmap-layout':
      setMindmapLayout(payload.layout);
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
    case 'zoom-mindmap-in':
      mindmapView.zoomBy(0.12);
      break;
    case 'zoom-mindmap-out':
      mindmapView.zoomBy(-0.12);
      break;
    case 'zoom-mindmap-reset':
      mindmapView.resetZoom();
      break;
    case 'zoom-mindmap-fit':
      mindmapView.fitToView();
      break;
    case 'zoom-notes-tree-in':
      setNotesTreeZoom(notesTreeZoom + 0.1);
      break;
    case 'zoom-notes-tree-out':
      setNotesTreeZoom(notesTreeZoom - 0.1);
      break;
    case 'zoom-notes-tree-reset':
      setNotesTreeZoom(1);
      break;
    case 'export-mindmap-svg':
      await mindmapView.exportSvg();
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
    case 'toggle-collapsible-text':
      setCollapsibleTextEnabled(!collapsibleTextEnabled);
      break;
    case 'set-collapsible-text':
      setCollapsibleTextEnabled(Boolean(payload.enabled));
      break;
    case 'toggle-continue-prefixes':
      setContinuePrefixesEnabled(!continuePrefixesEnabled);
      break;
    case 'set-continue-prefixes':
      setContinuePrefixesEnabled(Boolean(payload.enabled));
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
    case 'toggle-notes-tree-view':
      setNotesTreeVisible(!notesTreeVisible);
      break;
    case 'set-notes-tree-view':
      setNotesTreeVisible(Boolean(payload.enabled));
      break;
    case 'notes-tree-left':
      setNotesTreePosition('left');
      break;
    case 'notes-tree-right':
      setNotesTreePosition('right');
      break;
    case 'set-notes-tree-position':
      if (payload.position === 'left' || payload.position === 'right') {
        setNotesTreePosition(payload.position);
      }
      break;
    case 'toggle-notes-tree-rainbow':
      setNotesTreeRainbowFolders(!notesTreeRainbowFolders);
      break;
    case 'set-notes-tree-rainbow':
      setNotesTreeRainbowFolders(Boolean(payload.enabled));
      break;
    case 'choose-notes-tree-root':
      await chooseNotesTreeRoot();
      break;
    case 'refresh-notes-tree':
      await refreshNotesTree();
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
    if (
      !target.closest('.menu-group')
      && !target.closest('#callout-menu')
      && !target.closest('#notes-tree-sort-menu')
      && !target.closest('#notes-tree-context-menu')
      && !target.closest('[data-action="show-callout-menu"]')
      && !target.closest('[data-action="show-notes-tree-sort-menu"]')
    ) {
      closeAllMenus();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAllMenus();
  });

  for (const button of actionButtons) {
    button.addEventListener('click', () => {
      const action = button.getAttribute('data-action');
      if (action) {
        const payload = {};
        if (button.dataset.preset) payload.preset = button.dataset.preset;
        if (button.dataset.mode) payload.mode = button.dataset.mode;
        if (button.dataset.layout) payload.layout = button.dataset.layout;
        if (button.dataset.callout) payload.callout = button.dataset.callout;
        payload.trigger = button;
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

  if (notesTreePane) {
    notesTreePane.addEventListener('contextmenu', (event) => {
      const row = event.target.closest('.notes-tree-row[data-type="file"][data-path]');
      if (!row) return;
      event.preventDefault();
      openNotesTreeContextMenu(row.dataset.path, event.clientX, event.clientY);
    });

    notesTreePane.addEventListener('click', (event) => {
      const target = event.target;
      const button = target.closest('button[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      const filePath = button.dataset.path || '';

      if (action === 'toggle-notes-tree-folder') {
        if (notesTreeExpandedPaths.has(filePath)) notesTreeExpandedPaths.delete(filePath);
        else notesTreeExpandedPaths.add(filePath);
        renderNotesTree();
        return;
      }

      if (action === 'open-notes-tree-file') {
        void loadFileByPath(filePath, 'opening a note from the notes tree');
        return;
      }

      if (action === 'set-notes-tree-folder-emoji') {
        openFolderEmojiEditor(filePath);
        return;
      }

      if (action === 'show-notes-tree-sort-menu') {
        toggleNotesTreeSortMenu(button);
        return;
      }

      void handleAction(action);
    });
  }

  if (notesTreeSortMenu) {
    notesTreeSortMenu.addEventListener('click', (event) => {
      const target = event.target;
      const button = target.closest('button[data-action]');
      if (!button) return;
      const group = button.dataset.group;
      if (button.dataset.action === 'set-notes-tree-sort-field') {
        void setNotesTreeSort(group, { field: button.dataset.field });
        return;
      }
      if (button.dataset.action === 'set-notes-tree-sort-direction') {
        void setNotesTreeSort(group, { direction: button.dataset.direction });
      }
    });
  }

  if (notesTreeContextMenu) {
    notesTreeContextMenu.addEventListener('click', (event) => {
      const target = event.target;
      const button = target.closest('button[data-action]');
      if (!button || !activeNotesTreeContextPath) return;
      const filePath = activeNotesTreeContextPath;
      closeNotesTreeContextMenu();
      if (button.dataset.action === 'move-notes-tree-file') {
        void moveFilePath(filePath);
        return;
      }
      if (button.dataset.action === 'duplicate-notes-tree-file') {
        void duplicateFilePath(filePath);
      }
    });
  }

  if (folderEmojiInput) {
    folderEmojiInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveFolderEmojiFromEditor();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeFolderEmojiEditor();
      }
    });
  }

  if (notesTreeResizer) {
    notesTreeResizer.addEventListener('pointerdown', beginNotesTreeResize);
  }

  mindmapView.wireEvents();
  paneLayout.wire();

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
      if (keybindingsModal && !keybindingsModal.classList.contains('hidden')) {
        event.preventDefault();
        closeKeybindingsModal();
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

function bindPreviewDocumentEvents(doc) {
  if (!doc || boundPreviewDocuments.has(doc)) return;
  boundPreviewDocuments.add(doc);

  doc.body.addEventListener('focus', () => {
    lastFocusedEditor = 'formatted';
  });
  doc.body.addEventListener('keydown', (event) => {
    if ((event.key === ' ' || event.key === 'Enter') && togglePreviewTaskCheckbox(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!showFormatted) return;
    applyHeadingShortcutInFormatted(event);
  });
  const handlePreviewTaskToggleEvent = (event) => {
    if (!togglePreviewTaskCheckbox(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  doc.addEventListener('click', (event) => {
    handlePreviewTaskToggleEvent(event);
  }, true);
  doc.addEventListener('change', (event) => {
    handlePreviewTaskToggleEvent(event);
  }, true);
  doc.addEventListener('input', (event) => {
    if (!event.target?.closest?.('.task-list-checkbox')) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  doc.body.addEventListener('input', (event) => {
    if (event.target?.closest?.('.task-list-checkbox')) return;
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
}

function wireEvents() {
  window.addEventListener('resize', () => {
    invalidatePreviewAnchorCache();
    updateLineNumbers({ force: true });
    applyNotesTreeWidth();
  });
  if (typeof ResizeObserver !== 'undefined') {
    const rawEditorResizeObserver = new ResizeObserver(() => {
      updateLineNumbers({ force: true });
    });
    rawEditorResizeObserver.observe(rawEditor);
  }

  rawEditor.addEventListener('input', handleRawEdit);
  rawEditor.addEventListener('beforeinput', (event) => {
    if (activeRawFolds.length === 0) return;
    event.preventDefault();
    expandAllRawFolds();
  });
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
  if (rawFoldList) {
    rawFoldList.addEventListener('click', (event) => {
      const button = event.target.closest('.raw-fold-row[data-fold-key]');
      if (!button) return;
      const region = discoverRawFoldRegions(markdownState).find((candidate) => candidate.key === button.dataset.foldKey);
      toggleRawFold(region);
    });
  }
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
  rawEditor.addEventListener('keydown', handleRawEditorKeydown);
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
    bindPreviewDocumentEvents(doc);
    schedulePreviewScrollSync();
    updateThemeDebug();
  });
  bindPreviewDocumentEvents(frame.contentDocument);

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
    keybindingsList.addEventListener('change', (event) => {
      const target = event.target;
      const input = target.closest?.('input[data-action]');
      if (!input) return;
      void saveKeybindingsFromEditor();
    });
    keybindingsList.addEventListener('keydown', (event) => {
      const target = event.target;
      const input = target.closest('input[data-action]');
      if (!input) return;
      const combo = comboFromKeyboardEvent(event);
      if (!combo) return;
      event.preventDefault();
      input.value = combo;
    });
  }

  if (settingsRibbonDisplay) {
    settingsRibbonDisplay.addEventListener('change', () => setRibbonMode(settingsRibbonDisplay.value));
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
    settingsEditorFont.addEventListener('change', () => setEditorFont(settingsEditorFont.value));
  }
  if (settingsWordWrap) {
    settingsWordWrap.addEventListener('change', () => setWordWrapEnabled(settingsWordWrap.checked));
  }
  if (settingsLineNumbers) {
    settingsLineNumbers.addEventListener('change', () => setLineNumbersEnabled(settingsLineNumbers.checked));
  }
  if (settingsContinuePrefixes) {
    settingsContinuePrefixes.addEventListener('change', () => setContinuePrefixesEnabled(settingsContinuePrefixes.checked));
  }
  if (settingsCollapsibleText) {
    settingsCollapsibleText.addEventListener('change', () => setCollapsibleTextEnabled(settingsCollapsibleText.checked));
  }
  if (settingsSpellcheck) {
    settingsSpellcheck.addEventListener('change', () => {
      setSpellcheckEnabled(settingsSpellcheck.checked);
      renderSettingsControls();
    });
  }
  if (settingsDictionary) {
    settingsDictionary.addEventListener('change', () => {
      void setDictionaryLanguage(settingsDictionary.value);
    });
  }
  if (settingsMermaidPreview) {
    settingsMermaidPreview.addEventListener('change', () => setMermaidPreviewEnabled(settingsMermaidPreview.checked));
  }
  if (settingsThemeDebug) {
    settingsThemeDebug.addEventListener('change', () => setThemeDebugVisible(settingsThemeDebug.checked));
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
      updateMenuChecks();
      notifyNativeMenuState();
      if (templatesEnabled && defaultTemplate?.loaded) {
        const templateContent = applyTemplateTokens(defaultTemplate.content || '');
        markdownState = templateContent;
        activeRawFolds = [];
        rawFoldDisplayRows = [];
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

    const savedSyncViews = await loadSyncViewsPreference();
    setSyncViewsEnabled(savedSyncViews, { persist: false });
    diagnosticLog('renderer.startup.sync-views.loaded', { enabled: savedSyncViews });

    const savedWordWrap = await loadWordWrapPreference();
    setWordWrapEnabled(savedWordWrap, { persist: false });
    diagnosticLog('renderer.startup.word-wrap.loaded', { enabled: savedWordWrap });

    const savedLineNumbers = await loadLineNumbersPreference();
    setLineNumbersEnabled(savedLineNumbers, { persist: false });
    diagnosticLog('renderer.startup.line-numbers.loaded', { enabled: savedLineNumbers });

    const savedCollapsibleText = await loadCollapsibleTextPreference();
    setCollapsibleTextEnabled(savedCollapsibleText, { persist: false });
    diagnosticLog('renderer.startup.collapsible-text.loaded', { enabled: savedCollapsibleText });

    const savedContinuePrefixes = await loadContinuePrefixesPreference();
    setContinuePrefixesEnabled(savedContinuePrefixes, { persist: false });
    diagnosticLog('renderer.startup.continue-prefixes.loaded', { enabled: savedContinuePrefixes });

    const savedMindmap = await loadMindmapPreference();
    setMindmapLayout(savedMindmap.layout, { persist: false });
    setMindmapVisible(savedMindmap.enabled, { persist: false });
    diagnosticLog('renderer.startup.mindmap.loaded', savedMindmap);

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

    const savedNotesTree = await loadNotesTreePreference();
    notesTreeRootPath = savedNotesTree.rootPath;
    notesTreeFolderEmojis = savedNotesTree.folderEmojis;
    notesTreeSort = savedNotesTree.sort;
    notesTreeRainbowFolders = savedNotesTree.rainbowFolders;
    notesTreeZoom = savedNotesTree.zoom;
    notesTreeWidth = savedNotesTree.width;
    applyNotesTreeZoom();
    if (notesTreeRootPath) notesTreeExpandedPaths.add(notesTreeRootPath);
    setNotesTreePosition(savedNotesTree.position, { persist: false });
    setNotesTreeVisible(savedNotesTree.visible, { persist: false });
    await refreshNotesTree();
    diagnosticLog('renderer.startup.notes-tree.loaded', savedNotesTree);

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

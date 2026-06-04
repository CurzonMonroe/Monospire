import { autocompletion, closeBrackets } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import {
  bracketMatching,
  codeFolding,
  defaultHighlightStyle,
  foldGutter,
  foldService,
  syntaxHighlighting
} from '@codemirror/language';
import { highlightSelectionMatches } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  MatchDecorator,
  placeholder,
  ViewPlugin,
  WidgetType
} from '@codemirror/view';

function discoverFoldRange(state, sourceLineIndex) {
  const lineCount = state.doc.lines;
  const line = state.doc.line(sourceLineIndex + 1);
  const lineText = line.text || '';

  if (sourceLineIndex === 0 && lineText === '---') {
    for (let index = 2; index <= lineCount; index += 1) {
      const candidate = state.doc.line(index);
      if (candidate.text === '---') {
        if (candidate.number > line.number) return { from: line.to, to: candidate.to };
        return null;
      }
    }
    return null;
  }

  const headingMatch = /^(#{1,6})\s+\S/.exec(lineText);
  if (!headingMatch) return null;

  const level = headingMatch[1].length;
  let endLine = lineCount;
  for (let index = line.number + 1; index <= lineCount; index += 1) {
    const candidate = state.doc.line(index);
    const nextHeading = /^(#{1,6})\s+\S/.exec(candidate.text || '');
    if (nextHeading && nextHeading[1].length <= level) {
      endLine = candidate.number - 1;
      break;
    }
  }

  if (endLine <= line.number) return null;
  return { from: line.to, to: state.doc.line(endLine).to };
}

function monospireFoldService(state, lineStart) {
  const line = state.doc.lineAt(lineStart);
  return discoverFoldRange(state, line.number - 1);
}

function isInlineMarkdownTagMatch(match, view, pos) {
  const line = view.state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  if (before.endsWith('\\')) return false;
  if (/[A-Za-z0-9_/-]$/.test(before)) return false;
  const tag = match[1] || match[2] || '';
  return /[A-Za-z0-9]/.test(tag);
}

const markdownTagDecoration = Decoration.mark({
  class: 'cm-markdown-tag'
});

const markdownTagMatcher = new MatchDecorator({
  regexp: /#([A-Za-z0-9][A-Za-z0-9_/-]*[A-Za-z0-9])|#([A-Za-z0-9])/g,
  decorate(add, from, to, match, view) {
    if (!isInlineMarkdownTagMatch(match, view, from)) return;
    add(from, to, markdownTagDecoration);
  },
  boundary: /[\s()[\]{}<>`"'.,;:!?]/
});

const markdownTagHighlighter = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = markdownTagMatcher.createDeco(view);
  }

  update(update) {
    this.decorations = markdownTagMatcher.updateDeco(update, this.decorations);
  }
}, {
  decorations: (plugin) => plugin.decorations
});

class MetadataSeparatorWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-metadata-separator';
    span.textContent = '';
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

const metadataBlockLineDecoration = Decoration.line({ class: 'cm-metadata-line' });
const metadataContinuationLineDecoration = Decoration.line({ class: 'cm-metadata-line cm-metadata-continuation-line' });
const metadataDelimiterLineDecoration = Decoration.line({ class: 'cm-metadata-delimiter-line' });
const metadataKeyDecoration = Decoration.mark({ class: 'cm-metadata-key' });
const metadataValueDecoration = Decoration.mark({ class: 'cm-metadata-value' });
const metadataSeparatorDecoration = Decoration.replace({
  widget: new MetadataSeparatorWidget(),
  inclusive: false
});

function buildMetadataDecorations(view) {
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  if (doc.lines < 3 || doc.line(1).text.trim() !== '---') {
    return builder.finish();
  }

  let endLine = 0;
  for (let number = 2; number <= doc.lines; number += 1) {
    if (doc.line(number).text.trim() === '---') {
      endLine = number;
      break;
    }
  }
  if (endLine <= 2) return builder.finish();

  for (let number = 1; number <= endLine; number += 1) {
    const line = doc.line(number);
    const delimiter = number === 1 || number === endLine;
    if (delimiter) {
      builder.add(line.from, line.from, metadataDelimiterLineDecoration);
      continue;
    }

    const match = /^([A-Za-z0-9_-]+)(\s*:\s*)(.*)$/.exec(line.text);
    if (!match) {
      if (line.text.trim()) {
        builder.add(line.from, line.from, metadataContinuationLineDecoration);
        builder.add(line.from, line.to, metadataValueDecoration);
      }
      continue;
    }
    builder.add(line.from, line.from, metadataBlockLineDecoration);
    const keyStart = line.from;
    const keyEnd = keyStart + match[1].length;
    const separatorStart = keyEnd;
    const separatorEnd = separatorStart + match[2].length;
    const valueStart = separatorEnd;
    const valueEnd = line.to;

    builder.add(keyStart, keyEnd, metadataKeyDecoration);
    builder.add(separatorStart, separatorEnd, metadataSeparatorDecoration);
    if (valueEnd > valueStart) {
      builder.add(valueStart, valueEnd, metadataValueDecoration);
    }
  }

  return builder.finish();
}

const metadataHighlighter = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = buildMetadataDecorations(view);
  }

  update(update) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildMetadataDecorations(update.view);
    }
  }
}, {
  decorations: (plugin) => plugin.decorations
});

function buildBaseTheme() {
  return EditorView.theme({
    '&': {
      height: '100%',
      width: '100%',
      minWidth: '0',
      minHeight: '0',
      color: 'var(--text)',
      backgroundColor: 'var(--surface)',
      fontSize: 'var(--raw-editor-font-size, 14px)'
    },
    '.cm-scroller': {
      fontFamily: "var(--raw-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace)",
      lineHeight: '1.6',
      overflow: 'auto'
    },
    '.cm-content': {
      minHeight: '100%',
      padding: '20px',
      caretColor: 'var(--text)',
      tabSize: '3'
    },
    '.cm-line': {
      padding: '0'
    },
    '.cm-placeholder': {
      color: '#8f9bae',
      opacity: '1',
      fontWeight: '600'
    },
    '.cm-gutters': {
      backgroundColor: '#f5f6fa',
      color: '#8d96a6',
      borderRight: '1px solid var(--chrome-border)'
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 10px 0 8px'
    },
    '.cm-foldGutter .cm-gutterElement': {
      width: '22px',
      padding: '0',
      color: '#667085',
      textAlign: 'center',
      fontWeight: '700',
      opacity: '0.72',
      cursor: 'default'
    },
    '.cm-foldGutter .cm-gutterElement:hover': {
      color: 'var(--blue)',
      opacity: '1'
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(10, 132, 255, 0.055)'
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(10, 132, 255, 0.08)',
      color: 'var(--text)'
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(10, 132, 255, 0.28)'
    },
    '.cm-markdown-tag': {
      display: 'inline-block',
      padding: '0.08em 0.58em',
      margin: '0 0.08em',
      borderRadius: '999px',
      border: '1px solid rgba(84, 96, 117, 0.38)',
      backgroundColor: '#eef2f7',
      boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.72)',
      color: '#334155',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
      fontSize: '0.86em',
      fontWeight: '700',
      letterSpacing: '0',
      lineHeight: '1.35',
      verticalAlign: '0.05em'
    },
    '.cm-metadata-line': {
      display: 'grid',
      gridTemplateColumns: '8.75em minmax(0, 1fr)',
      columnGap: '1em',
      alignItems: 'start',
      backgroundColor: '#f7f8fb',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
      whiteSpace: 'pre-wrap'
    },
    '.cm-metadata-continuation-line': {
      display: 'block',
      paddingLeft: '9.75em'
    },
    '.cm-metadata-delimiter-line': {
      color: '#9aa4b5',
      backgroundColor: '#f7f8fb'
    },
    '.cm-metadata-key': {
      gridColumn: '1',
      gridRow: '1',
      alignSelf: 'start',
      display: 'block',
      minWidth: '0',
      color: '#7a8190',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
      fontWeight: '650',
      lineHeight: '1.35',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    },
    '.cm-metadata-separator': {
      display: 'none'
    },
    '.cm-metadata-value': {
      gridColumn: '2',
      gridRow: '1',
      alignSelf: 'start',
      display: 'block',
      minWidth: '0',
      color: '#2d333d',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
      fontWeight: '520',
      lineHeight: '1.35',
      overflowWrap: 'anywhere'
    },
    '&.cm-focused': {
      outline: 'none'
    }
  });
}

function buildDarkTheme() {
  return EditorView.theme({
    '&': {
      color: '#e6eaf2',
      backgroundColor: '#1b1f27'
    },
    '.cm-content': {
      caretColor: '#f3f6fd'
    },
    '.cm-gutters': {
      backgroundColor: '#171b22',
      color: '#8d96a6',
      borderRightColor: '#303744'
    },
    '.cm-foldGutter .cm-gutterElement': {
      color: '#9aa4b5'
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(118, 183, 255, 0.08)'
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(118, 183, 255, 0.1)',
      color: '#f3f6fd'
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(118, 183, 255, 0.32)'
    },
    '.cm-markdown-tag': {
      borderColor: 'rgba(194, 202, 218, 0.28)',
      backgroundColor: '#303641',
      boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.08)',
      color: '#dbe3f0'
    },
    '.cm-metadata-line': {
      backgroundColor: '#242424'
    },
    '.cm-metadata-delimiter-line': {
      color: '#6f7784',
      backgroundColor: '#242424'
    },
    '.cm-metadata-key': {
      color: '#a0a0a0'
    },
    '.cm-metadata-value': {
      color: '#e0e0e0'
    }
  }, { dark: true });
}

function createMarkdownEditor(host, options = {}) {
  const lineNumbersCompartment = new Compartment();
  const foldCompartment = new Compartment();
  const wrapCompartment = new Compartment();
  const themeCompartment = new Compartment();
  const spellcheckCompartment = new Compartment();

  const listeners = new Map();
  let isFocused = false;

  const emit = (type, event = new Event(type)) => {
    const callbacks = listeners.get(type);
    if (!callbacks) return;
    for (const callback of [...callbacks]) callback(event);
  };

  const lineNumberExtension = (enabled) => enabled ? lineNumbers() : [];
  const foldExtension = (enabled) => enabled
    ? [
        codeFolding({ placeholderText: '...' }),
        foldService.of(monospireFoldService),
        foldGutter({
          markerDOM(open) {
            const marker = document.createElement('span');
            marker.textContent = open ? '▾' : '▸';
            marker.setAttribute('aria-hidden', 'true');
            return marker;
          }
        })
      ]
    : [];
  const wrapExtension = (enabled) => enabled ? EditorView.lineWrapping : [];
  const themeExtension = (dark) => dark ? buildDarkTheme() : [];
  const spellcheckExtension = (enabled) => EditorView.contentAttributes.of({
    spellcheck: enabled ? 'true' : 'false',
    autocapitalize: 'off',
    autocomplete: 'off',
    autocorrect: 'off',
    'aria-label': options.ariaLabel || 'Raw Markdown editor'
  });

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: options.doc || '',
      extensions: [
        history(),
        highlightSpecialChars(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        highlightSelectionMatches(),
        metadataHighlighter,
        markdownTagHighlighter,
        placeholder(options.placeholder || ''),
        buildBaseTheme(),
        lineNumbersCompartment.of(lineNumberExtension(Boolean(options.lineNumbers))),
        foldCompartment.of(foldExtension(Boolean(options.collapsibleText))),
        wrapCompartment.of(wrapExtension(Boolean(options.wordWrap))),
        themeCompartment.of(themeExtension(Boolean(options.darkMode))),
        spellcheckCompartment.of(spellcheckExtension(options.spellcheck !== false)),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emit('input');
          if (update.selectionSet || update.docChanged) emit('selectionchange');
        }),
        EditorView.domEventHandlers({
          focus() {
            isFocused = true;
            emit('focus');
          },
          blur() {
            isFocused = false;
            emit('blur');
          },
          keyup(event) {
            emit('keyup', event);
          },
          click(event) {
            emit('click', event);
          },
          paste(event) {
            emit('paste', event);
          },
          dragover(event) {
            emit('dragover', event);
          },
          dragleave(event) {
            emit('dragleave', event);
          },
          drop(event) {
            emit('drop', event);
          },
          beforeinput(event) {
            emit('beforeinput', event);
          }
        })
      ]
    })
  });

  view.scrollDOM.addEventListener('scroll', (event) => emit('scroll', event), { passive: true });
  view.contentDOM.addEventListener('keydown', (event) => emit('keydown', event), true);

  const dispatchFullDocument = (text) => {
    const next = String(text ?? '');
    const current = view.state.doc.toString();
    if (next === current) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: next },
      selection: EditorSelection.cursor(Math.min(next.length, view.state.selection.main.from))
    });
  };

  const scrollToPosition = (position, y = 'center') => {
    view.dispatch({
      effects: EditorView.scrollIntoView(Math.max(0, Math.min(position, view.state.doc.length)), { y })
    });
  };

  const api = {
    element: host,
    view,
    classList: host.classList,
    style: host.style,
    get value() {
      return view.state.doc.toString();
    },
    set value(next) {
      dispatchFullDocument(next);
    },
    get selectionStart() {
      return view.state.selection.main.from;
    },
    get selectionEnd() {
      return view.state.selection.main.to;
    },
    get scrollTop() {
      return view.scrollDOM.scrollTop;
    },
    set scrollTop(next) {
      view.scrollDOM.scrollTop = Math.max(0, Number(next) || 0);
    },
    get scrollHeight() {
      return view.scrollDOM.scrollHeight;
    },
    get clientHeight() {
      return view.scrollDOM.clientHeight;
    },
    get clientWidth() {
      return view.dom.clientWidth;
    },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) {
      listeners.get(type)?.delete(callback);
    },
    focus(options) {
      view.focus();
      if (options?.preventScroll) return;
      scrollToPosition(view.state.selection.main.head);
    },
    select() {
      view.dispatch({ selection: EditorSelection.range(0, view.state.doc.length) });
      view.focus();
    },
    setSelectionRange(start, end = start) {
      const docLength = view.state.doc.length;
      const from = Math.max(0, Math.min(Number(start) || 0, docLength));
      const to = Math.max(0, Math.min(Number(end) || from, docLength));
      view.dispatch({ selection: EditorSelection.range(from, to) });
    },
    replaceSelection(insertText) {
      const selection = view.state.selection.main;
      const insert = String(insertText ?? '');
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert },
        selection: EditorSelection.cursor(selection.from + insert.length)
      });
    },
    scrollToPosition,
    linePositionFromScrollTop(scrollTop) {
      const block = view.lineBlockAtHeight(Math.max(0, scrollTop || 0));
      const line = view.state.doc.lineAt(block.from);
      const nextLine = line.number < view.state.doc.lines ? view.state.doc.line(line.number + 1) : null;
      const nextBlock = nextLine ? view.lineBlockAt(nextLine.from) : null;
      const start = block.top;
      const end = nextBlock ? nextBlock.top : Math.max(start + 1, block.bottom);
      return {
        line: line.number - 1,
        progress: Math.max(0, Math.min(1, ((scrollTop || 0) - start) / Math.max(1, end - start)))
      };
    },
    scrollTopForLinePosition(line, progress = 0) {
      const lineNumber = Math.max(1, Math.min(view.state.doc.lines, Math.floor(line || 0) + 1));
      const currentLine = view.state.doc.line(lineNumber);
      const block = view.lineBlockAt(currentLine.from);
      const nextLine = lineNumber < view.state.doc.lines ? view.state.doc.line(lineNumber + 1) : null;
      const nextBlock = nextLine ? view.lineBlockAt(nextLine.from) : null;
      const end = nextBlock ? nextBlock.top : Math.max(block.top + 1, block.bottom);
      return Math.round(block.top + ((end - block.top) * Math.max(0, Math.min(1, progress))));
    },
    setLineNumbers(enabled) {
      view.dispatch({ effects: lineNumbersCompartment.reconfigure(lineNumberExtension(Boolean(enabled))) });
    },
    setCollapsibleText(enabled) {
      view.dispatch({ effects: foldCompartment.reconfigure(foldExtension(Boolean(enabled))) });
    },
    setWordWrap(enabled) {
      view.dispatch({ effects: wrapCompartment.reconfigure(wrapExtension(Boolean(enabled))) });
    },
    setDarkMode(enabled) {
      view.dispatch({ effects: themeCompartment.reconfigure(themeExtension(Boolean(enabled))) });
    },
    setSpellcheck(enabled) {
      view.dispatch({ effects: spellcheckCompartment.reconfigure(spellcheckExtension(Boolean(enabled))) });
    },
    isFocused() {
      return isFocused || view.hasFocus;
    },
    undo() {
      return undo(view);
    },
    redo() {
      return redo(view);
    }
  };

  return api;
}

export { createMarkdownEditor };

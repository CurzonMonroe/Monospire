const path = require('path');
const zlib = require('zlib');

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function localName(name) {
  return String(name || '').split(':').pop();
}

function parseAttributes(source) {
  const attributes = {};
  const pattern = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match = null;
  while ((match = pattern.exec(source))) {
    attributes[match[1]] = decodeXmlEntities(match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function parseXml(source) {
  const root = { name: '#document', attributes: {}, children: [], text: '' };
  const stack = [root];
  const tokens = String(source || '').match(/<!\[CDATA\[[\s\S]*?]]>|<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || [];

  for (const token of tokens) {
    if (!token) continue;
    if (token.startsWith('<!--') || token.startsWith('<?') || /^<!DOCTYPE/i.test(token)) continue;

    if (token.startsWith('<![CDATA[')) {
      stack[stack.length - 1].text += token.slice(9, -3);
      continue;
    }

    if (!token.startsWith('<')) {
      stack[stack.length - 1].text += decodeXmlEntities(token);
      continue;
    }

    if (token.startsWith('</')) {
      const closingName = localName(token.slice(2, -1).trim());
      while (stack.length > 1) {
        const current = stack.pop();
        if (localName(current.name) === closingName) break;
      }
      continue;
    }

    const selfClosing = /\/>\s*$/.test(token);
    const body = token.slice(1, selfClosing ? -2 : -1).trim();
    const nameMatch = body.match(/^([^\s/>]+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const attributeSource = body.slice(name.length);
    const node = {
      name,
      attributes: parseAttributes(attributeSource),
      children: [],
      text: ''
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

function readUInt16(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (readUInt32(buffer, offset) === 0x06054b50) return offset;
  }
  return -1;
}

function extractZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('Expected a Buffer for MMAP import.');
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) throw new Error('The MMAP file is not a readable ZIP package.');

  const entryCount = readUInt16(buffer, eocdOffset + 10);
  let centralOffset = readUInt32(buffer, eocdOffset + 16);
  const entries = new Map();

  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(buffer, centralOffset) !== 0x02014b50) {
      throw new Error('The MMAP ZIP directory is malformed.');
    }

    const method = readUInt16(buffer, centralOffset + 10);
    const compressedSize = readUInt32(buffer, centralOffset + 20);
    const fileNameLength = readUInt16(buffer, centralOffset + 28);
    const extraLength = readUInt16(buffer, centralOffset + 30);
    const commentLength = readUInt16(buffer, centralOffset + 32);
    const localHeaderOffset = readUInt32(buffer, centralOffset + 42);
    const fileName = buffer.slice(centralOffset + 46, centralOffset + 46 + fileNameLength).toString('utf8');

    if (readUInt32(buffer, localHeaderOffset) !== 0x04034b50) {
      throw new Error(`The ZIP entry "${fileName}" has a malformed local header.`);
    }

    const localNameLength = readUInt16(buffer, localHeaderOffset + 26);
    const localExtraLength = readUInt16(buffer, localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.slice(dataOffset, dataOffset + compressedSize);
    let data = null;

    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      data = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`The ZIP entry "${fileName}" uses unsupported compression method ${method}.`);
    }

    entries.set(fileName.toLowerCase(), { name: fileName, data });
    centralOffset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function findDocumentXml(entries) {
  const direct = entries.get('document.xml');
  if (direct) return direct.data.toString('utf8');
  for (const [entryName, entry] of entries) {
    if (entryName.endsWith('/document.xml')) return entry.data.toString('utf8');
  }
  throw new Error('Document.xml was not found in the MMAP package.');
}

function attributeMap(node) {
  const mapped = {};
  for (const [key, value] of Object.entries(node?.attributes || {})) {
    mapped[localName(key).toLowerCase()] = value;
  }
  return mapped;
}

function directChildren(node, wantedName) {
  return (node?.children || []).filter((child) => localName(child.name).toLowerCase() === wantedName.toLowerCase());
}

function allDescendants(node, predicate, output = []) {
  for (const child of node?.children || []) {
    if (predicate(child)) output.push(child);
    allDescendants(child, predicate, output);
  }
  return output;
}

function firstMeaningfulText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function topicLabel(topicNode) {
  const attrs = attributeMap(topicNode);
  for (const key of ['text', 'plaintext', 'title', 'name', 'label']) {
    const value = firstMeaningfulText(attrs[key]);
    if (value) return value;
  }

  for (const child of topicNode.children || []) {
    const childName = localName(child.name).toLowerCase();
    if (!['text', 'topictext', 'title', 'name'].includes(childName)) continue;
    const childAttrs = attributeMap(child);
    for (const key of ['plaintext', 'text', 'title', 'name']) {
      const value = firstMeaningfulText(childAttrs[key]);
      if (value) return value;
    }
    const childText = firstMeaningfulText(child.text);
    if (childText) return childText;
  }

  const directText = firstMeaningfulText(topicNode.text);
  return directText || 'Untitled topic';
}

function normalizeImportedColour(value) {
  const raw = String(value || '').trim();
  const hex = raw.match(/^#?([0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!hex) return null;
  const digits = hex[1].length === 8 ? hex[1].slice(2) : hex[1];
  return `#${digits.toLowerCase()}`;
}

function topicMetadata(topicNode) {
  const attrs = attributeMap(topicNode);
  const metadata = {};
  const accent = normalizeImportedColour(attrs.color || attrs.linecolor || attrs.bordercolor);
  const fill = normalizeImportedColour(attrs.fillcolor || attrs.backgroundcolor || attrs.fill);
  if (accent) metadata.color = accent;
  if (fill) metadata.fill = fill;
  return metadata;
}

function topicChildNodes(topicNode) {
  const found = [];
  const seen = new Set();
  const addTopic = (node) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    found.push(node);
  };

  for (const child of topicNode.children || []) {
    const childName = localName(child.name).toLowerCase();
    if (childName === 'topic') addTopic(child);
    if (['subtopics', 'topics', 'children'].includes(childName)) {
      for (const candidate of child.children || []) {
        if (localName(candidate.name).toLowerCase() === 'topic') addTopic(candidate);
      }
    }
  }

  return found;
}

function convertTopicNode(topicNode) {
  return {
    label: topicLabel(topicNode),
    metadata: topicMetadata(topicNode),
    children: topicChildNodes(topicNode).map(convertTopicNode)
  };
}

function findTopicRoots(documentRoot) {
  const topicNodes = allDescendants(documentRoot, (node) => localName(node.name).toLowerCase() === 'topic');
  const topicSet = new Set(topicNodes);
  return topicNodes.filter((topic) => {
    let current = topic.__parent;
    while (current) {
      if (topicSet.has(current)) return false;
      current = current.__parent;
    }
    return true;
  });
}

function attachParents(node, parent = null) {
  if (node && typeof node === 'object') node.__parent = parent;
  for (const child of node?.children || []) attachParents(child, node);
}

function metadataComment(metadata) {
  const pairs = Object.entries(metadata || {}).filter(([, value]) => value);
  if (pairs.length === 0) return '';
  return ` <!-- mindmap: ${pairs.map(([key, value]) => `${key}=${value}`).join(' ')} -->`;
}

function escapeMarkdownLabel(value) {
  return firstMeaningfulText(value).replace(/\r?\n/g, ' ').trim() || 'Untitled topic';
}

function renderTopicList(topics, depth = 0) {
  const indent = '   '.repeat(depth);
  const lines = [];
  for (const topic of topics) {
    lines.push(`${indent}- ${escapeMarkdownLabel(topic.label)}${metadataComment(topic.metadata)}`);
    lines.push(...renderTopicList(topic.children || [], depth + 1));
  }
  return lines;
}

function mindManagerDocumentToMarkdown(documentXml, options = {}) {
  const documentRoot = parseXml(documentXml);
  attachParents(documentRoot);
  const rootTopics = findTopicRoots(documentRoot).map(convertTopicNode);
  if (rootTopics.length === 0) {
    throw new Error('No MindManager topics were found in Document.xml.');
  }

  const sourceName = options.sourceName ? path.basename(options.sourceName, path.extname(options.sourceName)) : 'Imported MindManager Map';
  if (rootTopics.length === 1) {
    const [root] = rootTopics;
    const body = renderTopicList(root.children || []);
    return [`# ${escapeMarkdownLabel(root.label)}`, '', ...body].join('\n').trimEnd() + '\n';
  }

  return [`# ${escapeMarkdownLabel(sourceName)}`, '', ...renderTopicList(rootTopics)].join('\n').trimEnd() + '\n';
}

function importMindManagerBuffer(buffer, options = {}) {
  const entries = extractZipEntries(buffer);
  const documentXml = findDocumentXml(entries);
  const markdown = mindManagerDocumentToMarkdown(documentXml, options);
  return {
    markdown,
    documentXml,
    entryCount: entries.size
  };
}

module.exports = {
  decodeXmlEntities,
  extractZipEntries,
  importMindManagerBuffer,
  mindManagerDocumentToMarkdown,
  parseXml
};

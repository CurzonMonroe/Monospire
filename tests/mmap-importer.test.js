const assert = require('assert/strict');
const zlib = require('zlib');
const {
  extractZipEntries,
  importMindManagerBuffer,
  mindManagerDocumentToMarkdown
} = require('../mmap-importer');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name);
    const source = Buffer.from(content);
    const compressed = zlib.deflateRawSync(source);
    const checksum = crc32(source);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + compressed.length;
  }

  const centralOffset = offset;
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
<ap:Document xmlns:ap="http://schemas.mindjet.com/MindManager/Application/2003">
  <ap:OneTopic>
    <ap:Topic Text="Central Topic" FillColor="FFE0F2FE">
      <ap:SubTopics>
        <ap:Topic Text="First Branch" Color="FF2563EB">
          <ap:SubTopics>
            <ap:Topic Text="Leaf &amp; Detail" />
          </ap:SubTopics>
        </ap:Topic>
        <ap:Topic>
          <ap:Text PlainText="Second Branch" />
        </ap:Topic>
      </ap:SubTopics>
    </ap:Topic>
  </ap:OneTopic>
</ap:Document>`;

{
  const markdown = mindManagerDocumentToMarkdown(documentXml, { sourceName: 'Example.mmap' });
  assert.equal(markdown, '# Central Topic\n\n- First Branch <!-- mindmap: color=#2563eb -->\n   - Leaf & Detail\n- Second Branch\n');
}

{
  const zip = createZip({
    'Document.xml': documentXml,
    'Preview.png': 'not really a png'
  });
  const entries = extractZipEntries(zip);
  assert.equal(entries.size, 2);
  assert.equal(entries.get('document.xml').data.toString('utf8'), documentXml);

  const imported = importMindManagerBuffer(zip, { sourceName: 'Example.mmap' });
  assert.equal(imported.entryCount, 2);
  assert.ok(imported.markdown.includes('# Central Topic'));
  assert.ok(imported.markdown.includes('Leaf & Detail'));
}

{
  assert.throws(
    () => importMindManagerBuffer(createZip({ 'Preview.png': 'missing document' })),
    /Document\.xml/
  );
}

console.log('mmap-importer tests passed');

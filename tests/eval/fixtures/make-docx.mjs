// A real .docx for the document-reading task: a genuine zip of the XML Word
// writes, so the reader is exercised against the format rather than a fixture
// shaped like our own assumptions.
import zlib from "node:zlib";
import fs from "node:fs/promises";

const files = {
  "[Content_Types].xml":
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml"/></Types>',
  "word/document.xml":
    "<w:document><w:body>" +
    "<w:p><w:r><w:t>Quarterly summary</w:t></w:r></w:p>" +
    "<w:p><w:r><w:t>Revenue rose </w:t></w:r><w:r><w:t>12%</w:t></w:r><w:r><w:t> on last year.</w:t></w:r></w:p>" +
    "</w:body></w:document>"
};

const chunks = [];
const central = [];
let offset = 0;
for (const [name, text] of Object.entries(files)) {
  const content = Buffer.from(text, "utf8");
  const deflated = zlib.deflateRawSync(content);
  const nameBuffer = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  chunks.push(local, nameBuffer, deflated);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt32LE(deflated.length, 20);
  entry.writeUInt32LE(content.length, 24);
  entry.writeUInt16LE(nameBuffer.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, nameBuffer);
  offset += local.length + nameBuffer.length + deflated.length;
}
const centralBuffer = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(Object.keys(files).length, 8);
end.writeUInt16LE(Object.keys(files).length, 10);
end.writeUInt32LE(centralBuffer.length, 12);
end.writeUInt32LE(offset, 16);

await fs.writeFile(process.argv[2], Buffer.concat([...chunks, centralBuffer, end]));

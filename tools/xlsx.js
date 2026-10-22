'use strict';
// Minimal .xlsx reader for the guest import (tools/import-guests.js), with Node's own zlib: no dependency.
// Reads one worksheet's cell values into rows: text cells as strings, number cells as numbers. Excel dates and
// times are numbers (serial days, day fractions); the importer converts them.

const zlib = require('zlib');

/** Zip archive buffer -> {name: Buffer} for the entries we ask for (stored or deflated). */
function unzip(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not an .xlsx file (no zip directory found)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged .xlsx file (zip directory)');
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42), name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (wanted(name)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      out[name] = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
      if (!out[name]) throw new Error('unsupported compression in ' + name);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const decode = (s) => s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]+|#\d+);/gi, (m, e) =>
  ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[e.toLowerCase()] ||
  String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
const texts = (xml) => (xml.match(/<t\b[^>]*>[\s\S]*?<\/t>|<t\b[^>]*\/>/g) || []).map((t) => decode(t.replace(/^<t\b[^>]*>|<\/t>$|<t\b[^>]*\/>$/g, ''))).join('');
const colIndex = (ref) => ref.replace(/\d+$/, '').split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** .xlsx buffer -> {sheet, rows: [[string | number, ...], ...]} for the named sheet, or the first one. */
function readXlsx(buf, sheetName) {
  const files = unzip(buf, (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(n));
  if (!files['xl/workbook.xml']) throw new Error('not an .xlsx workbook');
  const shared = files['xl/sharedStrings.xml'] ? (files['xl/sharedStrings.xml'].toString('utf8').match(/<si>[\s\S]*?<\/si>/g) || []).map(texts) : [];
  const sheets = [...files['xl/workbook.xml'].toString('utf8').matchAll(/<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"/g)].map((m) => ({ name: decode(m[1]), rid: m[2] }));
  const rels = {};
  [...(files['xl/_rels/workbook.xml.rels'] || Buffer.alloc(0)).toString('utf8').matchAll(/<Relationship\b[^>]*?Id="([^"]*)"[^>]*?Target="([^"]*)"/g)]
    .forEach((m) => { rels[m[1]] = m[2].replace(/^\//, '').replace(/^(?!xl\/)/, 'xl/'); });
  const sheet = sheetName ? sheets.find((s) => s.name === sheetName) : sheets[0];
  if (!sheet) throw new Error(sheetName ? 'no sheet named "' + sheetName + '"' : 'the workbook has no sheets');
  const xml = (files[rels[sheet.rid]] || Buffer.alloc(0)).toString('utf8');
  const rows = [];
  (xml.match(/<row\b[\s\S]*?<\/row>/g) || []).forEach((rowXml) => {
    const row = [];
    (rowXml.match(/<c\b[^>]*?(\/>|>[\s\S]*?<\/c>)/g) || []).forEach((c) => {
      const ref = (c.match(/\br="([A-Z]+\d+)"/) || [])[1], type = (c.match(/\bt="([^"]*)"/) || [])[1];
      const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      // Number cells stay numbers (an Excel date or time is a number; "0.25" typed as text is not the same thing).
      const val = type === 'inlineStr' ? texts(c) : v == null ? '' : type === 's' ? shared[+v] || '' :
        type === 'str' || type === 'e' || type === 'b' || !isFinite(+v) ? decode(v) : +v;
      if (ref) row[colIndex(ref)] = val;
    });
    rows.push(Array.from(row, (x) => (x == null ? '' : x)));
  });
  return { sheet: sheet.name, rows };
}

module.exports = { readXlsx, unzip };

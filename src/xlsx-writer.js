// Minimal .xlsx writer with pictures: one worksheet, bold frozen header, column widths,
// clickable links and images anchored in cells. Uses only node:zlib.
import zlib from 'node:zlib';

// ---- zip ----------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    // Pictures are already compressed; store them as-is.
    const store = /\.(png|jpe?g)$/i.test(name);
    const body = store ? data : zlib.deflateRawSync(data);
    const n = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(store ? 0 : 8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(store ? 0 : 8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, body);
    centrals.push(ch, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---- worksheet ------------------------------------------------------------------
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // Characters XML 1.0 does not allow.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const EMU = 9525; // per pixel

/**
 * columns: [{ label, width, value: (row) => string | number | { text, link } }]
 * picture: optional (row) => ({ key, data: Buffer, type: 'png'|'jpeg', width, height }) | null
 *          placed in the column labelled pictureColumn; the same key is embedded once.
 */
export function buildXlsx({ sheetName = 'Sheet1', title, columns, rows, picture, pictureColumn }) {
  const pictureCol = picture ? columns.findIndex((c) => c.label === pictureColumn) : -1;
  const media = new Map(); // key -> { file, rel }
  const anchors = [];
  const links = [];
  const xmlRows = [];
  let r = 1;
  if (title) {
    xmlRows.push(`<row r="${r}"><c r="A${r}" t="inlineStr" s="2"><is><t>${xmlEsc(title)}</t></is></c></row>`);
    r += 2;
  }
  const headerRow = r;
  xmlRows.push(`<row r="${r}">${columns.map((c, i) => `<c r="${colName(i)}${r}" t="inlineStr" s="1"><is><t>${xmlEsc(c.label)}</t></is></c>`).join('')}</row>`);
  for (const row of rows) {
    r++;
    const pic = pictureCol >= 0 ? picture(row) : null;
    const cells = columns.map((c, i) => {
      const ref = `${colName(i)}${r}`;
      let v = c.value(row);
      if (v == null || v === '') return '';
      if (typeof v === 'object' && v.link) {
        links.push({ ref, url: v.link });
        return `<c r="${ref}" t="inlineStr" s="4"><is><t>${xmlEsc(v.text)}</t></is></c>`;
      }
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}" s="3"><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr" s="3"><is><t>${xmlEsc(v)}</t></is></c>`;
    }).join('');
    xmlRows.push(`<row r="${r}"${pic ? ' ht="96" customHeight="1"' : ''}>${cells}</row>`);
    if (pic) {
      let m = media.get(pic.key);
      if (!m) {
        m = { file: `image${media.size + 1}.${pic.type === 'png' ? 'png' : 'jpeg'}`, rel: `rId${media.size + 1}`, data: pic.data };
        media.set(pic.key, m);
      }
      // Fit inside ~120 x 124 px, keeping the picture's shape.
      const h0 = pic.height || 800, w0 = pic.width || 540;
      const scale = Math.min(124 / h0, 120 / w0);
      anchors.push({ col: pictureCol, row: r - 1, rel: m.rel, cx: Math.round(w0 * scale * EMU), cy: Math.round(h0 * scale * EMU), name: m.file });
    }
  }
  const lastCol = colName(columns.length - 1);
  const sheetRels = [];
  links.forEach((l, i) => sheetRels.push(`<Relationship Id="rIdL${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEsc(l.url)}" TargetMode="External"/>`));
  if (anchors.length) sheetRels.push('<Relationship Id="rIdD1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>');

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join('')}</cols>
<sheetData>${xmlRows.join('')}</sheetData>
<autoFilter ref="A${headerRow}:${lastCol}${Math.max(r, headerRow)}"/>
${links.length ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rIdL${i + 1}"/>`).join('')}</hyperlinks>` : ''}
<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>
${anchors.length ? '<drawing r:id="rIdD1"/>' : ''}
</worksheet>`;

  const drawing = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${anchors.map((a, i) => `<xdr:oneCellAnchor><xdr:from><xdr:col>${a.col}</xdr:col><xdr:colOff>38100</xdr:colOff><xdr:row>${a.row}</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:from><xdr:ext cx="${a.cx}" cy="${a.cy}"/>
<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="Receipt ${i + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
<xdr:blipFill><a:blip r:embed="${a.rel}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${a.cx}" cy="${a.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`).join('\n')}
</xdr:wsDr>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><b/><sz val="13"/><name val="Arial"/></font><font><u/><sz val="10"/><color rgb="FF0F6B4F"/><name val="Arial"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F6B4F"/></patternFill></fill></fills>
<borders count="2"><border/><border><bottom style="thin"><color rgb="FFDFE5E2"/></bottom></border></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="5"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"><alignment vertical="center" wrapText="1"/></xf><xf fontId="2" applyFont="1"/><xf borderId="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf fontId="3" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf></cellXfs>
</styleSheet>`;

  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${anchors.length ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ''}</Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(sheetName.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '))}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xmlEsc(sheetName.slice(0, 31).replace(/[\\/?*[\]:']/g, ' '))}'!$A$${headerRow}:$${lastCol}$${Math.max(r, headerRow)}</definedName></definedNames></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', styles],
    ['xl/worksheets/sheet1.xml', sheet],
  ];
  if (sheetRels.length) files.push(['xl/worksheets/_rels/sheet1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels.join('')}</Relationships>`]);
  if (anchors.length) {
    files.push(['xl/drawings/drawing1.xml', drawing]);
    files.push(['xl/drawings/_rels/drawing1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${[...media.values()].map((m) => `<Relationship Id="${m.rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${m.file}"/>`).join('')}</Relationships>`]);
    for (const m of media.values()) files.push([`xl/media/${m.file}`, m.data]);
  }
  return zip(files);
}

// Formats bureautiques : écriture et lecture de fichiers Word (.docx) et Excel (.xlsx), sans dépendance.
// Un .docx ou un .xlsx est une archive ZIP de fichiers XML. Utilisable dans l'interface et dans les tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Office = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /* ---------- ZIP ---------- */

  const CRC = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const utf8 = (text) => new TextEncoder().encode(text);

  // Archive sans compression : [{ name, data }] → Uint8Array.
  function zip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
      const data = typeof entry.data === 'string' ? utf8(entry.data) : entry.data;
      const name = utf8(entry.name);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // noms en UTF-8
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      const head = new DataView(new ArrayBuffer(46));
      head.setUint32(0, 0x02014b50, true);
      head.setUint16(4, 20, true);
      head.setUint16(6, 20, true);
      head.setUint16(8, 0x0800, true);
      head.setUint32(16, crc, true);
      head.setUint32(20, data.length, true);
      head.setUint32(24, data.length, true);
      head.setUint16(28, name.length, true);
      head.setUint32(42, offset, true);
      parts.push(new Uint8Array(local.buffer), name, data);
      central.push(new Uint8Array(head.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const size = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of all) { out.set(p, at); at += p.length; }
    return out;
  }

  // Lit une archive : rend { nom: Uint8Array }. inflate(octets) décompresse un flux « deflate » brut.
  async function unzip(bytes, inflate) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = bytes.length - 22;
    while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
    if (end < 0) throw new Error("Ce fichier n'est pas un document Word ou Excel valide.");
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const files = {};
    for (let i = 0; i < count; i++) {
      if (view.getUint32(at, true) !== 0x02014b50) break;
      const method = view.getUint16(at + 10, true);
      const size = view.getUint32(at + 20, true);
      const nameLength = view.getUint16(at + 28, true);
      const extra = view.getUint16(at + 30, true);
      const comment = view.getUint16(at + 32, true);
      const local = view.getUint32(at + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const raw = bytes.subarray(start, start + size);
      if (method === 0) files[name] = raw;
      else if (method === 8) files[name] = await inflate(raw);
      at += 46 + nameLength + extra + comment;
    }
    return files;
  }

  /* ---------- XML ---------- */

  const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // caractères de contrôle interdits en XML
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  const unescape = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');

  // Petit lecteur XML : rend un arbre { name, attrs, children, text }. Les préfixes (w:, a:) sont conservés.
  function parseXml(source) {
    const rootNode = { name: '#root', attrs: {}, children: [], text: '' };
    const stack = [rootNode];
    const pattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([^\s>\/]+)([^>]*?)(\/?)>|([^<]+)/g;
    let m;
    while ((m = pattern.exec(source))) {
      const top = stack[stack.length - 1];
      if (m[1] !== undefined) top.text += m[1];
      else if (m[6] !== undefined) top.text += unescape(m[6]);
      else if (m[3]) {
        if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
        const node = { name: m[3], attrs: {}, children: [], text: '' };
        const attr = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
        let a;
        while ((a = attr.exec(m[4]))) node.attrs[a[1]] = unescape(a[3] !== undefined ? a[3] : a[4]);
        top.children.push(node);
        if (!m[5]) stack.push(node);
      }
    }
    return rootNode;
  }
  const child = (node, name) => (node ? node.children.find((c) => c.name === name) : undefined);
  const children = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);
  function descendants(node, name, out = []) {
    for (const c of node.children) {
      if (c.name === name) out.push(c);
      descendants(c, name, out);
    }
    return out;
  }
  const decode = (bytes) => new TextDecoder().decode(bytes);

  /* ---------- écriture Word ---------- */

  // pages : [{ paragraphs: [{ text, size, bold, italic, font, align }] }] → .docx
  function writeDocx(pages) {
    const body = [];
    pages.forEach((page, index) => {
      if (index) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
      for (const p of page.paragraphs) {
        const half = Math.max(2, Math.round((p.size || 11) * 2));
        const run = `<w:rPr><w:rFonts w:ascii="${escape(p.font || 'Arial')}" w:hAnsi="${escape(p.font || 'Arial')}" w:cs="${escape(p.font || 'Arial')}"/>` +
          `${p.bold ? '<w:b/>' : ''}${p.italic ? '<w:i/>' : ''}<w:sz w:val="${half}"/><w:szCs w:val="${half}"/></w:rPr>`;
        const lines = String(p.text).split('\n');
        // Retour à la ligne → <w:br/> ; tabulation (cellules d'une même ligne de tableau) → <w:tab/>.
        const runs = lines.map((line, i) => `<w:r>${run}${i ? '<w:br/>' : ''}${line.split('\t').map((cell, k) => `${k ? '<w:tab/>' : ''}<w:t xml:space="preserve">${escape(cell)}</w:t>`).join('')}</w:r>`).join('');
        const align = p.align === 'center' ? 'center' : p.align === 'right' ? 'right' : 'left';
        body.push(`<w:p><w:pPr><w:spacing w:after="120"/><w:jc w:val="${align}"/></w:pPr>${runs}</w:p>`);
      }
    });
    const first = pages[0] || {};
    const w = Math.round((first.width || 595) * 20);
    const h = Math.round((first.height || 842) * 20);
    const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body.join('') +
      `<w:sectPr><w:pgSz w:w="${w}" w:h="${h}"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>` +
      '</w:body></w:document>';
    return zip([
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
      { name: 'word/document.xml', data: document },
    ]);
  }

  const hex = (c) => c.map((v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')).join('').toUpperCase();

  // Export fidèle : chaque page garde son fond (image de la page sans son texte) et chaque bloc de
  // texte est posé à sa place exacte dans un cadre, avec sa police, sa taille et sa couleur.
  // pages : [{ width, height, image: Uint8Array (JPEG), frames: [{ x, y, w, lines, size, leading,
  //            bold, italic, font, color, align }] }] — mesures en points, origine en haut à gauche.
  function writeDocxLayout(pages) {
    const twips = (pt) => Math.round(pt * 20);
    const emu = (pt) => Math.round(pt * 12700);
    const body = [];
    const media = [];
    pages.forEach((page, index) => {
      const tiny = '<w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr>';
      let picture = '';
      if (page.image) {
        media.push({ id: `rId${media.length + 1}`, name: `page${index + 1}.jpeg`, data: page.image });
        const id = media.length;
        const size = `cx="${emu(page.width)}" cy="${emu(page.height)}"`;
        picture = `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">` +
          '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
          `<wp:extent ${size}/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${id}" name="Fond de la page ${index + 1}"/><wp:cNvGraphicFramePr/>` +
          '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
          `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="page${index + 1}.jpeg"/><pic:cNvPicPr/></pic:nvPicPr>` +
          `<pic:blipFill><a:blip r:embed="rId${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext ${size}/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
          '</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>';
      }
      body.push(`<w:p>${tiny}${picture}</w:p>`);
      for (const f of page.frames) {
        const half = Math.max(2, Math.round(f.size * 2));
        // Une ligne est une suite de passages, chacun avec son style (gras, italique, police, couleur).
        const props = (r) => {
          const font = escape(r.font || f.font || 'Arial');
          return `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>${r.bold ? '<w:b/>' : ''}${r.italic ? '<w:i/>' : ''}<w:color w:val="${hex(r.color || [0, 0, 0])}"/>${r.stretch && Math.abs(r.stretch - 1) > 0.02 ? `<w:w w:val="${Math.round(r.stretch * 100)}"/>` : ''}<w:sz w:val="${half}"/><w:szCs w:val="${half}"/></w:rPr>`;
        };
        const runs = f.lines.map((line, i) => {
          const parts = typeof line === 'string' ? [{ ...f, text: line }] : line;
          return parts.map((r, k) => `<w:r>${props(r)}${i && !k ? '<w:br/>' : ''}<w:t xml:space="preserve">${escape(r.text)}</w:t></w:r>`).join('');
        }).join('');
        const align = f.align === 'center' ? 'center' : f.align === 'right' ? 'right' : 'left';
        // Interligne exact : les lignes retombent à la même hauteur que dans le PDF.
        body.push(`<w:p><w:pPr><w:framePr w:w="${twips(f.w)}" w:h="${twips(f.lines.length * f.leading + 2)}" w:hRule="exact" w:hAnchor="page" w:vAnchor="page" w:x="${twips(f.x)}" w:y="${twips(f.y)}" w:wrap="none"/>` +
          `<w:spacing w:before="0" w:after="0" w:line="${twips(f.leading)}" w:lineRule="exact"/><w:jc w:val="${align}"/></w:pPr>${runs}</w:p>`);
      }
      if (index < pages.length - 1) body.push(`<w:p>${tiny}<w:r><w:br w:type="page"/></w:r></w:p>`);
    });
    const first = pages[0] || { width: 595, height: 842 };
    const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>' + body.join('') +
      `<w:sectPr><w:pgSz w:w="${twips(first.width)}" w:h="${twips(first.height)}"/><w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    return zip([
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
      { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + media.map((m) => `<Relationship Id="${m.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('') + '</Relationships>' },
      { name: 'word/document.xml', data: document },
      ...media.map((m) => ({ name: `word/media/${m.name}`, data: m.data })),
    ]);
  }

  /* ---------- écriture Excel ---------- */

  const columnName = (index) => {
    let name = '';
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    return name;
  };
  // « 1 575,00 € », « 42,5 », « 1 234 » → nombre ; sinon null. euro : vrai si le symbole était présent.
  function parseAmount(text) {
    const m = String(text).trim().match(/^(-?)\s*(\d{1,3}(?:[   ]\d{3})+|\d+)(?:[.,](\d+))?\s*(€)?$/);
    if (!m) return null;
    const digits = m[2].replace(/[   ]/g, '');
    if (digits.length > 1 && digits[0] === '0' && !m[3]) return null; // code postal, référence : pas un nombre
    if (digits.length > 15) return null;
    return { value: Number(`${m[1]}${digits}${m[3] ? `.${m[3]}` : ''}`), euro: !!m[4], decimals: m[3] ? m[3].length : 0 };
  }

  // sheets : [{ name, rows: [[texte, …]] }] → .xlsx
  function writeXlsx(sheets) {
    const used = new Set();
    const names = sheets.map((sheet, i) => {
      let base = String(sheet.name || `Feuille ${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || `Feuille ${i + 1}`;
      let name = base;
      for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base} ${k}`;
      used.add(name.toLowerCase());
      return name;
    });
    // Styles construits à la demande : une entrée par combinaison (format de nombre, gras, couleur, fond).
    const fonts = ['<font><sz val="11"/><name val="Calibri"/></font>'];
    const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    const xfs = [];
    const indexOf = (list, xml) => { let i = list.indexOf(xml); if (i < 0) { list.push(xml); i = list.length - 1; } return i; };
    const styleOf = (numFmt, look) => {
      const l = look || {};
      const font = l.bold || l.color
        ? indexOf(fonts, `<font>${l.bold ? '<b/>' : ''}<sz val="11"/>${l.color ? `<color rgb="FF${hex(l.color)}"/>` : ''}<name val="Calibri"/></font>`) : 0;
      const fill = l.fill ? indexOf(fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${hex(l.fill)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
      return indexOf(xfs, `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="0" xfId="0"${numFmt ? ' applyNumberFormat="1"' : ''}${font ? ' applyFont="1"' : ''}${fill ? ' applyFill="1"' : ''}/>`);
    };
    styleOf(0, null); // style par défaut : indice 0
    const sheetXml = (sheet) => {
      const widths = [];
      const rows = sheet.rows.map((row, r) => {
        const cells = row.map((value, c) => {
          const text = value === null || value === undefined ? '' : String(value);
          const look = sheet.looks && sheet.looks[r] ? sheet.looks[r][c] : null;
          widths[c] = Math.max(widths[c] || 8, Math.min(60, text.length + 2));
          const ref = `${columnName(c)}${r + 1}`;
          if (!text) return look && look.fill ? `<c r="${ref}" s="${styleOf(0, look)}"/>` : '';
          const amount = parseAmount(text);
          if (amount) return `<c r="${ref}" s="${styleOf(amount.euro ? 164 : amount.decimals ? 4 : 0, look)}"><v>${amount.value}</v></c>`;
          return `<c r="${ref}" s="${styleOf(0, look)}" t="inlineStr"><is><t xml:space="preserve">${escape(text)}</t></is></c>`;
        }).join('');
        return `<row r="${r + 1}">${cells}</row>`;
      }).join('');
      const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w || 8}" customWidth="1"/>`).join('')}</cols>` : '';
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rows}</sheetData></worksheet>`;
    };
    const sheetFiles = sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sheet) }));
    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00\\ &quot;€&quot;"/></numFmts>' +
      `<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills>` +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs></styleSheet>`;
    return zip([
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + names.map((n, i) => `<sheet name="${escape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: 'xl/styles.xml', data: styles },
      ...sheetFiles,
    ]);
  }

  // Lignes de texte d'une page → grille : les débuts de cellule proches forment une même colonne.
  // rows : lignes de Blocks.buildRows (t0, t1, v, size, str).
  function gridFromRows(rows) {
    const lines = [];
    for (const row of [...rows].sort((p, q) => q.v - p.v || p.t0 - q.t0)) {
      const line = lines.find((l) => Math.abs(l.v - row.v) <= 0.45 * Math.min(l.size, row.size));
      if (line) line.cells.push(row);
      else lines.push({ v: row.v, size: row.size, cells: [row] });
    }
    // Colonnes : dans les lignes qui ont plusieurs cellules, les cellules qui se recouvrent en largeur
    // forment une colonne (un en-tête centré tombe ainsi au-dessus de sa colonne alignée à gauche).
    const spans = [];
    const tabular = lines.filter((line) => line.cells.length >= 2).flatMap((line) => line.cells);
    for (const cell of [...tabular].sort((p, q) => p.t0 - q.t0)) {
      const last = spans[spans.length - 1];
      if (last && cell.t0 < last.t1 - 1) last.t1 = Math.max(last.t1, cell.t1);
      else spans.push({ t0: cell.t0, t1: cell.t1 });
    }
    if (!spans.length) spans.push({ t0: -Infinity, t1: Infinity });
    const columnOf = (cell) => {
      let best = -1;
      let most = 0;
      spans.forEach((span, i) => {
        const overlap = Math.min(span.t1, cell.t1) - Math.max(span.t0, cell.t0);
        // Une ligne de texte courant qui traverse plusieurs colonnes va dans la première.
        if (overlap > most + 0.5 && (best < 0 || overlap > most * 1.5)) { best = i; most = overlap; }
      });
      if (best >= 0) return best;
      let column = 0;
      spans.forEach((span, i) => { if (span.t0 <= cell.t0 + 4) column = i; });
      return column;
    };
    const sources = [];
    const grid = lines.map((line) => {
      const out = new Array(spans.length).fill('');
      const from = new Array(spans.length).fill(null);
      for (const cell of line.cells.sort((p, q) => p.t0 - q.t0)) {
        const column = columnOf(cell);
        out[column] = out[column] ? `${out[column]} ${cell.str.trim()}` : cell.str.trim();
        if (!from[column]) from[column] = cell;
      }
      sources.push(from);
      return out;
    });
    grid.sources = sources; // ligne d'origine de chaque cellule
    return grid;
  }

  /* ---------- lecture Word ---------- */

  const HIGHLIGHTS = { yellow: 'FFFF00', green: '00FF00', cyan: '00FFFF', magenta: 'FF00FF', blue: '0000FF', red: 'FF0000', darkBlue: '000080', darkCyan: '008080', darkGreen: '008000', darkMagenta: '800080', darkRed: '800000', darkYellow: '808000', darkGray: '808080', lightGray: 'C0C0C0', black: '000000' };
  const rgbOf = (value) => (/^[0-9a-f]{6}$/i.test(value || '') ? [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255) : undefined);
  const defined = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));

  // Rend une liste d'éléments, avec en propriété `.page` le format { width, height, top, right, bottom, left } :
  //   { type: 'p', runs: [{ text, bold, italic, underline, size, font, color, fill }], align, heading, bullet,
  //     fill, before, after, indent, firstLine, bar: { color, width } }
  //   { type: 'image', data, kind, width, height, align }
  //   { type: 'table', widths: [pt], borders, rows: [[{ fill, paragraphs: [p] }]] }
  //   { type: 'break' }
  async function readDocx(bytes, inflate) {
    const files = await unzip(bytes, inflate);
    if (!files['word/document.xml']) throw new Error("Ce fichier n'est pas un document Word (.docx) valide.");
    const doc = parseXml(decode(files['word/document.xml']));
    const body = descendants(doc, 'w:body')[0];
    const val = (node, name, attr = 'w:val') => { const n = child(node, name); return n ? n.attrs[attr] : undefined; };
    const twips = (value) => (value === undefined || Number.isNaN(Number(value)) ? undefined : Number(value) / 20);

    function runProps(rPr) {
      if (!rPr) return {};
      const flag = (name) => { const n = child(rPr, name); return n ? n.attrs['w:val'] !== '0' && n.attrs['w:val'] !== 'false' : undefined; };
      const sz = val(rPr, 'w:sz');
      const fonts = child(rPr, 'w:rFonts');
      const u = val(rPr, 'w:u');
      const shade = val(rPr, 'w:shd', 'w:fill');
      return defined({
        bold: flag('w:b'), italic: flag('w:i'), size: sz ? Number(sz) / 2 : undefined,
        font: fonts ? fonts.attrs['w:ascii'] || fonts.attrs['w:hAnsi'] : undefined,
        color: rgbOf(val(rPr, 'w:color')), underline: u === undefined ? undefined : u !== 'none',
        fill: rgbOf(HIGHLIGHTS[val(rPr, 'w:highlight')]) || rgbOf(shade),
      });
    }
    function paraProps(pPr) {
      if (!pPr) return {};
      const jc = val(pPr, 'w:jc');
      const spacing = child(pPr, 'w:spacing');
      const ind = child(pPr, 'w:ind');
      const left = child(child(pPr, 'w:pBdr'), 'w:left');
      return defined({
        align: jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : jc ? 'left' : undefined,
        fill: rgbOf(val(pPr, 'w:shd', 'w:fill')),
        before: spacing ? twips(spacing.attrs['w:before']) : undefined, after: spacing ? twips(spacing.attrs['w:after']) : undefined,
        indent: ind ? twips(ind.attrs['w:left'] || ind.attrs['w:start']) : undefined,
        firstLine: ind ? (ind.attrs['w:hanging'] ? -twips(ind.attrs['w:hanging']) : twips(ind.attrs['w:firstLine'])) : undefined,
        bar: left && left.attrs['w:val'] !== 'nil' && left.attrs['w:val'] !== 'none'
          ? { color: rgbOf(left.attrs['w:color']) || [0, 0, 0], width: Number(left.attrs['w:sz'] || 4) / 8, space: Number(left.attrs['w:space'] || 0) } : undefined,
      });
    }

    // Styles : chaque style hérite de son parent (basedOn).
    const styles = {};
    let runDefault = { size: 11, font: 'Calibri' };
    let paraDefault = {};
    if (files['word/styles.xml']) {
      const sheet = parseXml(decode(files['word/styles.xml']));
      const base = descendants(sheet, 'w:rPrDefault')[0];
      if (base) runDefault = { ...runDefault, ...runProps(child(base, 'w:rPr')) };
      const pBase = descendants(sheet, 'w:pPrDefault')[0];
      if (pBase) paraDefault = paraProps(child(pBase, 'w:pPr'));
      for (const style of descendants(sheet, 'w:style')) {
        const name = val(style, 'w:name') || '';
        const level = /^(heading|titre)\s*(\d)$/i.exec(name);
        styles[style.attrs['w:styleId']] = {
          run: runProps(child(style, 'w:rPr')), para: paraProps(child(style, 'w:pPr')), basedOn: val(style, 'w:basedOn'),
          heading: level ? Number(level[2]) : /^(title|titre)$/i.test(name) ? 0 : undefined,
        };
      }
    }
    const resolve = (id, seen = new Set()) => {
      const style = styles[id];
      if (!style || seen.has(id)) return { run: {}, para: {} };
      seen.add(id);
      const parent = resolve(style.basedOn, seen);
      return { run: { ...parent.run, ...style.run }, para: { ...parent.para, ...style.para }, heading: style.heading !== undefined ? style.heading : parent.heading };
    };

    // Images du document : identifiant de relation → fichier.
    const rels = files['word/_rels/document.xml.rels'] ? descendants(parseXml(decode(files['word/_rels/document.xml.rels'])), 'Relationship') : [];
    const imageOf = (drawing) => {
      const blip = descendants(drawing, 'a:blip')[0];
      const extent = descendants(drawing, 'wp:extent')[0];
      const rel = blip && rels.find((r) => r.attrs.Id === blip.attrs['r:embed']);
      const target = rel && rel.attrs.Target.replace(/^\//, '');
      const data = target && (files[target.startsWith('word/') ? target : `word/${target}`]);
      const kind = /\.png$/i.test(target || '') ? 'png' : /\.jpe?g$/i.test(target || '') ? 'jpg' : null;
      if (!data || !kind || !extent) return null;
      return { type: 'image', data, kind, width: Number(extent.attrs.cx) / 12700, height: Number(extent.attrs.cy) / 12700 };
    };

    const paragraph = (p, items) => {
      const pPr = child(p, 'w:pPr');
      const style = resolve(val(pPr, 'w:pStyle') || 'Normal');
      const para = { ...paraDefault, ...style.para, ...paraProps(pPr) };
      const base = { ...runDefault, ...style.run };
      if (style.heading !== undefined && !style.run.size) Object.assign(base, { size: [26, 20, 16, 14, 12, 12][style.heading] || 12, bold: true });
      const out = { type: 'p', runs: [], align: 'left', ...para, heading: style.heading, bullet: !!(pPr && child(pPr, 'w:numPr')), base };
      const pictures = [];
      const walk = (node) => {
        for (const c of node.children) {
          if (c.name === 'w:r') {
            const props = { ...base, ...runProps(child(c, 'w:rPr')) };
            for (const part of c.children) {
              if (part.name === 'w:t') out.runs.push({ ...props, text: part.text });
              else if (part.name === 'w:tab') out.runs.push({ ...props, text: '    ' });
              else if (part.name === 'w:br') {
                if (part.attrs['w:type'] === 'page') out.breakAfter = true;
                else out.runs.push({ ...props, text: '\n' });
              } else if (part.name === 'w:drawing') {
                const picture = imageOf(part);
                if (picture) pictures.push({ ...picture, align: out.align });
              }
            }
          } else if (['w:hyperlink', 'w:ins', 'w:smartTag', 'w:sdt', 'w:sdtContent'].includes(c.name)) walk(c);
        }
      };
      walk(p);
      if (items) {
        // Un paragraphe qui ne contient qu'une image devient l'image elle-même.
        if (out.runs.length || !pictures.length) items.push(out);
        items.push(...pictures);
        if (out.breakAfter) items.push({ type: 'break' });
      }
      return out;
    };
    const table = (tbl) => {
      const grid = descendants(child(tbl, 'w:tblGrid') || { children: [] }, 'w:gridCol').map((g) => twips(g.attrs['w:w']) || 0);
      const tblPr = child(tbl, 'w:tblPr');
      const lines = (node) => !!node && node.children.some((b) => b.attrs['w:val'] && b.attrs['w:val'] !== 'nil' && b.attrs['w:val'] !== 'none');
      let borders = lines(child(tblPr, 'w:tblBorders')) || !!val(tblPr, 'w:tblStyle');
      const rows = children(tbl, 'w:tr').map((tr) => children(tr, 'w:tc').map((tc) => {
        const tcPr = child(tc, 'w:tcPr');
        if (lines(child(tcPr, 'w:tcBorders'))) borders = true;
        return { fill: rgbOf(val(tcPr, 'w:shd', 'w:fill')), span: Number(val(tcPr, 'w:gridSpan') || 1), paragraphs: children(tc, 'w:p').map((p) => paragraph(p)) };
      }));
      return { type: 'table', widths: grid, borders, rows };
    };
    const items = [];
    const block = (node) => {
      for (const c of node.children) {
        if (c.name === 'w:p') paragraph(c, items);
        else if (c.name === 'w:tbl') items.push(table(c));
        else if (c.name === 'w:sdt' || c.name === 'w:sdtContent') block(c);
      }
    };
    if (body) block(body);
    const sect = body ? descendants(body, 'w:sectPr').pop() : null;
    const size = child(sect, 'w:pgSz');
    const margin = child(sect, 'w:pgMar');
    const m = (side) => (margin && twips(margin.attrs[`w:${side}`]) !== undefined ? Math.max(18, twips(margin.attrs[`w:${side}`])) : 56.7);
    items.page = {
      width: size ? twips(size.attrs['w:w']) : 595.28, height: size ? twips(size.attrs['w:h']) : 841.89,
      top: m('top'), right: m('right'), bottom: m('bottom'), left: m('left'),
    };
    return items;
  }

  /* ---------- lecture Excel ---------- */

  // Rend [{ name, rows: [[texte, …]], styles: [[style | null, …]], widths: [largeur de colonne], merges }].
  // Les nombres et les dates sont rendus tels qu'on les lirait ; style = { bold, italic, size, font,
  // color, fill, align, borders: { top, right, bottom, left } }.
  async function readXlsx(bytes, inflate) {
    const files = await unzip(bytes, inflate);
    if (!files['xl/workbook.xml']) throw new Error("Ce fichier n'est pas un classeur Excel (.xlsx) valide.");
    const shared = files['xl/sharedStrings.xml']
      ? descendants(parseXml(decode(files['xl/sharedStrings.xml'])), 'si').map((si) => descendants(si, 't').map((t) => t.text).join(''))
      : [];
    // Couleurs du thème, dans l'ordre où Excel les numérote (clair 1, sombre 1, clair 2, sombre 2, accents).
    let theme = [];
    const themeFile = Object.keys(files).find((name) => /^xl\/theme\/theme\d*\.xml$/.test(name));
    if (themeFile) {
      const scheme = descendants(parseXml(decode(files[themeFile])), 'a:clrScheme')[0];
      const listed = scheme ? scheme.children.map((entry) => { const c = entry.children[0]; return c ? c.attrs.val && /^[0-9a-f]{6}$/i.test(c.attrs.val) ? c.attrs.val : c.attrs.lastClr : null; }) : [];
      theme = [listed[1], listed[0], listed[3], listed[2], ...listed.slice(4)];
    }
    const colorOf = (node) => {
      if (!node) return undefined;
      let base;
      if (node.attrs.rgb) base = rgbOf(node.attrs.rgb.slice(-6));
      else if (node.attrs.theme !== undefined) base = rgbOf(theme[Number(node.attrs.theme)]);
      if (!base) return undefined;
      const tint = Number(node.attrs.tint || 0);
      return base.map((v) => (tint > 0 ? v + (1 - v) * tint : v * (1 + tint)));
    };
    // Styles de cellule.
    const cellStyles = [];
    const formats = [];
    if (files['xl/styles.xml']) {
      const sheet = parseXml(decode(files['xl/styles.xml']));
      const custom = new Map(descendants(sheet, 'numFmt').map((n) => [Number(n.attrs.numFmtId), n.attrs.formatCode || '']));
      const on = (node) => !!node && node.attrs.val !== '0' && node.attrs.val !== 'false';
      const fonts = children(descendants(sheet, 'fonts')[0], 'font').map((f) => defined({
        bold: on(child(f, 'b')) || undefined, italic: on(child(f, 'i')) || undefined,
        size: child(f, 'sz') ? Number(child(f, 'sz').attrs.val) : undefined, font: child(f, 'name') ? child(f, 'name').attrs.val : undefined,
        color: colorOf(child(f, 'color')),
      }));
      const fills = children(descendants(sheet, 'fills')[0], 'fill').map((f) => {
        const pattern = child(f, 'patternFill');
        return pattern && pattern.attrs.patternType === 'solid' ? colorOf(child(pattern, 'fgColor')) : undefined;
      });
      const borders = children(descendants(sheet, 'borders')[0], 'border').map((b) => {
        const side = (name) => { const n = child(b, name); return !!(n && n.attrs.style && n.attrs.style !== 'none'); };
        const out = { top: side('top'), right: side('right'), bottom: side('bottom'), left: side('left') };
        return out.top || out.right || out.bottom || out.left ? out : undefined;
      });
      children(descendants(sheet, 'cellXfs')[0], 'xf').forEach((xf, index) => {
        const id = Number(xf.attrs.numFmtId || 0);
        const code = custom.get(id) || '';
        const plain = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
        const date = (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[dy]/i.test(plain) || /m.*[dy]|[dy].*m/i.test(plain);
        const places = id === 2 || id === 4 || id === 10 ? 2 : ((plain.match(/\.(0+)/) || [])[1] || '').length;
        const literal = (code.match(/"([^"]*)"/) || [])[1];
        formats[index] = { date, places: id === 2 || id === 4 || id === 10 || /\.0/.test(plain) ? places : undefined, group: id === 3 || id === 4 || /#,#/.test(plain), percent: id === 9 || id === 10 || /%/.test(plain), suffix: literal ? literal.trim() : /€/.test(code) ? '€' : '' };
        const align = child(xf, 'alignment');
        const horizontal = align ? align.attrs.horizontal : undefined;
        const style = defined({
          ...(fonts[Number(xf.attrs.fontId || 0)] || {}), fill: fills[Number(xf.attrs.fillId || 0)], borders: borders[Number(xf.attrs.borderId || 0)],
          align: horizontal === 'center' ? 'center' : horizontal === 'right' ? 'right' : horizontal === 'left' ? 'left' : undefined,
        });
        cellStyles[index] = style;
      });
    }
    const book = parseXml(decode(files['xl/workbook.xml']));
    const rels = files['xl/_rels/workbook.xml.rels'] ? descendants(parseXml(decode(files['xl/_rels/workbook.xml.rels'])), 'Relationship') : [];
    const target = (id) => { const rel = rels.find((r) => r.attrs.Id === id); return rel ? `xl/${rel.attrs.Target.replace(/^\/xl\//, '').replace(/^\//, '')}` : null; };
    const columnIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
    const cellRef = (ref) => ({ r: Number(ref.replace(/\D+/g, '')) - 1, c: columnIndex(ref) });
    const format = (value, style) => {
      const number = Number(value);
      if (!Number.isFinite(number)) return value;
      const f = formats[style] || {};
      if (f.date) {
        const date = new Date(Math.round((number - 25569) * 86400000));
        const pad = (n) => String(n).padStart(2, '0');
        const day = `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
        return number % 1 ? `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}` : day;
      }
      const shown = f.percent ? number * 100 : number;
      let text = f.places !== undefined ? shown.toFixed(f.places) : String(Math.round(shown * 1e10) / 1e10);
      let [whole, fraction] = text.split('.');
      if (f.group) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
      text = fraction ? `${whole},${fraction}` : whole;
      return `${text}${f.percent ? ' %' : ''}${f.suffix ? ` ${f.suffix}` : ''}`;
    };
    const sheets = [];
    for (const sheet of descendants(book, 'sheet')) {
      const file = files[target(sheet.attrs['r:id'])];
      if (!file) continue;
      const tree = parseXml(decode(file));
      const rows = [];
      const styles = [];
      for (const row of descendants(tree, 'row')) {
        const r = Number(row.attrs.r || rows.length + 1) - 1;
        const cells = [];
        const looks = [];
        children(row, 'c').forEach((c, i) => {
          const column = c.attrs.r ? columnIndex(c.attrs.r) : i;
          const v = child(c, 'v');
          const index = Number(c.attrs.s || 0);
          let text = '';
          if (c.attrs.t === 's') text = shared[Number(v ? v.text : -1)] || '';
          else if (c.attrs.t === 'inlineStr') text = descendants(c, 't').map((t) => t.text).join('');
          else if (c.attrs.t === 'b') text = v && v.text === '1' ? 'VRAI' : 'FAUX';
          else if (c.attrs.t === 'str' || c.attrs.t === 'e') text = v ? v.text : '';
          else if (v) text = format(v.text, index);
          cells[column] = text;
          const look = cellStyles[index];
          looks[column] = look && Object.keys(look).length ? look : null;
        });
        rows[r] = Array.from(cells, (c) => c || '');
        styles[r] = Array.from(looks, (l) => l || null);
      }
      const widths = [];
      for (const col of descendants(tree, 'col')) {
        for (let c = Number(col.attrs.min); c <= Math.min(Number(col.attrs.max), 256); c++) widths[c - 1] = Number(col.attrs.width);
      }
      const merges = descendants(tree, 'mergeCell').map((m) => { const [from, to] = m.attrs.ref.split(':'); const p = cellRef(from); const q = cellRef(to || from); return { r0: p.r, c0: p.c, r1: q.r, c1: q.c }; });
      sheets.push({ name: sheet.attrs.name || `Feuille ${sheets.length + 1}`, rows: Array.from(rows, (r) => r || []), styles: Array.from(styles, (r) => r || []), widths, merges });
    }
    return sheets;
  }

  return { zip, unzip, parseXml, writeDocx, writeDocxLayout, writeXlsx, parseAmount, gridFromRows, readDocx, readXlsx };
});

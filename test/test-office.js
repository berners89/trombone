// Tests des conversions bureautiques : node test/test-office.js
// Lecture de vrais fichiers Word et Excel (produits par LibreOffice), conversion en PDF,
// puis écriture de fichiers Word et Excel relus par notre propre lecteur.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const office = require('../src/office.js');
const ops = require('../src/pdfops.js');
const Blocks = require('../src/blocks.js');

const inflate = async (raw) => new Uint8Array(zlib.inflateRawSync(raw));
const loadFont = async (file) => fs.readFileSync(path.join(__dirname, '..', 'fonts', file));
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });

async function pdfText(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const pdf = await task.promise;
  let text = '';
  for (let n = 1; n <= pdf.numPages; n++) text += (await (await pdf.getPage(n)).getTextContent()).items.map((i) => i.str).join(' ') + '\n';
  await task.destroy();
  return text;
}

(async () => {
  // Archive : aller-retour.
  const packed = office.zip([{ name: 'a/été.txt', data: 'bonjour' }, { name: 'b.bin', data: new Uint8Array([1, 2, 3]) }]);
  const files = await office.unzip(packed, inflate);
  assert.equal(new TextDecoder().decode(files['a/été.txt']), 'bonjour');
  assert.deepEqual([...files['b.bin']], [1, 2, 3]);

  // Word → PDF.
  const items = await office.readDocx(new Uint8Array(fs.readFileSync(path.join(__dirname, 'office', 'lettre.docx'))), inflate);
  const heading = items.find((i) => i.type === 'p' && i.heading === 1);
  assert.ok(heading && /Devis de rénovation/.test(heading.runs.map((r) => r.text).join('')), 'le titre doit être reconnu');
  const para = items.find((i) => i.type === 'p' && /FICTIF/.test(i.runs.map((r) => r.text).join('')));
  assert.ok(para.runs.some((r) => r.bold && /FICTIF/.test(r.text)), 'le gras doit être conservé');
  assert.ok(para.runs.some((r) => r.italic && /rénovation complète/.test(r.text)), "l'italique doit être conservé");
  assert.ok(items.some((i) => i.type === 'table' && i.rows.length === 2 && i.rows[0].length === 3), 'le tableau doit être lu');
  assert.ok(items.page.width > 500 && items.page.left > 10, 'le format de page doit être lu');
  assert.ok(items.some((i) => i.type === 'p' && i.align === 'right'), "l'alignement à droite doit être lu");
  const letterPdf = await ops.docToPdf(items, loadFont);
  fs.writeFileSync(path.join(out, 'lettre.pdf'), letterPdf);
  const letterText = await pdfText(letterPdf);
  for (const expected of ['Devis de rénovation', 'FICTIF', "douche à l'italienne", 'Carrelage grès cérame', '756,00 €', 'Clermont-Ferrand']) {
    assert.ok(letterText.includes(expected), `texte attendu dans le PDF : ${expected}`);
  }
  assert.ok((await ops.listFonts(letterPdf)).every((f) => f.embedded), 'toutes les polices du PDF produit sont embarquées');

  // Word coloré → PDF : couleurs du texte, fonds et largeurs de colonnes repris du document.
  const colored = await office.readDocx(new Uint8Array(fs.readFileSync(path.join(__dirname, 'office', 'couleurs.docx'))), inflate);
  const blue = (c) => c && c[2] > 0.7 && c[0] < 0.3;
  const heading1 = colored.find((i) => i.type === 'p' && i.heading === 1);
  assert.ok(blue(heading1.runs[0].color), 'la couleur du titre vient du style');
  const band = colored.find((i) => i.type === 'p' && i.fill);
  assert.ok(band && band.bar && blue(band.bar.color), 'le fond et le filet du bandeau doivent être lus');
  const sentence = colored.find((i) => i.type === 'p' && i.runs.some((r) => /rénovation complète/.test(r.text)));
  assert.ok(blue(sentence.runs.find((r) => /rénovation complète/.test(r.text)).color), 'couleur d\'un passage');
  const colorTable = colored.find((i) => i.type === 'table');
  assert.equal(colorTable.widths.length, 3);
  assert.ok(blue(colorTable.rows[0][0].paragraphs[0].fill), 'fond de l\'en-tête du tableau');
  assert.deepEqual(colorTable.rows[0][0].paragraphs[0].runs[0].color, [1, 1, 1], 'texte blanc de l\'en-tête');
  fs.writeFileSync(path.join(out, 'couleurs.pdf'), await ops.docToPdf(colored, loadFont));

  // Excel → PDF.
  const sheets = await office.readXlsx(new Uint8Array(fs.readFileSync(path.join(__dirname, 'office', 'tableau.xlsx'))), inflate);
  assert.equal(sheets.length, 1);
  assert.deepEqual(sheets[0].rows[0], ['Désignation', 'Quantité', 'Prix unitaire', 'Total', 'Date']);
  assert.deepEqual(sheets[0].rows[1], ['Carrelage grès cérame', '18', '42,5', '765', '15/01/2026']);
  const sheetPdf = await ops.sheetsToPdf(sheets, loadFont);
  fs.writeFileSync(path.join(out, 'tableau.pdf'), sheetPdf);
  const sheetText = await pdfText(sheetPdf);
  for (const expected of ["Main d'œuvre", '1575', '20/01/2026', '42,5']) assert.ok(sheetText.includes(expected), `texte attendu : ${expected}`);

  // Excel coloré → PDF : fonds, couleurs, gras, fusion, largeurs, format monétaire.
  const styledSheets = await office.readXlsx(new Uint8Array(fs.readFileSync(path.join(__dirname, 'office', 'couleurs.xlsx'))), inflate);
  const devis = styledSheets[0];
  assert.deepEqual(devis.merges, [{ r0: 0, c0: 0, r1: 0, c1: 3 }]);
  assert.deepEqual(devis.widths, [30, 10, 14, 14]);
  assert.ok(blue(devis.styles[1][0].fill) && devis.styles[1][0].bold && devis.styles[1][0].align === 'center', "en-tête : fond bleu, gras, centré");
  assert.deepEqual(devis.styles[1][0].color, [1, 1, 1]);
  assert.ok(devis.styles[0][0].size === 14 && blue(devis.styles[0][0].color));
  assert.ok(devis.styles[3][0].italic && devis.styles[4][3].color[0] > 0.6 && devis.styles[4][0].borders.top);
  assert.ok(devis.styles[2][0].fill && devis.styles[2][0].fill.every((v) => v > 0.5), 'couleur de thème éclaircie');
  assert.deepEqual(devis.rows[2], ['Carrelage grès cérame', '18', '42,50 €', '765,00 €']);
  assert.equal(devis.rows[4][3], '2 340,00 €');
  const styledPdf = await ops.sheetsToPdf(styledSheets, loadFont);
  fs.writeFileSync(path.join(out, 'couleurs-xlsx.pdf'), styledPdf);
  assert.ok((await pdfText(styledPdf)).includes('2 340,00 €'));

  // PDF → Word et Excel : écriture, puis relecture par notre lecteur.
  const docx = office.writeDocx([
    { width: 595, height: 842, paragraphs: [{ text: 'Titre du document', size: 20, bold: true, font: 'Arial', align: 'center' }, { text: 'Première ligne\nDeuxième ligne & <suite>', size: 11, italic: true, font: 'Times New Roman' }] },
    { width: 595, height: 842, paragraphs: [{ text: 'Page deux', size: 11 }] },
  ]);
  fs.writeFileSync(path.join(out, 'export.docx'), docx);
  const back = await office.readDocx(docx, inflate);
  const texts = back.filter((i) => i.type === 'p').map((i) => i.runs.map((r) => r.text).join(''));
  assert.ok(texts.includes('Titre du document') && texts.includes('Première ligne\nDeuxième ligne & <suite>') && texts.includes('Page deux'));
  assert.ok(back.some((i) => i.type === 'break'), 'le saut de page doit être écrit');
  const title = back.find((i) => i.type === 'p' && i.runs[0] && i.runs[0].text === 'Titre du document');
  assert.ok(title.runs[0].bold && title.runs[0].size === 20 && title.align === 'center');

  assert.deepEqual(office.parseAmount('1 575,00 €'), { value: 1575, euro: true, decimals: 2 });
  assert.deepEqual(office.parseAmount('42,5'), { value: 42.5, euro: false, decimals: 1 });
  assert.equal(office.parseAmount('03100'), null, 'un code postal reste du texte');
  assert.equal(office.parseAmount('FIC-2026'), null);
  const xlsx = office.writeXlsx([{ name: 'Page 1', rows: [['Désignation', 'Total'], ['Carrelage', '756,00 €'], ['Code', '03100']] }, { name: 'Page 1', rows: [['x']] }]);
  fs.writeFileSync(path.join(out, 'export.xlsx'), xlsx);
  const sheetsBack = await office.readXlsx(xlsx, inflate);
  assert.deepEqual(sheetsBack.map((s) => s.name), ['Page 1', 'Page 1 2']);
  assert.deepEqual(sheetsBack[0].rows, [['Désignation', 'Total'], ['Carrelage', '756,00 €'], ['Code', '03100']]);
  // Apparence des cellules : gras, couleur du texte et fond sont écrits puis relus.
  const lookBook = office.writeXlsx([{ name: 'Styles', rows: [['Titre', '12,50 €'], ['x', 'y']], looks: [[{ bold: true, color: [1, 1, 1], fill: [0.12, 0.37, 0.82] }, { color: [0.7, 0.1, 0.1] }], [null, null]] }]);
  fs.writeFileSync(path.join(out, 'export-styles.xlsx'), lookBook);
  const looksBack = (await office.readXlsx(lookBook, inflate))[0];
  assert.ok(looksBack.styles[0][0].bold && blue(looksBack.styles[0][0].fill) && looksBack.styles[0][0].color[0] > 0.95);
  assert.ok(looksBack.styles[0][1].color[0] > 0.6 && looksBack.rows[0][1] === '12,50 €' && !looksBack.styles[1][0].bold && !looksBack.styles[1][0].fill);

  // Tableau d'une page → grille.
  const frag = (str, bx, by, iw) => ({ str, bx, by, ux: 1, uy: 0, iw, size: 10, lo: -3, hi: 10 });
  const grid = office.gridFromRows(Blocks.buildRows([
    frag('Désignation', 60, 700, 60), frag('Quantité', 250, 700, 40), frag('Total', 400, 700, 30),
    frag('Carrelage', 60, 680, 50), frag('18', 252, 680, 12), frag('756,00 €', 398, 680, 45),
  ]));
  assert.deepEqual([...grid], [['Désignation', 'Quantité', 'Total'], ['Carrelage', '18', '756,00 €']]);
  // En-tête centré au-dessus d'une colonne alignée à gauche : même colonne malgré des débuts différents.
  const centered = office.gridFromRows(Blocks.buildRows([
    frag('Désignation', 90, 700, 60), frag('Quantité', 250, 700, 40),
    frag('Carrelage grès cérame', 60, 680, 120), frag('18', 262, 680, 12),
    frag('Un paragraphe de texte courant qui traverse toute la page', 60, 640, 320),
  ]));
  assert.deepEqual([...centered], [['Désignation', 'Quantité'], ['Carrelage grès cérame', '18'], ['Un paragraphe de texte courant qui traverse toute la page', '']]);
  console.log('Conversions : tous les tests passent.');
})().catch((err) => { console.error(err); process.exit(1); });

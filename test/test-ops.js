// Tests du moteur, sans interface : node test/test-ops.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument, StandardFonts, degrees } = require('pdf-lib');
const ops = require('../src/pdfops.js');

async function sample(pageCount, label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${label} — page ${i}`, { x: 60, y: 760, size: 22, font });
    page.drawText('Facture numéro 2026-0042, montant à régler.', { x: 60, y: 720, size: 12, font });
  }
  return doc.save();
}

// PNG 1×1 valide.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

(async () => {
  const a = await sample(3, 'Document A');
  const b = await sample(2, 'Document B');
  const count = async (bytes) => (await PDFDocument.load(bytes)).getPageCount();

  const annotated = await ops.applyAnnotations(a, [
    { type: 'highlight', page: 1, x: 55, y: 715, w: 260, h: 18, color: [1, 0.86, 0.2] },
    { type: 'text', page: 2, x: 60, y: 600, size: 14, text: 'Validé à 100 % — Camille ✔', color: [0.1, 0.1, 0.1], rotate: 0 },
    { type: 'ink', page: 3, points: [[60, 500], [120, 520], [180, 490]], width: 1.8, color: [0.8, 0.1, 0.1] },
    { type: 'ink', page: 3, points: [[300, 300]], width: 1.8, color: [0.8, 0.1, 0.1] },
  ]);
  assert.equal(await count(annotated), 3);
  assert.ok(annotated.length > a.length, 'les annotations doivent ajouter du contenu');
  assert.equal(await ops.applyAnnotations(a, []), a, 'sans annotation, les octets sont rendus tels quels');

  const rotated = await ops.rotatePage(a, 2, 90);
  assert.equal((await PDFDocument.load(rotated)).getPage(1).getRotation().angle, 90);
  const back = await ops.rotatePage(rotated, 2, -180);
  assert.equal((await PDFDocument.load(back)).getPage(1).getRotation().angle, 270);

  assert.equal(await count(await ops.deletePage(a, 1)), 2);
  await assert.rejects(async () => ops.deletePage(await sample(1, 'Seule'), 1), /seule page/);
  assert.equal(await count(await ops.extractPages(a, [3])), 1);
  assert.equal(await count(await ops.merge([a, b])), 5);

  // Organisation des pages.
  const firstLine = async (bytes, index) => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
    const content = await (await (await task.promise).getPage(index)).getTextContent();
    await task.destroy();
    return content.items.map((i) => i.str).join(' ');
  };
  const movedPages = await ops.movePage(a, 3, 1);
  assert.match(await firstLine(movedPages, 1), /page 3/, 'la page 3 doit passer en tête');
  assert.match(await firstLine(movedPages, 2), /page 1/);
  assert.equal(await ops.movePage(a, 2, 2), a);
  const withBlank = await ops.insertBlankPage(a, 1);
  assert.equal(await count(withBlank), 4);
  assert.equal((await firstLine(withBlank, 2)).trim(), '', 'la page insérée est blanche');
  const inserted = await ops.insertPdf(a, b, 1);
  assert.equal(await count(inserted), 5);
  assert.match(await firstLine(inserted, 2), /Document B/);
  assert.match(await firstLine(inserted, 4), /Document A — page 2/);
  assert.deepEqual(ops.parseRange('1-3, 5, 8-', 9), [1, 2, 3, 5, 8, 9]);
  assert.deepEqual(ops.parseRange('-2', 9), [1, 2]);
  assert.throws(() => ops.parseRange('4-2', 9), /hors du document/);
  assert.throws(() => ops.parseRange('abc', 9), /invalide/);
  assert.match(await firstLine(await ops.numberPages(a), 2), /2 \/ 3/);
  assert.match(await firstLine(await ops.watermark(a, 'CONFIDENTIEL'), 1), /CONFIDENTIEL/);
  await assert.rejects(() => ops.watermark(a, '   '), /filigrane/);
  const stamped = await ops.applyAnnotations(a, [{ type: 'image', page: 1, kind: 'png', data: PNG, x: 100, y: 100, w: 80, h: 40 }]);
  assert.ok(stamped.length > a.length);
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'filigrane.pdf'), await ops.watermark(await ops.numberPages(a), 'CONFIDENTIEL'));

  // Formulaires : détection des champs, remplissage, relecture.
  const formDoc = await PDFDocument.create();
  const formPage = formDoc.addPage([595, 842]);
  const form = formDoc.getForm();
  form.createTextField('nom').addToPage(formPage, { x: 60, y: 700, width: 220, height: 22 });
  const note = form.createTextField('remarques');
  note.enableMultiline();
  note.addToPage(formPage, { x: 60, y: 600, width: 300, height: 70 });
  note.setFontSize(10);
  form.createCheckBox('accord').addToPage(formPage, { x: 60, y: 560, width: 16, height: 16 });
  const choice = form.createDropdown('ville');
  choice.addOptions(['Montluçon', 'Limoges', 'Clermont-Ferrand']);
  choice.addToPage(formPage, { x: 60, y: 520, width: 180, height: 22 });
  const radio = form.createRadioGroup('paiement');
  radio.addOptionToPage('Virement', formPage, { x: 60, y: 480, width: 14, height: 14 });
  radio.addOptionToPage('Chèque', formPage, { x: 160, y: 480, width: 14, height: 14 });
  const formBytes = await formDoc.save();
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'formulaire.pdf'), formBytes);
  const listed = await ops.listFormFields(formBytes);
  assert.deepEqual(listed.map((f) => `${f.name}:${f.kind}`), ['nom:text', 'remarques:text', 'accord:checkbox', 'ville:dropdown', 'paiement:radio', 'paiement:radio']);
  assert.ok(listed.every((f) => f.page === 1) && listed[1].multiline && listed[4].option === 'Virement' && listed[5].option === 'Chèque');
  // La zone inclut la bordure du champ (un demi-point de chaque côté).
  assert.deepEqual([listed[0].x, listed[0].y, listed[0].w, listed[0].h], [59.5, 699.5, 221, 23]);
  const filled = await ops.fillForm(formBytes, { nom: 'Élodie Durand ✔', remarques: 'Ligne une\nLigne deux', accord: true, ville: 'Limoges', paiement: 'Chèque' });
  const after = Object.fromEntries((await ops.listFormFields(filled)).map((f) => [f.name, f.value]));
  assert.deepEqual(after, { nom: 'Élodie Durand ', remarques: 'Ligne une\nLigne deux', accord: true, ville: 'Limoges', paiement: 'Chèque' });
  assert.deepEqual(await ops.listFormFields(a), [], 'un PDF sans formulaire ne liste aucun champ');

  // Commentaires : vraies annotations PDF, relues puis supprimées.
  const commented = await ops.applyAnnotations(a, [
    { type: 'comment', page: 1, x: 300, y: 700, text: 'À vérifier avec le client — montant TTC ?', author: 'Camille' },
    { type: 'comment', page: 3, x: 100, y: 500, text: 'Deuxième note' },
  ]);
  const notes = await ops.listComments(commented);
  assert.deepEqual(notes.map((n) => [n.page, n.x, n.y, n.text, n.author]), [[1, 300, 700, 'À vérifier avec le client — montant TTC ?', 'Camille'], [3, 100, 500, 'Deuxième note', 'Trombone']]);
  assert.deepEqual((await ops.listComments(await ops.removeComment(commented, 1, notes[0].index))).map((n) => n.text), ['Deuxième note']);
  assert.deepEqual(await ops.listComments(a), []);
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'commente.pdf'), commented);

  // Création de champs de formulaire, puis remplissage.
  const withFields = await ops.applyAnnotations(a, [
    { type: 'field', kind: 'text', name: 'champ_1', page: 1, x: 60, y: 640, w: 200, h: 20 },
    { type: 'field', kind: 'text', name: 'champ_1', page: 1, x: 60, y: 560, w: 300, h: 60 },
    { type: 'field', kind: 'checkbox', name: 'case_1', page: 2, x: 60, y: 640, w: 14, h: 14 },
  ]);
  const created = await ops.listFormFields(withFields);
  assert.deepEqual(created.map((f) => `${f.name}:${f.kind}:${f.page}:${f.multiline}`), ['champ_1:text:1:false', 'champ_1_2:text:1:true', 'case_1:checkbox:2:false']);
  const createdFilled = Object.fromEntries((await ops.listFormFields(await ops.fillForm(withFields, { champ_1: 'Bonjour', case_1: true }))).map((f) => [f.name, f.value]));
  assert.deepEqual(createdFilled, { champ_1: 'Bonjour', champ_1_2: '', case_1: true });

  // Mot de passe : le fichier chiffré ne s'ouvre qu'avec le bon mot de passe, et se déchiffre.
  const protect = require('../src/protect.js');
  const locked = await protect.encrypt(a, 'secret-123');
  await assert.rejects(() => PDFDocument.load(locked), /encrypted/i, 'le fichier doit être chiffré');
  await assert.rejects(() => protect.decrypt(locked, 'mauvais'), /Mot de passe incorrect/);
  assert.equal(await count(await protect.decrypt(locked, 'secret-123')), 3);
  await assert.rejects(() => protect.encrypt(a, ''), /mot de passe/);
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'protege.pdf'), locked);

  // Caviardage : la page devient une image, son texte d'origine disparaît du fichier.
  const jpeg = fs.readFileSync(path.join(__dirname, 'office', 'pixel.jpg'));
  const redacted = await ops.replacePageWithImage(a, 2, jpeg, { width: 595, height: 842 },
    [{ text: 'Texte conservé', x: 60, y: 760, x2: 200, y2: 760, size: 12 }], async (file) => fs.readFileSync(path.join(__dirname, '..', 'fonts', file)));
  assert.equal(await count(redacted), 3);
  const page2 = await firstLine(redacted, 2);
  assert.ok(/Texte conservé/.test(page2) && !/Facture/.test(page2), 'seul le texte reposé reste sur la page caviardée');
  assert.match(await firstLine(redacted, 1), /Facture/, 'les autres pages sont intactes');
  assert.match(await firstLine(redacted, 3), /page 3/);
  const untouched = await ops.applyAnnotations(a, [{ type: 'redact', page: 1, x: 10, y: 10, w: 50, h: 20 }]);
  assert.equal(await count(untouched), 3, 'une zone à caviarder ne dessine rien par elle-même');

  // Compression : les images sont remplacées par la version plus légère rendue par l'encodeur.
  const heavy = await ops.imagesToPdf([{ data: fs.readFileSync(path.join(__dirname, 'office', 'photo.png')), kind: 'png' }]);
  const seen = [];
  const light = await ops.recompressImages(heavy, async (image) => { seen.push(`${image.kind}:${image.width}x${image.height}:${image.channels}`); return { data: jpeg, width: 1, height: 1 }; });
  assert.deepEqual(seen, ['raw:200x120:3']);
  assert.ok(light.replaced === 1 && light.bytes.length < heavy.length, 'le fichier doit être plus léger');
  assert.equal(await count(light.bytes), 1);
  const kept = await ops.recompressImages(heavy, async () => null);
  assert.ok(kept.replaced === 0 && kept.bytes === heavy);

  const fromImages = await ops.imagesToPdf([{ data: PNG, kind: 'png' }, { data: PNG, kind: 'png' }]);
  assert.equal(await count(fromImages), 2);

  const fonts = await ops.listFonts(annotated);
  const names = fonts.map((f) => f.name);
  assert.ok(names.includes('Times-Roman') && names.includes('Helvetica'), `polices trouvées : ${names}`);
  assert.ok(fonts.every((f) => f.embedded === false), 'les polices standard ne sont pas embarquées');
  assert.deepEqual(fonts.find((f) => f.name === 'Times-Roman').pages, [1, 2, 3]);

  // Modification de texte : police reconnue, remplacée par l'équivalent libre, embarquée en entier.
  const m = ops.matchFont('ABCDEF+Calibri-Bold', 'sans-serif', {});
  assert.deepEqual([m.original, m.family, m.bold, m.file], ['Calibri-Bold', 'calibri', true, 'Carlito-Bold.ttf']);
  assert.equal(ops.matchFont('TimesNewRomanPS-ItalicMT', null, {}).file, 'Tinos-Italic.ttf');
  assert.equal(ops.matchFont('', 'monospace', {}).file, 'LiberationMono-Regular.ttf');
  assert.equal(ops.matchFont('ArialMT', 'serif', { bold: true, italic: true }).file, 'LiberationSans-BoldItalic.ttf');
  for (const [name, file] of [['Cambria-Bold', 'Caladea-Bold.ttf'], ['Georgia', 'Gelasio-Regular.ttf'], ['ComicSansMS', 'ComicNeue-Regular.ttf'], ['ArialNarrow', 'LiberationSansNarrow-Regular.ttf'],
    ['Verdana-Italic', 'DejaVuSans-Italic.ttf'], ['AGaramondPro-Regular', 'EBGaramond-Regular.ttf'], ['Roboto-Medium', 'Roboto-Regular.ttf'], ['RobotoMono-Regular', 'RobotoMono-Regular.ttf'],
    ['OpenSans-Semibold', 'OpenSans-Bold.ttf'], ['CourierNewPSMT', 'LiberationMono-Regular.ttf'], ['DejaVuSansMono', 'LiberationMono-Regular.ttf'], ['Helvetica-Oblique', 'LiberationSans-Italic.ttf'],
    ['SegoeUI', 'OpenSans-Regular.ttf'], ['Montserrat-Bold', 'Montserrat-Bold.ttf'], ['PoliceInconnue', 'LiberationSans-Regular.ttf']]) {
    assert.equal(ops.matchFont(name, null, {}).file, file, `police de remplacement pour ${name}`);
  }
  // Police absente : équivalent exact, police la plus proche, ou repli — et le nom montré à l'utilisateur.
  const fit = (name, generic) => { const m = ops.matchFont(name, generic, {}); return `${m.fit}:${m.family}:${m.wanted}`; };
  assert.equal(fit('ABCDEF+Calibri-Bold'), 'exact:calibri:Calibri');
  assert.equal(fit('Futura-Medium'), 'near:poppins:Futura');
  assert.equal(fit('GillSansMT-Bold'), 'near:lato:Gill Sans');
  assert.equal(fit('CenturyGothic'), 'near:poppins:Century Gothic');
  assert.equal(fit('Consolas'), 'near:robotomono:Consolas');
  assert.equal(fit('Palatino-Roman'), 'near:garamond:Palatino');
  assert.equal(fit('BodoniMT'), 'near:playfair:Bodoni');
  assert.equal(fit('Zapfino', 'serif'), 'fallback:serif:Zapfino');
  assert.equal(fit('', 'monospace'), 'fallback:mono:');
  for (const f of Object.values(ops.FAMILIES)) for (const v of ['Regular', 'Bold', 'Italic', 'BoldItalic']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'fonts', `${f.file}-${v}.ttf`)), `fichier ${f.file}-${v}.ttf`);
  const loadFont = async (file) => fs.readFileSync(path.join(__dirname, '..', 'fonts', file));
  // Chaque police embarquée doit pouvoir être écrite dans un PDF (une police mal lue ferait échouer l'enregistrement).
  assert.ok(Object.keys(ops.FAMILIES).length >= 25);
  for (const family of Object.keys(ops.FAMILIES)) {
    for (const [bold, italic] of [[false, false], [true, false], [false, true], [true, true]]) {
      const probe = { type: 'edit', page: 1, bx: 60, by: 600, iw: 10, size: 12, text: 'Été à Noël : 12,50 €', color: [0, 0, 0], bg: [1, 1, 1], family, bold, italic };
      await ops.applyAnnotations(a, [probe], loadFont);
    }
  }
  const edit = { type: 'edit', page: 1, bx: 60, by: 720, iw: 230, size: 12, text: 'Facture numéro 2026-0043, déjà réglée — œuvre ✔', color: [0, 0, 0], bg: [1, 1, 1], family: 'serif', bold: false, italic: false };
  const edited = await ops.applyAnnotations(a, [edit], loadFont);
  const tinos = (await ops.listFonts(edited)).find((f) => f.name === 'Tinos-Regular');
  assert.ok(tinos && tinos.embedded && !tinos.subset, 'Tinos doit être embarquée en entier');
  assert.equal(await count(await ops.applyAnnotations(a, [edit])), 3, 'sans chargeur de polices : repli sur les polices standard');

  // Bloc remis en page : deux lignes d'origine remplacées par trois nouvelles.
  const Blocks = require('../src/blocks.js');
  const frag = (str, bx, by, iw, size) => ({ str, bx, by, ux: 1, uy: 0, iw, size, lo: -0.22 * size - 1, hi: 0.9 * size + 1 });
  const fragments = [frag('Document A — page 1', 60, 760, 200, 22), frag('Facture numéro 2026-0042, montant à régler.', 60, 720, 230, 12)];
  const rowsBuilt = Blocks.buildRows(fragments);
  const blocksBuilt = Blocks.buildBlocks(rowsBuilt);
  assert.equal(blocksBuilt.length, 2, 'titre et texte de corps différent forment deux blocs');
  const body = blocksBuilt.find((b) => b.size === 12);
  const laid = Blocks.planBlock(body, 'Facture numéro 2026-0043 réglée le 12 novembre par virement bancaire.', {
    measure: (t, sz) => t.length * sz * 0.5, rows: rowsBuilt, page: [0, 0, 595, 842],
  });
  assert.ok(laid.lines.length === 1 && laid.overflow === 0, 'un bloc isolé peut s\'étendre jusqu\'à la marge de droite');
  const narrow = { ...body, flowing: true };
  const wrapped = Blocks.planBlock(narrow, 'un deux trois quatre cinq six sept huit neuf dix onze douze treize quatorze quinze seize dix-sept dix-huit', {
    measure: (t, sz) => t.length * sz * 0.5, rows: rowsBuilt, page: [0, 0, 595, 842],
  });
  assert.ok(wrapped.lines.length >= 3 && wrapped.lines.every((l) => l.text.length * 6 <= 230), 'un paragraphe revient à la ligne dans sa largeur');
  assert.equal(wrapped.lines[1].y, wrapped.lines[0].y - wrapped.leading);
  const blockEdit = {
    type: 'block', page: 1, boxes: body.items, covers: [], lines: wrapped.lines, ux: 1, uy: 0, size: wrapped.size,
    color: [0, 0, 0], bg: [1, 1, 1], family: 'sans', bold: false, italic: false, text: 'x',
  };
  const blockBytes = await ops.applyAnnotations(a, [blockEdit], loadFont);
  assert.ok((await ops.listFonts(blockBytes)).some((f) => f.name === 'LiberationSans-Regular' && f.embedded));
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'bloc.pdf'), blockBytes);

  const flat = ops.lineFrame({ bx: 100, by: 200, iw: 50, size: 10, lo: -3, hi: 9 });
  assert.deepEqual([flat.x, flat.y, flat.width, flat.height, flat.angle], [99, 197, 52, 12, 0]);
  const tilted = ops.lineFrame({ bx: 0, by: 0, ux: 0, uy: 1, iw: 50, size: 10, lo: -3, hi: 9 });
  assert.ok(Math.abs(tilted.x - 3) < 1e-9 && Math.abs(tilted.y + 1) < 1e-9 && Math.abs(tilted.angle - 90) < 1e-9);

  const out = path.join(__dirname, 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'exemple.pdf'), a);
  fs.writeFileSync(path.join(out, 'annote.pdf'), annotated);
  fs.writeFileSync(path.join(out, 'modifie.pdf'), edited);
  console.log('Moteur : tous les tests passent.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

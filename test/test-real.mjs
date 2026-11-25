// Modification de texte sur des PDF de producteurs variés : node test/test-real.mjs [dossier]
// Pour chaque fichier, modifie une ligne sur trois de la page 1 et vérifie, avec pdf.js, que
// l'ancien texte a disparu du fichier et qu'aucun autre texte n'a été emporté.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ops = require('../src/pdfops.js');
const root = path.dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] || path.join(root, 'samples');
const loadFont = async (file) => fs.readFileSync(path.join(root, '..', 'fonts', file));

const count = (text, into = new Map(), sign = 1) => {
  for (const ch of text.normalize('NFKC').replace(/\s+/g, '')) into.set(ch, (into.get(ch) || 0) + sign);
  return into;
};
async function items(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, useSystemFonts: false });
  const pdf = await task.promise;
  const content = await (await pdf.getPage(1)).getTextContent();
  await task.destroy();
  return content;
}

let failures = 0;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort()) {
  const bytes = fs.readFileSync(path.join(dir, file));
  const content = await items(bytes);
  const boxes = content.items
    .filter((it) => it.str && it.str.trim() && Math.abs(it.transform[1]) < 0.01 && Math.abs(it.transform[2]) < 0.01 && it.transform[0] > 0 && it.transform[3] > 0)
    .map((it) => ({ str: it.str, bx: it.transform[4], by: it.transform[5], iw: it.width, size: it.transform[3] }));
  const picked = boxes.filter((_, i) => i % 3 === 1).slice(0, 8);
  const edits = picked.map((b, i) => ({
    type: 'edit', page: 1, ...b, box: b, text: `Remplacé ${i + 1}`,
    color: [0, 0, 0], bg: [1, 1, 1], family: 'sans', bold: false, italic: false,
  }));
  const out = await ops.applyAnnotations(bytes, edits, loadFont, { pageLines: { 1: boxes } });
  if (process.env.KEEP) fs.writeFileSync(path.join(process.env.KEEP, file), out);
  const after = await items(out);
  const expected = count(content.items.map((it) => it.str).join(''));
  const actual = count(after.items.map((it) => it.str).join(''));
  for (const e of edits) { count(e.str, expected, -1); count(e.text, actual, -1); }
  let missing = 0;
  let leftover = 0;
  for (const [ch, n] of expected) {
    const have = actual.get(ch) || 0;
    if (have < n) missing += n - have;
    if (have > n) leftover += have - n;
  }
  const verdict = missing ? 'ÉCHEC : texte voisin emporté' : leftover ? 'partiel : ancien texte en partie conservé (masqué)' : 'propre';
  if (missing) failures++;
  console.log(`${file.padEnd(18)} ${String(boxes.length).padStart(3)} lignes, ${edits.length} modifiées → ${verdict} (manquants ${missing}, restants ${leftover})`);
}
process.exit(failures ? 1 : 0);

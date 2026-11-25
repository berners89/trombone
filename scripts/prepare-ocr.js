// Rassemble dans ocr/ le moteur Tesseract et le modèle français : node scripts/prepare-ocr.js
// (lancé automatiquement après npm install).
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'ocr');
const mod = (...p) => path.join(root, 'node_modules', ...p);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(mod('tesseract.js', 'dist', 'tesseract.min.js'), path.join(out, 'tesseract.min.js'));
fs.copyFileSync(mod('tesseract.js', 'dist', 'worker.min.js'), path.join(out, 'worker.min.js'));
for (const core of ['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm']) {
  fs.copyFileSync(mod('tesseract.js-core', `${core}.wasm.js`), path.join(out, `${core}.wasm.js`));
}
// Le modèle est stocké en base64 dans un fichier texte : ce format passe partout, y compris
// sur les hébergements qui ne servent pas les fichiers .traineddata.
for (const lang of ['fra', 'eng', 'deu', 'spa', 'ita']) {
  const model = fs.readFileSync(mod('@tesseract.js-data', lang, '4.0.0_best_int', `${lang}.traineddata.gz`));
  fs.writeFileSync(path.join(out, `${lang}.traineddata.gz.b64.txt`), model.toString('base64'));
}
fs.writeFileSync(path.join(out, 'worker-entry.js'), `// Point d'entrée du worker OCR : sert le modèle de langue embarqué au lieu de le télécharger.
const originalFetch = self.fetch.bind(self);
self.fetch = async (input, init) => {
  const url = String((input && input.url) || input);
  const match = url.match(/([a-z_]+)\\.traineddata(\\.gz)?$/);
  if (!match) return originalFetch(input, init);
  const res = await originalFetch(new URL(match[1] + '.traineddata.gz.b64.txt', self.location.href));
  if (!res.ok) return res;
  const binary = atob((await res.text()).trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes);
};
importScripts('worker.min.js');
`);
fs.writeFileSync(path.join(out, 'LICENCES.txt'), `Reconnaissance de texte (OCR)

- Tesseract.js et tesseract.js-core : licence Apache 2.0 — https://github.com/naptha/tesseract.js
- Moteur Tesseract OCR : licence Apache 2.0 — https://github.com/tesseract-ocr/tesseract
- Modèles de langue français, anglais, allemand, espagnol et italien (tessdata) : licence Apache 2.0 — https://github.com/tesseract-ocr/tessdata_best
`);
console.log(`ocr/ prêt : ${fs.readdirSync(out).length} fichiers`);

// Bibliothèques utilisées par l'interface, copiées dans vendor/ : l'application installée n'embarque
// ainsi que ces fichiers, pas tout node_modules.
const vendor = path.join(root, 'vendor');
fs.rmSync(vendor, { recursive: true, force: true });
fs.mkdirSync(path.join(vendor, 'pdfjs', 'build'), { recursive: true });
fs.copyFileSync(mod('pdf-lib', 'dist', 'pdf-lib.min.js'), path.join(vendor, 'pdf-lib.min.js'));
fs.copyFileSync(mod('@cantoo', 'pdf-lib', 'dist', 'pdf-lib.min.js'), path.join(vendor, 'pdf-lib-crypto.min.js'));
fs.copyFileSync(mod('@pdf-lib', 'fontkit', 'dist', 'fontkit.umd.min.js'), path.join(vendor, 'fontkit.umd.min.js'));
for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) fs.copyFileSync(mod('pdfjs-dist', 'build', file), path.join(vendor, 'pdfjs', 'build', file));
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) fs.cpSync(mod('pdfjs-dist', dir), path.join(vendor, 'pdfjs', dir), { recursive: true });
fs.copyFileSync(mod('pdfjs-dist', 'LICENSE'), path.join(vendor, 'pdfjs', 'LICENSE'));
console.log('vendor/ prêt');

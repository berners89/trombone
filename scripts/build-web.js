// Construit la version navigateur dans web/ : node scripts/build-web.js
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'web');
const pdfjs = path.join(root, 'node_modules', 'pdfjs-dist');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });
const copy = (from, to) => fs.cpSync(from, path.join(out, to), { recursive: true });

let html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
html = html
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n/, '')
  .replace('../vendor/fontkit.umd.min.js', 'vendor/fontkit.umd.min.js')
  .replace('../vendor/pdf-lib.min.js', 'vendor/pdf-lib.min.js')
  .replace('src="app.mjs"', 'src="app.js"');
fs.writeFileSync(path.join(out, 'index.html'), html);

fs.writeFileSync(path.join(out, 'styles.css'), fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8').replaceAll('../fonts/', 'fonts/'));
for (const file of fs.readdirSync(path.join(root, 'fonts'))) copy(path.join(root, 'fonts', file), `fonts/${file}`);
copy(path.join(root, 'samples', 'exemple-scan.pdf'), 'samples/exemple-scan.pdf');
for (const file of fs.readdirSync(path.join(root, 'ocr'))) copy(path.join(root, 'ocr', file), `ocr/${file}`);
copy(path.join(root, 'node_modules', '@pdf-lib', 'fontkit', 'dist', 'fontkit.umd.min.js'), 'vendor/fontkit.umd.min.js');
copy(path.join(root, 'src', 'pdfops.js'), 'pdfops.js');
copy(path.join(root, 'src', 'blocks.js'), 'blocks.js');
copy(path.join(root, 'src', 'office.js'), 'office.js');
copy(path.join(root, 'src', 'protect.js'), 'protect.js');
copy(path.join(root, 'node_modules', '@cantoo', 'pdf-lib', 'dist', 'pdf-lib.min.js'), 'vendor/pdf-lib-crypto.min.js');
copy(path.join(root, 'src', 'app.mjs'), 'app.js');
copy(path.join(root, 'src', 'platform-web.js'), 'platform.js');
copy(path.join(root, 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.min.js'), 'vendor/pdf-lib.min.js');
copy(path.join(pdfjs, 'build', 'pdf.min.mjs'), 'vendor/pdf.min.js');
copy(path.join(pdfjs, 'build', 'pdf.worker.min.mjs'), 'vendor/pdf.worker.min.js');
for (const dir of ['standard_fonts', 'wasm']) {
  fs.mkdirSync(path.join(out, 'vendor', dir), { recursive: true });
  for (const file of fs.readdirSync(path.join(pdfjs, dir))) {
    if (path.extname(file) && path.extname(file) !== '.pfb') copy(path.join(pdfjs, dir, file), `vendor/${dir}/${file}`);
  }
}
const files = fs.readdirSync(out, { recursive: true }).filter((f) => fs.statSync(path.join(out, f)).isFile());
console.log(`${files.length} fichiers dans web/`);

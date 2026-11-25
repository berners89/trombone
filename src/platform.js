// Plateforme Electron : window.trombone vient de preload.js, les bibliothèques de vendor/.
window.TROMBONE_CONFIG = {
  pdfjs: '../vendor/pdfjs/build/pdf.min.mjs',
  worker: '../vendor/pdfjs/build/pdf.worker.min.mjs',
  cMapUrl: '../vendor/pdfjs/cmaps/',
  standardFontDataUrl: '../vendor/pdfjs/standard_fonts/',
  wasmUrl: '../vendor/pdfjs/wasm/',
  iccUrl: '../vendor/pdfjs/iccs/',
  fonts: '../fonts/',
  ocr: '../ocr/',
  samples: '../samples/',
  canPrint: true,
  crypto: '../vendor/pdf-lib-crypto.min.js',
};

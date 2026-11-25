// Plateforme navigateur : mêmes fonctions que preload.js, sans rien installer.
// Les fichiers sont lus par le navigateur et ne quittent pas le poste.
(function () {
  window.TROMBONE_CONFIG = {
    pdfjs: 'vendor/pdf.min.js',
    worker: 'vendor/pdf.worker.min.js',
    standardFontDataUrl: 'vendor/standard_fonts/',
    wasmUrl: 'vendor/wasm/',
    fonts: 'fonts/',
    ocr: 'ocr/',
    samples: 'samples/',
    canPrint: false, // l'impression est bloquée dans une page hébergée
    crypto: 'vendor/pdf-lib-crypto.min.js',
  };

  const MESSAGES = {
    rate_limited: 'Une demande de téléchargement est déjà en cours : réessayez dans un instant.',
    too_large: 'Fichier trop volumineux pour être téléchargé depuis cette page.',
    host_unavailable: "Cette application ne peut pas enregistrer de fichier : ouvrez la page dans un navigateur sur ordinateur.",
  };

  async function download(filename, data) {
    const downloads = window.claude ? await window.claude.use('downloads') : null;
    if (!downloads) throw new Error('Le téléchargement est indisponible dans cette vue.');
    try {
      await downloads.save({ filename, data: new Blob([data]) });
      return filename;
    } catch (err) {
      if (err && err.code === 'declined') return null;
      throw new Error((err && MESSAGES[err.code]) || `Téléchargement impossible (${(err && err.code) || 'erreur'}).`);
    }
  }

  function pick({ extensions, multi }) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = !!multi;
      input.accept = extensions.map((e) => '.' + e).join(',');
      input.addEventListener('cancel', () => resolve([]));
      input.addEventListener('change', async () => {
        const files = [...input.files];
        resolve(await Promise.all(files.map(async (f) => ({ path: null, name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))));
      });
      input.click();
    });
  }

  // Archive ZIP sans compression (les PNG sont déjà compressés).
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
  function zip(entries) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const { name, data } of entries) {
      const nameBytes = enc.encode(name);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // noms en UTF-8
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      const head = new DataView(new ArrayBuffer(46));
      head.setUint32(0, 0x02014b50, true);
      head.setUint16(4, 20, true);
      head.setUint16(6, 20, true);
      head.setUint16(8, 0x0800, true);
      head.setUint32(16, crc, true);
      head.setUint32(20, data.length, true);
      head.setUint32(24, data.length, true);
      head.setUint16(28, nameBytes.length, true);
      head.setUint32(42, offset, true);
      parts.push(local, nameBytes, data);
      central.push(head, nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const size = central.reduce((n, p) => n + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end]);
  }

  let pending = [];
  window.trombone = {
    initialFile: async () => null,
    openFiles: pick,
    savePdf: (defaultPath, data) => download(String(defaultPath).split(/[\\/]/).pop(), data),
    chooseExportFolder: async () => { pending = []; return 'archive ZIP'; },
    writeExport: async (name, data) => { pending.push({ name, data }); },
    finishExport: async (filename) => {
      const entries = pending;
      pending = [];
      const saved = await download(filename, zip(entries));
      if (!saved) throw new Error('Export annulé.');
      return saved;
    },
  };
  window.TROMBONE_ZIP = zip; // exposé pour les tests
})();

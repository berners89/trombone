// Moteur : toutes les opérations prennent des octets PDF et rendent des octets PDF.
// Chargé tel quel dans l'interface (global PDFLib) et dans les tests Node (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('pdf-lib'), require('@pdf-lib/fontkit'));
  else root.PdfOps = factory(root.PDFLib, root.fontkit);
})(typeof self !== 'undefined' ? self : this, function (PDFLib, fontkit) {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFStream, PDFRawStream, decodePDFRawStream, StandardFonts, BlendMode, LineCapStyle, rgb, degrees } =
    PDFLib;

  async function load(bytes) {
    try {
      return await PDFDocument.load(bytes);
    } catch (err) {
      if (/encrypted/i.test(String(err && err.message))) {
        throw new Error('Ce PDF est protégé par mot de passe : modification impossible pour le moment.');
      }
      throw err;
    }
  }

  const color = (c) => rgb(c[0], c[1], c[2]);
  // Copie des octets dans un tampon propre : pdf-lib lit mal une image qui partage son tampon avec
  // d'autres données (cas des petits fichiers lus par Node).
  const own = (data) => new Uint8Array(data);

  // Polices libres embarquées.
  //   match : noms de polices dont celle-ci est l'équivalent (même dessin ou mêmes métriques) ;
  //   near  : polices du commerce absentes, dont celle-ci est la plus proche à l'œil ;
  //   file  : nom des fichiers ; word : police à déclarer dans Word ; note : police d'origine équivalente.
  const FAMILIES = {
    robotomono: { file: 'RobotoMono', label: 'Roboto Mono', match: /roboto ?mono/i, near: /consolas|lucida ?console|monaco|menlo|andale|source ?code|sf ?mono|fira ?(code|mono)/i, generic: 'monospace', word: 'Roboto Mono' },
    courierprime: { file: 'CourierPrime', label: 'Courier Prime', match: /courier ?prime/i, near: /american ?typewriter|prestige|letter ?gothic/i, generic: 'monospace', word: 'Courier Prime' },
    mono: { file: 'LiberationMono', label: 'Liberation Mono', match: /courier|liberation ?mono|cousine|nimbus ?mono/i, generic: 'monospace', word: 'Courier New', note: 'Courier', standard: 'Courier' },
    calibri: { file: 'Carlito', label: 'Carlito', match: /calibri|carlito/i, generic: 'sans-serif', word: 'Calibri', note: 'Calibri' },
    cambria: { file: 'Caladea', label: 'Caladea', match: /cambria|caladea/i, generic: 'serif', word: 'Cambria', note: 'Cambria' },
    georgia: { file: 'Gelasio', label: 'Gelasio', match: /georgia|gelasio/i, near: /charter|utopia|constantia/i, generic: 'serif', word: 'Georgia', note: 'Georgia' },
    comic: { file: 'ComicNeue', label: 'Comic Neue', match: /comic/i, near: /chalkboard|marker ?felt|kristen/i, generic: 'sans-serif', word: 'Comic Sans MS', note: 'Comic Sans' },
    narrow: { file: 'LiberationSansNarrow', label: 'Liberation Sans Narrow', match: /arial ?narrow|helvetica ?narrow|liberation ?sans ?narrow/i, near: /narrow|condensed|compressed/i, generic: 'sans-serif', word: 'Arial Narrow', note: 'Arial Narrow' },
    verdana: { file: 'DejaVuSans', label: 'DejaVu Sans', match: /verdana|dejavu ?sans(?! ?mono)|bitstream ?vera ?sans(?! ?mono)/i, near: /tahoma|lucida ?(sans|grande)|geneva/i, generic: 'sans-serif', word: 'Verdana', note: 'Verdana' },
    garamond: { file: 'EBGaramond', label: 'EB Garamond', match: /garamond/i, near: /palatino|book ?antiqua|sabon|minion|goudy|caslon|baskerville|jenson|bembo/i, generic: 'serif', word: 'Garamond', note: 'Garamond' },
    roboto: { file: 'Roboto', label: 'Roboto', match: /roboto/i, near: /sf ?(pro|ui)|san ?francisco|inter\b|helvetica ?neue|neue ?helvetica|univers|akzidenz/i, generic: 'sans-serif', word: 'Roboto' },
    opensans: { file: 'OpenSans', label: 'Open Sans', match: /open ?sans/i, near: /segoe|frutiger|myriad|trebuchet|droid ?sans/i, generic: 'sans-serif', word: 'Open Sans' },
    lato: { file: 'Lato', label: 'Lato', match: /lato/i, near: /gill ?sans|optima|candara|humanist/i, generic: 'sans-serif', word: 'Lato' },
    montserrat: { file: 'Montserrat', label: 'Montserrat', match: /montserrat/i, near: /gotham|proxima|din\b|din ?(pro|next|alternate)|franklin ?gothic|impact|bebas/i, generic: 'sans-serif', word: 'Montserrat' },
    notoserif: { file: 'NotoSerif', label: 'Noto Serif', match: /noto ?serif/i, near: /droid ?serif|pt ?serif/i, generic: 'serif', word: 'Noto Serif' },
    notosans: { file: 'NotoSans', label: 'Noto Sans', match: /noto ?sans/i, near: /pt ?sans|ubuntu/i, generic: 'sans-serif', word: 'Noto Sans' },
    nunito: { file: 'Nunito', label: 'Nunito', match: /nunito/i, near: /avenir|vag ?rounded|rounded|quicksand/i, generic: 'sans-serif', word: 'Nunito' },
    poppins: { file: 'Poppins', label: 'Poppins', match: /poppins/i, near: /futura|century ?gothic|avant ?garde|avantgarde|twentieth ?century|tw ?cen/i, generic: 'sans-serif', word: 'Poppins' },
    raleway: { file: 'Raleway', label: 'Raleway', match: /raleway/i, near: /corbel|museo ?sans/i, generic: 'sans-serif', word: 'Raleway' },
    playfair: { file: 'PlayfairDisplay', label: 'Playfair Display', match: /playfair/i, near: /didot|bodoni|modern ?no/i, generic: 'serif', word: 'Playfair Display' },
    merriweather: { file: 'Merriweather', label: 'Merriweather', match: /merriweather/i, near: /bookman|century ?school|rockwell|clarendon|cooper|memphis/i, generic: 'serif', word: 'Merriweather' },
    sourcesans: { file: 'SourceSans3', label: 'Source Sans 3', match: /source ?sans/i, near: /fira ?sans|whitney|thesis|thesans/i, generic: 'sans-serif', word: 'Source Sans 3' },
    libserif: { file: 'LiberationSerif', label: 'Liberation Serif', match: /liberation ?serif/i, generic: 'serif', word: 'Times New Roman' },
    sans: { file: 'LiberationSans', label: 'Liberation Sans', match: /arial|helvetica|liberation ?sans|arimo|nimbus ?sans/i, generic: 'sans-serif', word: 'Arial', note: 'Arial, Helvetica', standard: 'Helvetica' },
    serif: { file: 'Tinos', label: 'Tinos', match: /times|tinos|nimbus ?roman/i, generic: 'serif', word: 'Times New Roman', note: 'Times', standard: 'Times' },
  };
  // « GillSansMT-Bold » → « Gill Sans » : nom de la police sans ses suffixes de style ni de fonderie.
  function displayName(original) {
    let name = original;
    for (let previous = null; previous !== name;) {
      previous = name;
      name = name.replace(/[-, ]?(bold|italic|oblique|regular|medium|semibold|demi|light|black|heavy|book|roman|psmt|mt|ps|std|pro|lt)$/i, '');
    }
    return name.replace(/([a-z])([A-Z])/g, '$1 $2').trim() || original;
  }

  const variantOf = (bold, italic) => (bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular');
  const VARIANT_LABEL = { Regular: '', Bold: ' Gras', Italic: ' Italique', BoldItalic: ' Gras Italique' };

  // Reconnaît la police d'origine à partir de son nom PDF et choisit l'équivalent embarqué.
  // Sans ligatures : avec certaines polices (Carlito), « ti » ou « tt » fusionnés laissent un blanc à l'affichage.
  const NO_LIGATURES = { liga: false, clig: false, dlig: false };
  const OCR_FONT = 'TromboneOCR'; // nom de la police de la couche de texte invisible posée par l'OCR

  function matchFont(name, generic, flags) {
    const original = String(name || '').replace(/^[A-Z]{6}\+/, '');
    if (original.startsWith(OCR_FONT) || original.startsWith('FeuilletOCR')) { // ancien nom du logiciel
      // Texte issu d'un scan : la police réelle est inconnue, on réécrit en sans empattement.
      return { ocr: true, original: 'texte reconnu (OCR)', family: 'sans', bold: false, italic: false, file: 'LiberationSans-Regular.ttf', label: 'Liberation Sans' };
    }
    const bold = !!(flags && flags.bold) || /bold|black|heavy|semibold|demi/i.test(original);
    const italic = !!(flags && flags.italic) || /italic|oblique/i.test(original);
    // 1. Équivalent connu ; 2. police proche à l'œil ; 3. repli d'après le genre de la police.
    const keys = Object.keys(FAMILIES);
    let fit = 'exact';
    let family = keys.find((key) => FAMILIES[key].match.test(original));
    if (!family) {
      fit = 'near';
      family = keys.find((key) => FAMILIES[key].near && FAMILIES[key].near.test(original));
    }
    if (!family) {
      fit = 'fallback';
      family = /mono|typewriter|console/i.test(original) || generic === 'monospace' ? 'mono'
        : /sans|gothic|grotesk/i.test(original) ? 'sans'
          : /serif|roman|antiqua/i.test(original) || generic === 'serif' ? 'serif' : 'sans';
    }
    const variant = variantOf(bold, italic);
    return {
      original: original || '(nom inconnu)', family, bold, italic, fit: original ? fit : 'fallback',
      // Nom de la police d'origine sans ses suffixes de style, tel qu'on le montre à l'utilisateur.
      wanted: displayName(original),
      file: `${FAMILIES[family].file}-${variant}.ttf`,
      label: FAMILIES[family].label + VARIANT_LABEL[variant],
    };
  }

  /* ---------- suppression réelle d'un texte dans le flux de contenu de la page ---------- */

  const isSpace = (c) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
  const isDelim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
  const ascii = (b, from, to) => String.fromCharCode.apply(null, b.subarray(from, to));

  // Découpe un flux de contenu en opérations { name, args, start, end } sans rien modifier.
  function tokenize(b) {
    const ops = [];
    let i = 0;
    let args = [];
    const skipString = () => {
      let depth = 1;
      i++;
      while (i < b.length && depth > 0) {
        if (b[i] === 92) i++;
        else if (b[i] === 40) depth++;
        else if (b[i] === 41) depth--;
        i++;
      }
    };
    const skipUntilClose = (close) => {
      // tableau [...] ou dictionnaire <<...>> : on saute les chaînes qu'il contient
      while (i < b.length) {
        const c = b[i];
        if (c === 40) skipString();
        else if (c === 60 && b[i + 1] === 60) { i += 2; skipUntilClose(62); }
        else if (c === 91) { i++; skipUntilClose(93); }
        else if (c === close) { i += close === 62 ? 2 : 1; return; }
        else i++;
      }
    };
    while (i < b.length) {
      const c = b[i];
      if (isSpace(c)) { i++; continue; }
      if (c === 37) { while (i < b.length && b[i] !== 10 && b[i] !== 13) i++; continue; }
      const start = i;
      if (c === 40) { skipString(); args.push({ start, end: i }); continue; }
      if (c === 60) {
        if (b[i + 1] === 60) { i += 2; skipUntilClose(62); }
        else { while (i < b.length && b[i] !== 62) i++; i++; }
        args.push({ start, end: i });
        continue;
      }
      if (c === 91) { i++; skipUntilClose(93); args.push({ start, end: i }); continue; }
      if (c === 47) {
        i++;
        while (i < b.length && !isSpace(b[i]) && !isDelim(b[i])) i++;
        args.push({ start, end: i, name: ascii(b, start + 1, i) });
        continue;
      }
      if (c === 41 || c === 62 || c === 93 || c === 123 || c === 125) { i++; continue; }
      while (i < b.length && !isSpace(b[i]) && !isDelim(b[i])) i++;
      const word = ascii(b, start, i);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { args.push({ start, end: i, num: parseFloat(word) }); continue; }
      if (word === 'true' || word === 'false' || word === 'null') { args.push({ start, end: i }); continue; }
      if (word === 'BI') {
        // image en ligne : données binaires jusqu'à EI
        while (i < b.length && !(b[i] === 73 && b[i + 1] === 68 && isSpace(b[i + 2]))) i++;
        i += 3;
        while (i < b.length && !(isSpace(b[i - 1]) && b[i] === 69 && b[i + 1] === 73 && (i + 2 >= b.length || isSpace(b[i + 2]) || isDelim(b[i + 2])))) i++;
        i += 2;
        args = [];
        continue;
      }
      ops.push({ name: word, args, start: args.length ? args[0].start : start, end: i });
      args = [];
    }
    return ops;
  }

  const mul = (m, n) => [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
  const IDENTITY = [1, 0, 0, 1, 0, 0];
  const nums = (op) => op.args.map((a) => a.num);

  // Retire du flux les opérateurs d'affichage des lignes à supprimer.
  // lines : toutes les lignes connues de la page, { bx, by, iw, size, annot } en espace utilisateur ;
  // celles dont annot est renseigné sont supprimées. Rend { bytes, hits } ou null si rien n'a été trouvé.
  function stripText(bytes, lines) {
    // Ligne à laquelle appartient un affichage démarrant en (e, f) : celle qui le contient, sinon la
    // première qui commence juste après (les espaces de début de ligne ne font pas partie de la ligne).
    const locate = (px, py) => {
      let next = null;
      let gap = Infinity;
      for (const t of lines) {
        const dx = px - t.bx;
        const dy = py - t.by;
        const along = dx * t.ux + dy * t.uy; // le long de la ligne de base (qui peut être inclinée)
        const across = -dx * t.uy + dy * t.ux;
        if (Math.abs(across) > 0.5 + 0.03 * t.size) continue;
        if (along >= -0.5 - 0.05 * t.size && along < Math.max(t.iw, 0.2) - 0.1) return t;
        if (along < 0 && -along <= 1.5 * t.size && -along < gap) { next = t; gap = -along; }
      }
      return next;
    };
    const ops = tokenize(bytes);
    const changes = []; // { start, end, text }
    const hits = new Set();
    const stack = [];
    let gs = { ctm: IDENTITY, size: 0, th: 1, leading: 0, rise: 0, font: '' };
    let tm = IDENTITY;
    let tlm = IDENTITY;
    let known = false; // position de départ du prochain affichage connue avec certitude
    let run = null; // suite d'affichages en cours de suppression, sans repositionnement
    const move = (tx, ty) => { tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm; known = true; run = null; };
    const show = (op, prefix) => {
      const m = mul(tm, gs.ctm);
      const sx = Math.hypot(m[0], m[1]) || 1;
      let line = null;
      if (known) {
        const start = [gs.rise * m[2] + m[4], gs.rise * m[3] + m[5]];
        line = locate(start[0], start[1]);
        run = line ? { line, start, font: gs.font, removedFrom: null } : null;
      } else if (run && run.font === gs.font) {
        line = run.line; // suite immédiate de la même ligne, même police
      } else if (run) {
        // Changement de police sans repositionnement : ce texte commence là où finit la ligne précédente.
        const end = [run.line.bx + run.line.ux * run.line.iw, run.line.by + run.line.uy * run.line.iw];
        if (run.removedFrom !== null) {
          // Le texte qui précède est supprimé : on conserve l'emplacement de celui-ci.
          const advance = Math.hypot(end[0] - run.removedFrom[0], end[1] - run.removedFrom[1]) / sx;
          const unit = gs.size * gs.th;
          if (unit) changes.push({ start: op.start, end: op.start, text: `[${((-advance * 1000) / unit).toFixed(3)}] TJ ` });
        }
        line = locate(end[0], end[1]);
        run = line ? { line, start: end, font: gs.font, removedFrom: null } : null;
      }
      known = false;
      if (line && line.annot) {
        hits.add(line);
        if (run.removedFrom === null) run.removedFrom = run.start;
        changes.push({ start: op.start, end: op.end, text: prefix || '' });
      }
    };
    for (const op of ops) {
      const v = nums(op);
      switch (op.name) {
        case 'q': stack.push({ ...gs }); break;
        case 'Q': if (stack.length) gs = stack.pop(); break;
        case 'cm': if (v.length === 6) gs.ctm = mul(v, gs.ctm); break;
        case 'BT': tm = IDENTITY; tlm = IDENTITY; known = true; run = null; break;
        case 'ET': run = null; break;
        case 'Tf': gs.font = op.args[0] ? op.args[0].name : ''; gs.size = v[1] || 0; break;
        case 'Tz': gs.th = (v[0] || 100) / 100; break;
        case 'TL': gs.leading = v[0] || 0; break;
        case 'Ts': gs.rise = v[0] || 0; break;
        case 'Td': move(v[0] || 0, v[1] || 0); break;
        case 'TD': gs.leading = -(v[1] || 0); move(v[0] || 0, v[1] || 0); break;
        case 'Tm': if (v.length === 6) { tlm = v; tm = v; known = true; run = null; } break;
        case 'T*': move(0, -gs.leading); break;
        case 'Tj': case 'TJ': show(op); break;
        case "'": move(0, -gs.leading); show(op, 'T* '); break;
        case '"': move(0, -gs.leading); show(op, `${v[0] || 0} Tw ${v[1] || 0} Tc T* `); break;
        default: break;
      }
    }
    if (!hits.size) return null;
    changes.sort((p, q) => p.start - q.start || p.end - q.end);
    const parts = [];
    let at = 0;
    const enc = (text) => Uint8Array.from(text, (ch) => ch.charCodeAt(0));
    for (const c of changes) {
      parts.push(bytes.subarray(at, c.start), enc(c.text));
      at = Math.max(at, c.end);
    }
    parts.push(bytes.subarray(at));
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return { bytes: out, hits };
  }

  // Applique stripText au contenu d'une page ; rend l'ensemble des cibles effectivement supprimées.
  function removePageText(doc, page, lines) {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
    if (!streams.length || !streams.every((st) => st instanceof PDFRawStream)) return new Set();
    let chunks;
    try {
      chunks = streams.map((st) => decodePDFRawStream(st).decode());
    } catch {
      return new Set(); // filtre non pris en charge : on se contentera de masquer
    }
    const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length + 1, 0));
    let offset = 0;
    for (const c of chunks) { joined.set(c, offset); offset += c.length; joined[offset++] = 10; }
    const result = stripText(joined, lines);
    if (!result) return new Set();
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(result.bytes)));
    return result.hits;
  }

  // Annotations exprimées dans l'espace utilisateur PDF (origine en bas à gauche).
  // loadFont(nomDeFichier) rend les octets d'une police embarquée ; sans lui, polices PDF standard.
  // Direction de la ligne de base (horizontale par défaut).
  const direction = (l) => ({ ux: Number.isFinite(l.ux) ? l.ux : 1, uy: Number.isFinite(l.uy) ? l.uy : 0 });

  // Rectangle qui entoure une ligne, éventuellement inclinée : coin bas-gauche, dimensions, angle.
  // lo / hi : bas et haut de la ligne par rapport à la ligne de base ; pad : marge supplémentaire.
  function lineFrame(l) {
    const { ux, uy } = direction(l);
    const lo = Number.isFinite(l.lo) ? l.lo : -0.22 * l.size - 1;
    const hi = Number.isFinite(l.hi) ? l.hi : 0.9 * l.size + 1;
    const pad = l.pad || 0;
    const t = -1 - pad;
    const s = lo - pad / 2;
    return {
      x: l.bx + ux * t - uy * s, y: l.by + uy * t + ux * s,
      width: l.iw + 2 + 2 * pad, height: hi - lo + pad, angle: (Math.atan2(uy, ux) * 180) / Math.PI,
    };
  }

  // options.removeText (vrai par défaut) : supprime réellement l'ancien texte ; sinon, ou en cas
  // d'échec sur une ligne, l'ancien texte est seulement masqué par un rectangle.
  // options.pageLines : { numéroDePage: [lignes] }, chaque modification pointant sa ligne par a.box.
  async function applyAnnotations(bytes, annots, loadFont, options) {
    if (!annots.length) return bytes;
    const doc = await load(bytes);
    const removed = new Set();
    if (!options || options.removeText !== false) {
      const byPage = new Map();
      for (const a of annots) {
        if (a.type !== 'edit' && a.type !== 'block') continue;
        if (!byPage.has(a.page)) byPage.set(a.page, []);
        byPage.get(a.page).push(a);
      }
      for (const [number, edits] of byPage) {
        const target = doc.getPages()[number - 1];
        if (!target) continue;
        // Toutes les lignes de la page, quand l'appelant les fournit, rendent le repérage plus sûr.
        const known = options && options.pageLines && options.pageLines[number];
        // Fragments d'origine que chaque modification remplace : un seul pour une ligne, plusieurs pour un bloc.
        const sources = (a) => (a.type === 'block' ? a.boxes : [a.box || a]);
        const owner = (l) => edits.find((a) => sources(a).includes(l)) || null;
        const lines = (known || edits.flatMap(sources)).map((l) => ({ ...direction(l), bx: l.bx, by: l.by, iw: l.iw, size: l.size, annot: owner(l) }));
        const hit = removePageText(doc, target, lines);
        // Une modification n'est « supprimée proprement » que si tous ses fragments ont été retirés.
        for (const a of edits) {
          const mine = lines.filter((l) => l.annot === a);
          if (mine.length && mine.every((l) => hit.has(l))) removed.add(a);
        }
      }
    }
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const known = new Set(font.getCharacterSet());
    const pages = doc.getPages();
    const embedded = new Map();
    const fontFor = async (a) => {
      const family = FAMILIES[a.family] ? a.family : 'sans';
      const match = { file: `${FAMILIES[family].file}-${variantOf(a.bold, a.italic)}.ttf` };
      const key = loadFont ? match.file : `std:${a.family}:${variantOf(a.bold, a.italic)}`;
      if (!embedded.has(key)) {
        if (loadFont) {
          doc.registerFontkit(fontkit);
          // Police complète (non réduite) : le texte reste modifiable ensuite avec tous ses caractères.
          embedded.set(key, await doc.embedFont(await loadFont(match.file), { features: NO_LIGATURES, customName: match.file.replace(/\.ttf$/, '') }));
        } else {
          const base = (FAMILIES[a.family] && FAMILIES[a.family].standard) || (FAMILIES[a.family] && FAMILIES[a.family].generic === 'serif' ? 'Times' : FAMILIES[a.family] && FAMILIES[a.family].generic === 'monospace' ? 'Courier' : 'Helvetica');
          const variant = variantOf(a.bold, a.italic);
          const name =
            base === 'Times'
              ? { Regular: 'TimesRoman', Bold: 'TimesRomanBold', Italic: 'TimesRomanItalic', BoldItalic: 'TimesRomanBoldItalic' }[variant]
              : base + { Regular: '', Bold: 'Bold', Italic: 'Oblique', BoldItalic: 'BoldOblique' }[variant];
          embedded.set(key, await doc.embedFont(StandardFonts[name]));
        }
      }
      return embedded.get(key);
    };
    for (const a of annots) {
      const page = pages[a.page - 1];
      if (!page || a.type === 'redact') continue; // le caviardage est traité à part (page remplacée par une image)
      if (a.type === 'comment') {
        // Vraie annotation PDF (note de commentaire) : elle reste lisible et modifiable dans tout lecteur.
        const { PDFHexString, PDFString } = PDFLib;
        const note = doc.context.obj({ Type: 'Annot', Subtype: 'Text', Name: 'Comment', Rect: [a.x, a.y - 20, a.x + 20, a.y], C: [1, 0.82, 0.2], F: 4, Open: false });
        note.set(PDFName.of('Contents'), PDFHexString.fromText(String(a.text)));
        note.set(PDFName.of('T'), PDFHexString.fromText(String(a.author || 'Trombone')));
        note.set(PDFName.of('M'), PDFString.fromDate(new Date()));
        page.node.addAnnot(doc.context.register(note));
      } else if (a.type === 'field') {
        // Nouveau champ de formulaire ; le nom est rendu unique s'il existe déjà.
        const form = doc.getForm();
        const taken = new Set(form.getFields().map((f) => f.getName()));
        let name = a.name;
        for (let k = 2; taken.has(name); k++) name = `${a.name}_${k}`;
        const box = { x: a.x, y: a.y, width: a.w, height: a.h, borderWidth: 0.75 };
        if (a.kind === 'checkbox') form.createCheckBox(name).addToPage(page, box);
        else {
          const field = form.createTextField(name);
          if (a.h > 40) field.enableMultiline();
          field.addToPage(page, box);
          field.setFontSize(a.h > 40 ? 10 : Math.max(7, Math.min(11, a.h * 0.6)));
        }
      } else if (a.type === 'image') {
        // Image ou signature posée sur la page.
        const picture = a.kind === 'jpg' ? await doc.embedJpg(own(a.data)) : await doc.embedPng(own(a.data));
        page.drawImage(picture, { x: a.x, y: a.y, width: a.w, height: a.h });
      } else if (a.type === 'block') {
        // Bloc de texte remis en page : on cache les anciennes lignes, on écrit les nouvelles.
        if (a.cover || !removed.has(a)) {
          for (const cover of a.covers) {
            const frame = lineFrame(cover);
            page.drawRectangle({ x: frame.x, y: frame.y, width: frame.width, height: frame.height, rotate: degrees(frame.angle), color: color(a.bg) });
          }
        }
        if (a.mode === 'image') {
          // Bloc d'un scan déplacé tel quel : on recolle le morceau d'image, et le texte invisible le suit.
          const picture = await doc.embedPng(own(a.image.data));
          page.drawImage(picture, { x: a.image.x + a.dx, y: a.image.y + a.dy, width: a.image.w, height: a.image.h });
          if (loadFont) {
            if (!embedded.has('ocr')) {
              doc.registerFontkit(fontkit);
              embedded.set('ocr', await doc.embedFont(await loadFont('LiberationSans-Regular.ttf'), { features: NO_LIGATURES, customName: OCR_FONT }));
            }
            const hiddenFont = embedded.get('ocr');
            const key = page.node.newFontDictionary(OCR_FONT, hiddenFont.ref);
            const known = new Set(hiddenFont.getCharacterSet());
            const moved = a.hidden.map((l) => ({ ...l, x: l.x + a.dx, y: l.y + a.dy, x2: l.x2 + a.dx, y2: l.y2 + a.dy }));
            const operators = moved.flatMap((l) => invisibleLine(hiddenFont, key, known, l));
            if (operators.length) page.pushOperators(...operators);
          }
          continue;
        }
        const f = await fontFor(a);
        const chars = new Set(f.getCharacterSet());
        const angle = (Math.atan2(a.uy || 0, Number.isFinite(a.ux) ? a.ux : 1) * 180) / Math.PI;
        for (const line of a.lines) {
          const text = Array.from(line.text).filter((ch) => chars.has(ch.codePointAt(0))).join('');
          if (text) page.drawText(text, { x: line.x, y: line.y, size: a.size, font: f, color: color(a.color), rotate: degrees(angle) });
        }
      } else if (a.type === 'edit') {
        // Remplacement d'un texte existant : cache l'ancien, réécrit le nouveau au même endroit.
        const frame = lineFrame(a);
        if (a.cover || !removed.has(a)) {
          page.drawRectangle({ x: frame.x, y: frame.y, width: frame.width, height: frame.height, rotate: degrees(frame.angle), color: color(a.bg) });
        }
        if (a.text) {
          const f = await fontFor(a);
          const chars = loadFont ? null : new Set(f.getCharacterSet());
          const text = chars ? Array.from(a.text).filter((ch) => chars.has(ch.codePointAt(0))).join('') : a.text;
          if (text) page.drawText(text, { x: a.bx, y: a.by, size: a.size, font: f, color: color(a.color), rotate: degrees(frame.angle) });
        }
      } else if (a.type === 'highlight') {
        page.drawRectangle({
          x: a.x, y: a.y, width: a.w, height: a.h,
          color: color(a.color), opacity: 0.4, blendMode: BlendMode.Multiply,
        });
      } else if (a.type === 'text') {
        // Helvetica standard : on écarte les caractères hors WinAnsi plutôt que d'échouer.
        const text = Array.from(a.text).filter((ch) => known.has(ch.codePointAt(0))).join('');
        if (text) {
          page.drawText(text, {
            x: a.x, y: a.y, size: a.size, font, color: color(a.color), rotate: degrees(a.rotate || 0),
          });
        }
      } else if (a.type === 'ink') {
        const pts = a.points.length === 1 ? [a.points[0], a.points[0]] : a.points;
        for (let i = 1; i < pts.length; i++) {
          page.drawLine({
            start: { x: pts[i - 1][0], y: pts[i - 1][1] },
            end: { x: pts[i][0], y: pts[i][1] },
            thickness: a.width, color: color(a.color), lineCap: LineCapStyle.Round,
          });
        }
      }
    }
    return doc.save();
  }

  // Pose une couche de texte invisible sur des pages scannées.
  // layers : { numéroDePage: [{ text, x, y, x2, y2, size }] } — ligne de base de (x, y) à (x2, y2), en points PDF.
  // Opérateurs d'une ligne de texte invisible, étirée pour couvrir exactement de (x, y) à (x2, y2).
  function invisibleLine(font, key, known, line) {
    const { pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextMatrix, setTextRenderingMode, TextRenderingMode, setCharacterSqueeze, showText } = PDFLib;
    const dx = line.x2 - line.x;
    const dy = line.y2 - line.y;
    const length = Math.hypot(dx, dy);
    const text = Array.from(line.text).filter((ch) => known.has(ch.codePointAt(0))).join('').trim();
    if (!text || length < 1 || !(line.size > 0)) return [];
    const natural = font.widthOfTextAtSize(text, line.size);
    if (!natural) return [];
    const cos = dx / length;
    const sin = dy / length;
    return [
      pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible),
      setFontAndSize(key, line.size), setCharacterSqueeze((100 * length) / natural),
      setTextMatrix(cos, sin, -sin, cos, line.x, line.y), showText(font.encodeText(text)),
      endText(), popGraphicsState(),
    ];
  }

  async function addTextLayer(bytes, layers, loadFont) {
    const doc = await load(bytes);
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(await loadFont('LiberationSans-Regular.ttf'), { features: NO_LIGATURES, customName: OCR_FONT });
    const known = new Set(font.getCharacterSet());
    const pages = doc.getPages();
    for (const [number, lines] of Object.entries(layers)) {
      const page = pages[Number(number) - 1];
      if (!page || !lines.length) continue;
      const key = page.node.newFontDictionary(OCR_FONT, font.ref);
      const operators = lines.flatMap((line) => invisibleLine(font, key, known, line));
      if (operators.length) page.pushOperators(...operators);
    }
    return doc.save();
  }

  async function rotatePage(bytes, pageNumber, delta) {
    const doc = await load(bytes);
    const page = doc.getPage(pageNumber - 1);
    const next = (((page.getRotation().angle + delta) % 360) + 360) % 360;
    page.setRotation(degrees(next));
    return doc.save();
  }

  // Déplace une page : de la position `from` à la position `to` (numéros à partir de 1).
  async function movePage(bytes, from, to) {
    const doc = await load(bytes);
    const count = doc.getPageCount();
    if (from < 1 || from > count || to < 1 || to > count) throw new Error('Numéro de page hors du document.');
    if (from === to) return bytes;
    const page = doc.getPage(from - 1);
    doc.removePage(from - 1);
    doc.insertPage(to - 1, page);
    return doc.save();
  }

  // Insère une page blanche après la page indiquée (0 : au début), au format de la page voisine.
  async function insertBlankPage(bytes, after) {
    const doc = await load(bytes);
    const model = doc.getPage(Math.max(0, Math.min(doc.getPageCount() - 1, after - 1)));
    const { width, height } = model.getSize();
    doc.insertPage(after, [width, height]);
    return doc.save();
  }

  // Insère toutes les pages d'un autre PDF après la page indiquée (0 : au début).
  async function insertPdf(bytes, other, after) {
    const doc = await load(bytes);
    const source = await load(other);
    const copied = await doc.copyPages(source, source.getPageIndices());
    copied.forEach((page, index) => doc.insertPage(after + index, page));
    return doc.save();
  }

  // « 1-3, 5, 8- » → [1, 2, 3, 5, 8, 9, …] ; lève une erreur si la plage est invalide.
  function parseRange(text, count) {
    const pages = [];
    for (const part of String(text).split(/[,;]/).map((t) => t.trim()).filter(Boolean)) {
      const match = part.match(/^(\d+)?\s*(-)?\s*(\d+)?$/);
      if (!match || (!match[1] && !match[3])) throw new Error(`Plage de pages invalide : « ${part} ».`);
      const start = match[1] ? Number(match[1]) : 1;
      const end = match[2] ? (match[3] ? Number(match[3]) : count) : start;
      if (start < 1 || end > count || start > end) throw new Error(`Plage de pages hors du document : « ${part} » (1 à ${count}).`);
      for (let n = start; n <= end; n++) pages.push(n);
    }
    if (!pages.length) throw new Error('Indiquez au moins une page, par exemple 1-3, 5.');
    return pages;
  }

  /* ---------- caviardage et compression ---------- */

  // Remplace une page par son image (déjà caviardée), au même format. Tout le contenu d'origine de la
  // page disparaît du fichier : texte, images, annotations. lines : texte invisible à reposer pour que
  // le reste de la page demeure cherchable, { text, x, y, x2, y2, size } dans le repère de la nouvelle page.
  async function replacePageWithImage(bytes, pageNumber, jpeg, size, lines, loadFont) {
    const doc = await load(bytes);
    const picture = await doc.embedJpg(own(jpeg));
    doc.removePage(pageNumber - 1);
    const page = doc.insertPage(pageNumber - 1, [size.width, size.height]);
    page.drawImage(picture, { x: 0, y: 0, width: size.width, height: size.height });
    if (lines && lines.length && loadFont) {
      doc.registerFontkit(fontkit);
      const font = await doc.embedFont(await loadFont('LiberationSans-Regular.ttf'), { features: NO_LIGATURES, customName: OCR_FONT });
      const known = new Set(font.getCharacterSet());
      const key = page.node.newFontDictionary(OCR_FONT, font.ref);
      const operators = lines.flatMap((line) => invisibleLine(font, key, known, line));
      if (operators.length) page.pushOperators(...operators);
    }
    return doc.save();
  }

  // Recompresse les images du document. encode({ kind: 'jpeg' | 'raw', data, width, height, channels })
  // rend { data, width, height } (un JPEG plus léger) ou null pour laisser l'image telle quelle.
  // Rend { bytes, images, replaced }.
  async function recompressImages(bytes, encode) {
    const doc = await load(bytes);
    const name = (dict, key) => { const v = dict.lookup(PDFName.of(key)); return v instanceof PDFName ? v.asString().slice(1) : null; };
    const number = (dict, key) => { const v = dict.lookup(PDFName.of(key)); return v && v.asNumber ? v.asNumber() : 0; };
    let images = 0;
    let replaced = 0;
    for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream) || name(object.dict, 'Subtype') !== 'Image') continue;
      const dict = object.dict;
      if (dict.has(PDFName.of('ImageMask')) || dict.has(PDFName.of('DecodeParms')) || dict.has(PDFName.of('Decode'))) continue;
      const width = number(dict, 'Width');
      const height = number(dict, 'Height');
      // Espaces de couleur simples uniquement : gris ou RVB (directs ou via un profil ICC).
      const space = dict.lookup(PDFName.of('ColorSpace'));
      let channels = space instanceof PDFName ? { DeviceRGB: 3, DeviceGray: 1 }[space.asString().slice(1)] : 0;
      if (space instanceof PDFArray && space.size() === 2 && String(space.lookup(0)) === '/ICCBased') {
        const profile = space.lookup(1);
        channels = profile instanceof PDFStream ? number(profile.dict, 'N') : 0;
      }
      if (!width || !height || (channels !== 1 && channels !== 3) || number(dict, 'BitsPerComponent') !== 8) continue;
      const filter = name(dict, 'Filter');
      let input = null;
      if (filter === 'DCTDecode') input = { kind: 'jpeg', data: object.contents, width, height, channels };
      else if (filter === 'FlateDecode') {
        try {
          const raw = decodePDFRawStream(object).decode();
          if (raw.length >= width * height * channels) input = { kind: 'raw', data: raw, width, height, channels };
        } catch { /* flux illisible : image conservée */ }
      }
      if (!input) continue;
      images++;
      const output = await encode(input);
      if (!output || output.data.length >= object.contents.length * 0.9) continue;
      const next = dict.clone(doc.context);
      next.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
      next.set(PDFName.of('Width'), doc.context.obj(output.width));
      next.set(PDFName.of('Height'), doc.context.obj(output.height));
      next.set(PDFName.of('ColorSpace'), PDFName.of(output.gray ? 'DeviceGray' : 'DeviceRGB'));
      next.set(PDFName.of('Length'), doc.context.obj(output.data.length));
      doc.context.assign(ref, PDFRawStream.of(next, output.data));
      replaced++;
    }
    return { bytes: replaced ? await doc.save() : bytes, images, replaced };
  }

  /* ---------- commentaires ---------- */

  // Notes de commentaire présentes dans le document : { page, index, x, y, text, author }.
  async function listComments(bytes) {
    let doc;
    try { doc = await load(bytes); } catch { return []; }
    const out = [];
    const text = (value) => (value && value.decodeText ? value.decodeText() : '');
    doc.getPages().forEach((page, p) => {
      const annots = page.node.Annots();
      if (!annots) return;
      for (let index = 0; index < annots.size(); index++) {
        const annot = annots.lookup(index);
        if (!(annot instanceof PDFDict) || String(annot.lookup(PDFName.of('Subtype'))) !== '/Text') continue;
        const rect = annot.lookup(PDFName.of('Rect'));
        if (!(rect instanceof PDFArray) || rect.size() < 4) continue;
        const [x1, y1, x2, y2] = [0, 1, 2, 3].map((i) => rect.lookup(i).asNumber());
        out.push({ page: p + 1, index, x: Math.min(x1, x2), y: Math.max(y1, y2), text: text(annot.lookup(PDFName.of('Contents'))), author: text(annot.lookup(PDFName.of('T'))) });
      }
    });
    return out;
  }

  async function removeComment(bytes, pageNumber, index) {
    const doc = await load(bytes);
    const annots = doc.getPage(pageNumber - 1).node.Annots();
    if (!annots || index >= annots.size()) throw new Error('Commentaire introuvable.');
    annots.remove(index);
    return doc.save();
  }

  /* ---------- formulaires ---------- */

  const fieldKind = (field) => {
    const { PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList } = PDFLib;
    if (field instanceof PDFTextField) return 'text';
    if (field instanceof PDFCheckBox) return 'checkbox';
    if (field instanceof PDFDropdown) return 'dropdown';
    if (field instanceof PDFRadioGroup) return 'radio';
    if (field instanceof PDFOptionList) return 'list';
    return null; // boutons, signatures : non gérés
  };

  // Champs à remplir d'un PDF : un élément par zone affichée (un groupe de boutons radio en a plusieurs).
  async function listFormFields(bytes) {
    let doc;
    let fields;
    try {
      doc = await load(bytes);
      fields = doc.getForm().getFields();
    } catch {
      return []; // pas de formulaire lisible
    }
    const pages = doc.getPages();
    const pageOf = (widget) => {
      const direct = pages.findIndex((page) => page.ref === widget.P());
      if (direct >= 0) return direct + 1;
      const ref = doc.context.getObjectRef(widget.dict);
      const index = pages.findIndex((page) => { const annots = page.node.Annots(); return annots && annots.asArray().includes(ref); });
      return index + 1;
    };
    const out = [];
    for (const field of fields) {
      const kind = fieldKind(field);
      if (!kind) continue;
      let value = '';
      let options = [];
      try {
        if (kind === 'text') value = field.getText() || '';
        else if (kind === 'checkbox') value = field.isChecked();
        else { options = field.getOptions(); const chosen = field.getSelected(); value = Array.isArray(chosen) ? chosen[0] || '' : chosen || ''; }
      } catch { /* valeur illisible : champ laissé vide */ }
      field.acroField.getWidgets().forEach((widget, index) => {
        const page = pageOf(widget);
        if (!page) return;
        const rect = widget.getRectangle();
        out.push({
          name: field.getName(), kind, page, x: rect.x, y: rect.y, w: rect.width, h: rect.height, value, options,
          option: kind === 'radio' ? options[index] : undefined,
          multiline: kind === 'text' && field.isMultiline(), readOnly: field.isReadOnly(),
        });
      });
    }
    return out;
  }

  // Enregistre les valeurs saisies : { nomDuChamp: valeur }.
  async function fillForm(bytes, values) {
    const doc = await load(bytes);
    const form = doc.getForm();
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    const known = new Set(helvetica.getCharacterSet());
    const clean = (text) => Array.from(String(text)).filter((ch) => ch === '\n' || known.has(ch.codePointAt(0))).join('');
    for (const field of form.getFields()) {
      const name = field.getName();
      if (!(name in values) || field.isReadOnly()) continue;
      const value = values[name];
      const kind = fieldKind(field);
      if (kind === 'text') {
        const text = clean(value);
        // Champ sans taille de texte définie : la taille automatique donne des lettres énormes dans une
        // grande zone. On fixe une taille lisible, proportionnée à la hauteur du champ.
        const appearance = field.acroField.getDefaultAppearance() || '';
        const declared = Number((appearance.match(/([\d.]+)\s+Tf/) || [])[1] || 0);
        if (!declared) {
          const widget = field.acroField.getWidgets()[0];
          const tall = widget ? widget.getRectangle().height : 14;
          field.setFontSize(field.isMultiline() ? 10 : Math.max(7, Math.min(11, tall * 0.6)));
        }
        const max = field.getMaxLength();
        field.setText(max ? text.slice(0, max) : text);
      } else if (kind === 'checkbox') {
        if (value) field.check(); else field.uncheck();
      } else if (kind === 'radio' || kind === 'dropdown' || kind === 'list') {
        if (value && field.getOptions().includes(value)) field.select(value);
        else if (!value && kind !== 'radio') field.clear();
      }
    }
    form.updateFieldAppearances(helvetica);
    return doc.save();
  }

  /* ---------- Word et Excel vers PDF ---------- */

  // Carnet de polices d'un document en construction : une police par (famille, gras, italique).
  function fontBook(doc, loadFont) {
    doc.registerFontkit(fontkit);
    const cache = new Map();
    return async (name, bold, italic) => {
      const match = matchFont(name || 'Arial', null, { bold: !!bold, italic: !!italic });
      if (!cache.has(match.file)) {
        const font = await doc.embedFont(await loadFont(match.file), { features: NO_LIGATURES, customName: match.file.replace(/\.ttf$/, '') });
        cache.set(match.file, { font, known: new Set(font.getCharacterSet()) });
      }
      return cache.get(match.file);
    };
  }
  const printable = (entry, text) => Array.from(text).filter((ch) => entry.known.has(ch.codePointAt(0))).join('');

  // Éléments lus par Office.readDocx → PDF. Texte avec ses couleurs, fonds, soulignements, titres,
  // listes, images et tableaux (largeurs, fonds de cellule, bordures), au format et aux marges du document.
  async function docToPdf(items, loadFont) {
    const doc = await PDFDocument.create();
    const fontOf = fontBook(doc, loadFont);
    const format = items.page || { width: 595.28, height: 841.89, top: 56.7, right: 56.7, bottom: 56.7, left: 56.7 };
    const W = format.width;
    const H = format.height;
    const BLACK = [0, 0, 0];
    let page = doc.addPage([W, H]);
    let y = H - format.top;
    const newPage = () => { page = doc.addPage([W, H]); y = H - format.top; };

    // Découpe un paragraphe en lignes tenant dans la largeur donnée.
    const layout = async (p, width) => {
      const pieces = [];
      const runs = p.bullet ? [{ ...p.base, text: '•  ' }, ...p.runs] : p.runs;
      for (const run of runs) {
        const entry = await fontOf(run.font, run.bold, run.italic);
        const size = run.size || 11;
        for (const token of String(run.text).split(/(\n|[ \t]+)/)) {
          if (!token) continue;
          if (token === '\n') { pieces.push({ newline: true, size }); continue; }
          const text = printable(entry, token);
          pieces.push({ text, font: entry.font, size, width: entry.font.widthOfTextAtSize(text, size), space: /^[ \t]+$/.test(token), color: run.color, underline: run.underline, fill: run.fill });
        }
      }
      const base = (p.base && p.base.size) || 11;
      const lines = [];
      let current = { parts: [], width: 0, size: 0 };
      let first = true;
      const room = () => width - (first ? Math.max(0, p.firstLine || 0) : 0);
      const push = () => {
        while (current.parts.length && current.parts[current.parts.length - 1].space) current.width -= current.parts.pop().width;
        if (!current.size) current.size = base;
        current.shift = first ? Math.max(0, p.firstLine || 0) : 0;
        lines.push(current);
        current = { parts: [], width: 0, size: 0 };
        first = false;
      };
      for (const piece of pieces) {
        if (piece.newline) { if (!current.size) current.size = piece.size; push(); continue; }
        if (!piece.space && current.parts.length && current.width + piece.width > room()) push();
        if (piece.space && !current.parts.length) continue;
        current.parts.push(piece);
        current.width += piece.width;
        current.size = Math.max(current.size, piece.size);
      }
      push();
      return lines;
    };
    // Dessine des lignes à partir de `top` ; fill : fond du paragraphe, bar : filet à gauche.
    const drawLines = (lines, x0, width, p, top) => {
      let cursor = top;
      for (const line of lines) {
        const height = line.size * 1.25;
        if (p.fill) page.drawRectangle({ x: x0 - 2, y: cursor - height, width: width + 4, height, color: color(p.fill) });
        if (p.bar) page.drawRectangle({ x: x0 - 2 - p.bar.space - p.bar.width, y: cursor - height, width: p.bar.width, height, color: color(p.bar.color) });
        const free = width - line.shift - line.width;
        let x = x0 + line.shift + (p.align === 'center' ? free / 2 : p.align === 'right' ? free : 0);
        for (const part of line.parts) {
          if (part.fill) page.drawRectangle({ x, y: cursor - height, width: part.width, height, color: color(part.fill) });
          if (!part.space && part.text) page.drawText(part.text, { x, y: cursor - line.size * 0.95, size: part.size, font: part.font, color: color(part.color || BLACK) });
          if (part.underline) page.drawLine({ start: { x, y: cursor - line.size * 1.06 }, end: { x: x + part.width, y: cursor - line.size * 1.06 }, thickness: Math.max(0.5, part.size / 18), color: color(part.color || BLACK) });
          x += part.width;
        }
        cursor -= height;
      }
      return cursor;
    };
    const heightOf = (lines) => lines.reduce((sum, line) => sum + line.size * 1.25, 0);
    const left = format.left;
    const full = W - format.left - format.right;

    for (const item of items) {
      if (item.type === 'break') { newPage(); continue; }
      if (item.type === 'image') {
        let picture;
        try {
          picture = item.kind === 'png' ? await doc.embedPng(own(item.data)) : await doc.embedJpg(own(item.data));
        } catch {
          continue; // image illisible : on poursuit sans elle
        }
        const k = Math.min(1, full / item.width, (H - format.top - format.bottom) / item.height);
        const w = item.width * k;
        const h = item.height * k;
        if (y - h < format.bottom) newPage();
        page.drawImage(picture, { x: item.align === 'center' ? left + (full - w) / 2 : item.align === 'right' ? left + full - w : left, y: y - h, width: w, height: h });
        y -= h + 6;
        continue;
      }
      if (item.type === 'p') {
        const base = (item.base && item.base.size) || 11;
        const indent = Math.max(0, item.indent || 0) + (item.bullet && !item.indent ? 14 : 0);
        y -= item.before !== undefined ? item.before : item.heading !== undefined ? 6 : 0;
        const lines = await layout(item, full - indent);
        // Le paragraphe est posé ligne par ligne, avec saut de page au besoin.
        for (const line of lines) {
          if (y - line.size * 1.25 < format.bottom) newPage();
          y = drawLines([line], left + indent, full - indent, item, y);
        }
        y -= item.after !== undefined ? item.after : base * 0.45;
        continue;
      }
      if (item.type === 'table') {
        const columns = Math.max(1, ...item.rows.map((row) => row.reduce((n, cell) => n + (cell.span || 1), 0)));
        let widths = Array.from({ length: columns }, (_, i) => item.widths[i] || 0);
        if (widths.some((w) => !w)) widths = widths.map(() => full / columns);
        const total = widths.reduce((sum, w) => sum + w, 0);
        if (total > full) widths = widths.map((w) => (w * full) / total);
        const pad = 3;
        for (const row of item.rows) {
          const cells = [];
          let column = 0;
          for (const cell of row) {
            const width = widths.slice(column, column + (cell.span || 1)).reduce((sum, w) => sum + w, 0);
            const blocks = [];
            for (const p of cell.paragraphs) blocks.push({ p, lines: await layout(p, width - 2 * pad) });
            cells.push({ cell, blocks, width, x: left + widths.slice(0, column).reduce((sum, w) => sum + w, 0) });
            column += cell.span || 1;
          }
          const tall = (b) => heightOf(b.lines) + Math.min(8, b.p.after || 0);
          const rowHeight = Math.max(12, ...cells.map((c) => c.blocks.reduce((sum, b) => sum + tall(b), 0))) + 2 * pad;
          if (y - rowHeight < format.bottom) newPage();
          for (const c of cells) {
            if (c.cell.fill) page.drawRectangle({ x: c.x, y: y - rowHeight, width: c.width, height: rowHeight, color: color(c.cell.fill) });
            // Le fond d'un paragraphe de cellule couvre toute la cellule, comme dans Word.
            const tint = !c.cell.fill && c.blocks.length && c.blocks.every((b) => b.p.fill) ? c.blocks[0].p.fill : null;
            if (tint) page.drawRectangle({ x: c.x, y: y - rowHeight, width: c.width, height: rowHeight, color: color(tint) });
            let top = y - pad;
            for (const b of c.blocks) top = drawLines(b.lines, c.x + pad, c.width - 2 * pad, { ...b.p, fill: tint ? null : b.p.fill, bar: null }, top) - Math.min(8, b.p.after || 0);
            if (item.borders) page.drawRectangle({ x: c.x, y: y - rowHeight, width: c.width, height: rowHeight, borderColor: rgb(0.35, 0.35, 0.4), borderWidth: 0.5 });
          }
          y -= rowHeight;
        }
        y -= 8;
      }
    }
    return doc.save();
  }

  // Feuilles lues par Office.readXlsx → PDF A4 paysage : une grille par feuille, avec les couleurs,
  // fonds, gras, alignements, bordures, largeurs de colonnes et cellules fusionnées du classeur.
  async function sheetsToPdf(sheets, loadFont) {
    const doc = await PDFDocument.create();
    const fontOf = fontBook(doc, loadFont);
    const title = await fontOf('Arial', true, false);
    const W = 841.89;
    const H = 595.28;
    const M = 36;
    for (const sheet of sheets) {
      const rows = sheet.rows.map((row) => row.map((cell) => String(cell || '')));
      const looks = sheet.styles || [];
      const styled = looks.some((row) => row && row.some(Boolean));
      const lookOf = (r, c) => (looks[r] && looks[r][c]) || {};
      const used = (r) => rows[r].some(Boolean) || (looks[r] || []).some((l) => l && l.fill);
      while (rows.length && !used(rows.length - 1)) rows.pop();
      const columns = Math.max(0, ...rows.map((row, r) => Math.max(row.reduce((last, cell, i) => (cell ? i + 1 : last), 0), (looks[r] || []).reduce((last, l, i) => (l && l.fill ? i + 1 : last), 0))));
      const merges = (sheet.merges || []).filter((m) => m.r0 < rows.length && m.c0 < columns);
      const covered = new Set();
      for (const m of merges) for (let r = m.r0; r <= m.r1; r++) for (let c = m.c0; c <= m.c1; c++) if (r !== m.r0 || c !== m.c0) covered.add(`${r}:${c}`);
      // Chaque cellule : sa police, puis sa largeur naturelle.
      const cells = [];
      for (let r = 0; r < rows.length; r++) {
        cells[r] = [];
        for (let c = 0; c < columns; c++) {
          const look = lookOf(r, c);
          const entry = await fontOf(look.font || 'Calibri', look.bold, look.italic);
          cells[r][c] = { text: printable(entry, rows[r][c] || ''), look, entry, size: look.size || 11 };
        }
      }
      // Largeurs : celles du classeur si elles existent, sinon d'après le contenu.
      let widths = Array.from({ length: columns }, (_, c) => {
        const single = cells.map((row, r) => (merges.some((m) => m.r0 === r && m.c0 === c && m.c1 > c) ? 0 : row[c].entry.font.widthOfTextAtSize(row[c].text, row[c].size)));
        const natural = Math.min(260, Math.max(30, ...single) + 8);
        // La largeur du classeur est respectée, sauf si elle tronquerait le contenu.
        return sheet.widths && sheet.widths[c] ? Math.max(sheet.widths[c] * 5.6 + 4, natural) : natural;
      });
      const total = widths.reduce((sum, w) => sum + w, 0);
      const k = Math.min(1, (W - 2 * M) / (total || 1)); // trop large : tout est réduit dans la même proportion
      widths = widths.map((w) => w * k);
      const scale = Math.max(0.55, k);
      const fit = (cell, width) => {
        const size = cell.size * scale;
        if (cell.entry.font.widthOfTextAtSize(cell.text, size) <= width) return cell.text;
        let cut = cell.text;
        while (cut.length > 1 && cell.entry.font.widthOfTextAtSize(`${cut}…`, size) > width) cut = cut.slice(0, -1);
        return `${cut}…`;
      };
      let page = null;
      let y = 0;
      const start = () => {
        page = doc.addPage([W, H]);
        page.drawText(printable(title, String(sheet.name)), { x: M, y: H - M - 4, size: 13, font: title.font, color: rgb(0, 0, 0) });
        y = H - M - 22;
      };
      start();
      if (!rows.length) { page.drawText('(feuille vide)', { x: M, y: y - 14, size: 9, font: title.font, color: rgb(0.4, 0.4, 0.4) }); continue; }
      const lefts = widths.reduce((acc, w) => [...acc, acc[acc.length - 1] + w], [M]);
      for (let r = 0; r < rows.length; r++) {
        const rowHeight = Math.max(...cells[r].map((cell) => cell.size), 11) * scale * 1.55;
        if (y - rowHeight < M) start();
        for (let c = 0; c < columns; c++) {
          if (covered.has(`${r}:${c}`)) continue;
          const cell = cells[r][c];
          const merge = merges.find((m) => m.r0 === r && m.c0 === c);
          const x = lefts[c];
          const width = lefts[(merge ? Math.min(merge.c1, columns - 1) : c) + 1] - x;
          if (cell.look.fill) page.drawRectangle({ x, y: y - rowHeight, width, height: rowHeight, color: color(cell.look.fill) });
          // Sans aucun style dans le classeur, un quadrillage léger garde le tableau lisible.
          if (!styled) page.drawRectangle({ x, y: y - rowHeight, width, height: rowHeight, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.4 });
          const b = cell.look.borders;
          if (b) {
            const line = (x1, y1, x2, y2) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.6, color: rgb(0.3, 0.35, 0.4) });
            if (b.top) line(x, y, x + width, y);
            if (b.bottom) line(x, y - rowHeight, x + width, y - rowHeight);
            if (b.left) line(x, y, x, y - rowHeight);
            if (b.right) line(x + width, y, x + width, y - rowHeight);
          }
          const text = fit(cell, width - 6);
          if (!text) continue;
          const size = cell.size * scale;
          const number = /^-?[\d  .,]+( ?[€%])?$/.test(text) && /\d/.test(text);
          const align = cell.look.align || (number ? 'right' : 'left');
          const tw = cell.entry.font.widthOfTextAtSize(text, size);
          const tx = align === 'right' ? x + width - 3 - tw : align === 'center' ? x + (width - tw) / 2 : x + 3;
          page.drawText(text, { x: tx, y: y - rowHeight + (rowHeight - size * 0.72) / 2, size, font: cell.entry.font, color: color(cell.look.color || [0, 0, 0]) });
        }
        y -= rowHeight;
      }
    }
    if (!doc.getPageCount()) doc.addPage([W, H]);
    return doc.save();
  }

  // Numérote les pages en bas au centre : « 3 / 12 ».
  async function numberPages(bytes) {
    const doc = await load(bytes);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    pages.forEach((page, index) => {
      const { width } = page.getSize();
      const label = `${index + 1} / ${pages.length}`;
      page.drawText(label, { x: (width - font.widthOfTextAtSize(label, 9)) / 2, y: 18, size: 9, font, color: rgb(0.3, 0.3, 0.3) });
    });
    return doc.save();
  }

  // Filigrane en diagonale sur toutes les pages.
  async function watermark(bytes, text) {
    const doc = await load(bytes);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const known = new Set(font.getCharacterSet());
    const label = Array.from(String(text)).filter((ch) => known.has(ch.codePointAt(0))).join('').trim();
    if (!label) throw new Error('Texte du filigrane vide ou non pris en charge.');
    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      const angle = Math.atan2(height, width);
      const size = Math.min(110, (Math.hypot(width, height) * 0.75) / (font.widthOfTextAtSize(label, 1) || 1));
      const length = font.widthOfTextAtSize(label, size);
      // Centré sur la page : point de départ reculé d'une demi-longueur le long de la diagonale.
      page.drawText(label, {
        x: width / 2 - (Math.cos(angle) * length) / 2 + (Math.sin(angle) * size) / 3,
        y: height / 2 - (Math.sin(angle) * length) / 2 - (Math.cos(angle) * size) / 3,
        size, font, color: rgb(0.55, 0.55, 0.55), opacity: 0.25, rotate: degrees((angle * 180) / Math.PI),
      });
    }
    return doc.save();
  }

  async function deletePage(bytes, pageNumber) {
    const doc = await load(bytes);
    if (doc.getPageCount() <= 1) throw new Error('Impossible de supprimer la seule page du document.');
    doc.removePage(pageNumber - 1);
    return doc.save();
  }

  async function extractPages(bytes, pageNumbers) {
    const src = await load(bytes);
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, pageNumbers.map((n) => n - 1));
    copied.forEach((p) => out.addPage(p));
    return out.save();
  }

  async function merge(list) {
    const out = await PDFDocument.create();
    for (const bytes of list) {
      const src = await load(bytes);
      const copied = await out.copyPages(src, src.getPageIndices());
      copied.forEach((p) => out.addPage(p));
    }
    return out.save();
  }

  // images : [{ data: Uint8Array, kind: 'png' | 'jpg' }] — une image par page, à sa taille.
  async function imagesToPdf(images) {
    const out = await PDFDocument.create();
    for (const img of images) {
      const embedded = img.kind === 'png' ? await out.embedPng(own(img.data)) : await out.embedJpg(own(img.data));
      // 96 px par pouce → 72 points par pouce.
      const w = embedded.width * 0.75;
      const h = embedded.height * 0.75;
      out.addPage([w, h]).drawImage(embedded, { x: 0, y: 0, width: w, height: h });
    }
    return out.save();
  }

  function nameOf(dict, key) {
    const v = dict.lookup(PDFName.of(key));
    return v ? String(v.asString ? v.asString() : v).replace(/^\//, '') : '';
  }

  function describeFont(fontDict) {
    const subtype = nameOf(fontDict, 'Subtype');
    let raw = nameOf(fontDict, 'BaseFont');
    let holder = fontDict;
    if (subtype === 'Type0') {
      const desc = fontDict.lookup(PDFName.of('DescendantFonts'));
      if (desc instanceof PDFArray && desc.size() > 0) {
        const d = desc.lookup(0);
        if (d instanceof PDFDict) holder = d;
      }
    }
    let embedded = subtype === 'Type3';
    const fd = holder.lookup(PDFName.of('FontDescriptor'));
    if (fd instanceof PDFDict) {
      embedded = ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.has(PDFName.of(k)));
      if (!raw) raw = nameOf(fd, 'FontName');
    }
    const subset = /^[A-Z]{6}\+/.test(raw);
    const name = (subset ? raw.slice(7) : raw).replace(/#20/g, ' ') || '(sans nom)';
    return { name, subtype: subtype || '?', embedded, subset };
  }

  // Inventaire des polices : nom, type, embarquée ou non, jeu partiel ou complet, pages.
  async function listFonts(bytes) {
    const doc = await load(bytes);
    const found = new Map();
    const collect = (resources, pageNumber, seen) => {
      if (!(resources instanceof PDFDict) || seen.has(resources)) return;
      seen.add(resources);
      const fonts = resources.lookup(PDFName.of('Font'));
      if (fonts instanceof PDFDict) {
        for (const [, ref] of fonts.entries()) {
          const dict = doc.context.lookup(ref);
          if (!(dict instanceof PDFDict)) continue;
          const info = describeFont(dict);
          const key = [info.name, info.subtype, info.embedded, info.subset].join('|');
          if (!found.has(key)) found.set(key, { ...info, pages: new Set() });
          found.get(key).pages.add(pageNumber);
        }
      }
      // Les formulaires XObject ont leurs propres ressources.
      const xobjects = resources.lookup(PDFName.of('XObject'));
      if (xobjects instanceof PDFDict) {
        for (const [, ref] of xobjects.entries()) {
          const x = doc.context.lookup(ref);
          if (x instanceof PDFStream) collect(x.dict.lookup(PDFName.of('Resources')), pageNumber, seen);
        }
      }
    };
    doc.getPages().forEach((page, i) => collect(page.node.Resources(), i + 1, new Set()));
    return [...found.values()]
      .map((f) => ({ ...f, pages: [...f.pages].sort((a, b) => a - b) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return { FAMILIES, matchFont, lineFrame, stripText, applyAnnotations, addTextLayer, movePage, insertBlankPage, insertPdf, parseRange, numberPages, watermark, docToPdf, sheetsToPdf, listFormFields, fillForm, listComments, removeComment, replacePageWithImage, recompressImages, rotatePage, deletePage, extractPages, merge, imagesToPdf, listFonts };
});

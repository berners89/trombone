// Regroupe les fragments de texte d'une page en lignes puis en blocs (paragraphes, adresses, titres),
// et remet en page le texte d'un bloc modifié. Pur calcul : utilisable dans l'interface et dans les tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Blocks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const median = (values) => {
    const sorted = [...values].sort((p, q) => p - q);
    return sorted.length ? sorted[sorted.length >> 1] : 0;
  };
  // Repère d'une direction d'écriture o = (ux, uy) : t le long de la ligne, v perpendiculaire (vers le haut).
  const toTV = (o, x, y) => [x * o.ux + y * o.uy, -x * o.uy + y * o.ux];
  const toXY = (o, t, v) => [t * o.ux - v * o.uy, t * o.uy + v * o.ux];
  const sameDirection = (a, b) => a.ux * b.ux + a.uy * b.uy >= 0.9995;

  // Fragments { str, bx, by, ux, uy, iw, size, lo, hi } → lignes : fragments voisins sur une même ligne de base.
  // maxGap : écart maximal, en corps, entre deux fragments d'une même ligne (plus petit pour séparer
  // les cellules d'un tableau serré).
  function buildRows(items, maxGap = 1) {
    const rows = [];
    const ordered = [...items].sort((p, q) => {
      const [pt, pv] = toTV(p, p.bx, p.by);
      const [qt, qv] = toTV(q, q.bx, q.by);
      return Math.abs(pv - qv) > 0.3 * Math.min(p.size, q.size) ? qv - pv : pt - qt;
    });
    for (const item of ordered) {
      let home = null;
      let before = false;
      for (let i = rows.length - 1; i >= 0 && i >= rows.length - 60; i--) {
        const row = rows[i];
        if (!sameDirection(row, item)) continue;
        const small = Math.min(row.size, item.size);
        if (Math.max(row.size, item.size) > small * 1.3) continue;
        const [t, v] = toTV(row, item.bx, item.by);
        if (Math.abs(v - row.v) > 0.3 * small) continue;
        const after = t - row.t1;
        const ahead = row.t0 - (t + item.iw);
        if (after > -0.5 * small && after < maxGap * small) { home = row; break; }
        if (ahead > -0.5 * small && ahead < maxGap * small) { home = row; before = true; break; }
      }
      if (!home) {
        const [t, v] = toTV(item, item.bx, item.by);
        rows.push({ ux: item.ux, uy: item.uy, v, t0: t, t1: t + item.iw, size: item.size, items: [item] });
        continue;
      }
      const [t] = toTV(home, item.bx, item.by);
      if (before) home.items.unshift(item);
      else home.items.push(item);
      home.t0 = Math.min(home.t0, t);
      home.t1 = Math.max(home.t1, t + item.iw);
    }
    for (const row of rows) {
      const widest = row.items.reduce((p, q) => (q.iw > p.iw ? q : p));
      row.size = widest.size;
      row.lo = Math.min(...row.items.map((i) => i.lo));
      row.hi = Math.max(...row.items.map((i) => i.hi));
      [row.bx, row.by] = toXY(row, row.t0, row.v);
      row.iw = row.t1 - row.t0;
      row.str = row.items.reduce((text, item, index) => {
        if (!index) return item.str;
        const previous = row.items[index - 1];
        const gap = toTV(row, item.bx, item.by)[0] - (toTV(row, previous.bx, previous.by)[0] + previous.iw);
        const glue = gap > 0.15 * row.size && !/\s$/.test(text) && !/^\s/.test(item.str) ? ' ' : '';
        return text + glue + item.str;
      }, '');
    }
    return rows;
  }

  // Lignes → blocs : lignes de même corps, régulièrement espacées, alignées à gauche, au centre ou à droite.
  function buildBlocks(rows) {
    const blocks = [];
    const ordered = [...rows].sort((p, q) => q.v - p.v || p.t0 - q.t0);
    for (const row of ordered) {
      let best = null;
      let bestGap = Infinity;
      for (const block of blocks) {
        if (!sameDirection(block, row)) continue;
        const s = block.size;
        if (Math.max(s, row.size) > Math.min(s, row.size) * 1.15) continue;
        const [t0, v] = toTV(block, row.bx, row.by);
        const t1 = t0 + row.iw;
        const gap = block.lastV - v;
        if (gap < 0.55 * s || gap > 1.9 * s) continue;
        if (block.rows.length >= 2 && Math.abs(gap - block.leading) > 0.3 * s) continue;
        const aligned =
          Math.abs(t0 - block.t0) <= s || Math.abs(t1 - block.t1) <= s || Math.abs((t0 + t1) / 2 - (block.t0 + block.t1) / 2) <= s;
        if (!aligned) continue;
        if (gap < bestGap) { best = block; bestGap = gap; }
      }
      if (!best) {
        best = { ux: row.ux, uy: row.uy, size: row.size, rows: [], t0: Infinity, t1: -Infinity, gaps: [] };
        blocks.push(best);
      } else {
        best.gaps.push(bestGap);
        best.leading = median(best.gaps);
      }
      const [t0, v] = toTV(best, row.bx, row.by);
      best.rows.push({ row, t0, t1: t0 + row.iw, v });
      best.t0 = Math.min(best.t0, t0);
      best.t1 = Math.max(best.t1, t0 + row.iw);
      best.lastV = v;
    }
    for (const block of blocks) {
      const s = block.size;
      block.width = block.t1 - block.t0;
      if (!block.leading) block.leading = 1.2 * s;
      const spread = (pick) => Math.max(...block.rows.map(pick)) - Math.min(...block.rows.map(pick));
      block.align =
        block.rows.length < 2 || spread((r) => r.t0) <= 0.6 * s ? 'left'
          : spread((r) => (r.t0 + r.t1) / 2) <= 0.6 * s ? 'center'
            : spread((r) => r.t1) <= 0.6 * s ? 'right' : 'left';
      // Paragraphe « au fil du texte » : toutes les lignes sauf la dernière remplissent la largeur.
      block.flowing = block.rows.length >= 2 && block.rows.slice(0, -1).every((r) => r.t1 - r.t0 >= 0.8 * block.width);
      block.str = block.rows.map((r) => r.row.str.trim()).join(block.flowing ? ' ' : '\n');
      block.items = block.rows.flatMap((r) => r.row.items);
    }
    return blocks;
  }

  // Contour d'un bloc (quatre coins en points PDF), avec une marge.
  function blockQuad(block, pad = 0) {
    const first = block.rows[0];
    const last = block.rows[block.rows.length - 1];
    const top = first.v + first.row.hi + pad;
    const bottom = last.v + last.row.lo - pad;
    const left = block.t0 - 1 - pad;
    const right = block.t1 + 1 + pad;
    return [[left, bottom], [right, bottom], [right, top], [left, top]].map(([t, v]) => toXY(block, t, v));
  }

  // Remet en page le texte d'un bloc.
  // options : measure(texte, corps) → largeur ; size : corps voulu ; rows : toutes les lignes de la page
  // (obstacles) ; page : [x0, y0, x1, y1]. Rend { lines: [{ text, x, y }], size, leading, overflow }.
  function planBlock(block, text, options) {
    const { measure, rows = [], page } = options;
    const wanted = options.size || block.size;
    // Bloc déplacé : options.shift = [dx, dy] en points PDF. Toute la mise en page se fait à la nouvelle place.
    const [st, sv] = options.shift ? toTV(block, options.shift[0], options.shift[1]) : [0, 0];
    const first = { v: block.rows[0].v + sv };
    const last = { v: block.rows[block.rows.length - 1].v + sv };
    const t0 = block.t0 + st;
    const t1 = block.t1 + st;
    const mine = new Set(block.rows.map((r) => r.row));
    const corners = page ? [[page[0], page[1]], [page[2], page[1]], [page[2], page[3]], [page[0], page[3]]].map(([x, y]) => toTV(block, x, y)) : null;
    let rightLimit = corners ? Math.max(...corners.map((c) => c[0])) - 0.5 * block.size : block.t1;
    let floor = corners ? Math.min(...corners.map((c) => c[1])) + 0.5 * block.size : -Infinity;
    const others = rows.filter((r) => !mine.has(r) && sameDirection(block, r)).map((r) => {
      const [t0, v] = toTV(block, r.bx, r.by);
      return { t0, t1: t0 + r.iw, v, size: r.size };
    });
    // Voisin de droite (autre colonne) : le texte ne doit pas l'atteindre.
    for (const o of others) {
      if (o.v < last.v - 0.5 * block.size || o.v > first.v + 0.5 * block.size) continue;
      if (o.t0 >= t1 - 0.5 * block.size) rightLimit = Math.min(rightLimit, o.t0 - 0.8 * block.size);
    }
    const width = block.flowing ? block.width : Math.max(block.width, rightLimit - t0);
    // Premier texte situé sous le bloc : le bloc peut grandir jusque-là.
    for (const o of others) {
      if (o.v >= last.v - 0.5 * block.leading) continue;
      if (o.t1 < t0 || o.t0 > t0 + width) continue;
      floor = Math.max(floor, o.v + 0.9 * o.size + 0.25 * block.size);
    }

    const wrap = (size) => {
      const lines = [];
      for (const paragraph of text.split('\n')) {
        const words = paragraph.trim().split(/\s+/).filter(Boolean);
        if (!words.length) { lines.push(''); continue; }
        let current = words[0];
        for (const word of words.slice(1)) {
          if (measure(`${current} ${word}`, size) <= width) current += ` ${word}`;
          else { lines.push(current); current = word; }
        }
        lines.push(current);
      }
      while (lines.length > 1 && !lines[lines.length - 1]) lines.pop();
      return lines;
    };

    // Si le texte ne tient pas dans la place disponible, le corps est réduit, jusqu'à 80 %.
    let size = wanted;
    let lines;
    let leading;
    let room;
    for (;;) {
      lines = wrap(size);
      leading = block.leading * (size / block.size);
      const extra = Number.isFinite(floor) ? Math.floor((last.v - 0.22 * size - floor) / leading) : 0;
      room = block.rows.length + Math.max(0, extra);
      if (lines.length <= room || size <= wanted * 0.8) break;
      size *= 0.96;
    }
    size = Math.round(size * 4) / 4;
    const center = (t0 + t1) / 2;
    return {
      size, leading, overflow: Math.max(0, lines.length - room),
      lines: lines.map((line, index) => {
        const w = measure(line, size);
        const t = block.align === 'center' ? center - w / 2 : block.align === 'right' ? t1 - w : t0;
        const [x, y] = toXY(block, t, first.v - index * leading);
        return { text: line, x, y };
      }),
    };
  }

  return { buildRows, buildBlocks, blockQuad, planBlock };
});

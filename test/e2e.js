// Essai de bout en bout : xvfb-run npx electron --no-sandbox test/e2e.js
// Ouvre test/out/annote.pdf, pose un surlignage et un texte, ouvre le panneau des polices, capture l'écran.
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

process.argv.push(path.join(__dirname, 'out', 'annote.pdf'));
require('../main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') problems.push(`${event.level}: ${event.message}`);
  });
  win.webContents.once('did-finish-load', async () => {
    try {
      const run = (code) => win.webContents.executeJavaScript(code, true);
      await wait(2500);
      const loaded = await run(`({pages: document.querySelectorAll('.page').length, canvases: document.querySelectorAll('.page canvas').length, title: document.title})`);
      await run(`(async () => {
        const fire = (el, type, x, y) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent(type, {bubbles: true, button: 0, pointerId: 1, clientX: r.left + x, clientY: r.top + y})); };
        const svg = document.querySelector('.page svg');
        document.querySelector('[data-tool=edit]').click();
        await new Promise((r) => setTimeout(r, 700));
        const boxes = document.querySelectorAll('.page svg .textbox');
        window.__boxes = boxes.length;
        fire(boxes[1], 'pointerdown', 5, 5); fire(boxes[1], 'pointerup', 5, 5);
        await new Promise((r) => setTimeout(r, 500));
        const field = document.querySelector('.note.edit'); window.__before = field.value; window.__style = field.style.fontFamily + ' / ' + field.style.color;
        field.value = 'Facture numéro 2026-0099, montant réglé.'; field.blur();
        window.__toast = document.getElementById('toast').textContent;
        document.querySelector('[data-tool=highlight]').click();
        svg.setPointerCapture = () => {};
        fire(svg, 'pointerdown', 70, 95); fire(svg, 'pointermove', 300, 120); fire(svg, 'pointerup', 300, 120);
        document.querySelector('[data-tool=text]').click();
        fire(svg, 'pointerdown', 80, 220);
        await new Promise((r) => setTimeout(r, 100));
        const note = document.querySelector('input.note'); note.value = 'Bon pour accord'; note.blur();
        document.getElementById('act-fonts').click();
        await new Promise((r) => setTimeout(r, 400));
        // Impression : la fenêtre du système est remplacée par un compteur de pages préparées.
        window.print = () => { window.__printed = document.querySelectorAll('#print-root img').length; };
        document.getElementById('act-print').click();
        await new Promise((r) => setTimeout(r, 3000));
      })()`);
      const after = await run(`({annots: document.querySelectorAll('.page svg .annot').length, fonts: document.querySelectorAll('.font-row').length, title: document.title, thumbs: document.querySelectorAll('.thumb').length, printed: window.__printed, boxes: window.__boxes, before: window.__before, style: window.__style, toast: window.__toast})`);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'out', 'capture.png'), image.toPNG());
      console.log(JSON.stringify({ loaded, after, problems }, null, 1));
    } catch (err) {
      console.error('E2E', err);
      process.exitCode = 1;
    }
    app.quit();
  });
});

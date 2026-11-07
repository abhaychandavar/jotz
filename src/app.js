'use strict';

// ---------- state ----------
let S = { notes: [], view: { screen: 'home', noteId: null }, sort: 'edited', tab: 'active', dinoBest: 0, side: true, lastId: null, hilite: null };
let shortcut = 'Shift+1';
let loginItem = false;
let theme = 'system';
let pendingAnim = null; // 'fwd' | 'back' | 'fade': how the next render should enter

const $ = (sel, el = document) => el.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 250);
}
function flush() {
  clearTimeout(saveTimer);
  window.api.save(S);
}

// ---------- icons ----------
const svg = (name, cls = '') => `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 24 24">${ICONS[name]}</svg>`;

// ---------- rich text ----------
// Each row keeps plain `text` (titles, previews, list parsing) and, when styled, `html`: a flat string of
// <span style="..."> runs limited to bold, italic, underline, colour, highlight and font size.
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const COLOR_OK = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\))$/i;
const NO_COLOR = '#010203'; // sentinel: "automatic" colour is applied as this, then stripped
const NO_COLOR_CSS = 'rgb(1, 2, 3)';

function cleanHtml(root, inBg = false) {
  let out = '';
  for (const n of root.childNodes) {
    if (n.nodeType === 3) { out += escHtml(n.nodeValue); continue; }
    if (n.nodeType !== 1 || n.tagName === 'BR') continue;
    const s = n.style, t = n.tagName, st = [];
    if (t === 'B' || t === 'STRONG' || s.fontWeight === 'bold' || +s.fontWeight >= 600) st.push('font-weight:700');
    if (t === 'I' || t === 'EM' || s.fontStyle === 'italic') st.push('font-style:italic');
    if (t === 'U' || /underline/.test(s.textDecorationLine || s.textDecoration || '')) st.push('text-decoration:underline');
    const color = s.color || (t === 'FONT' && n.getAttribute('color')) || '';
    if (COLOR_OK.test(color) && color !== NO_COLOR_CSS) st.push('color:' + color);
    const bg = s.backgroundColor;
    const noBg = bg === 'transparent' || /^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(bg);
    let hasBg = inBg;
    if (COLOR_OK.test(bg) && !noBg) { st.push('background-color:' + bg); hasBg = true; }
    else if (noBg && inBg) { st.push('background-color:transparent'); hasBg = false; } // un-highlight inside a highlighted run
    if (/^\d+(\.\d+)?px$/.test(s.fontSize)) st.push('font-size:' + s.fontSize);
    const inner = cleanHtml(n, hasBg);
    out += st.length ? `<span style="${st.join(';')}">${inner}</span>` : inner;
  }
  return out;
}

const rowHtml = (r) => r.html || escHtml(r.text);
function setRich(r, text, html) {
  r.text = text;
  if (html && html.includes('<')) r.html = html; else delete r.html;
}
function syncRow(r, ed) {
  setRich(r, ed.textContent.replace(/ /g, ' '), cleanHtml(ed));
  setFs(ed.closest('.row'), r);
}
// Bullets, checkboxes and dots follow the biggest font on the row so they stay level with the first line.
function setFs(wrap, r) {
  if (!wrap) return;
  const sizes = [...((r.html || '') + (r.st ? r.st.pre : '')).matchAll(/font-size:([\d.]+)px/g)].map(m => +m[1]);
  const fs = Math.max(14, wrap.classList.contains('deftitle') ? 32 : 0, ...sizes);
  if (fs > 14) wrap.style.setProperty('--fs', fs + 'px'); else wrap.style.removeProperty('--fs');
}

// Caret/selection as character offsets into a row's text.
function pointAt(ed, off) {
  const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
  let n, left = off, last = null;
  while ((n = w.nextNode())) {
    last = n;
    if (left <= n.nodeValue.length) return [n, left];
    left -= n.nodeValue.length;
  }
  return last ? [last, last.nodeValue.length] : [ed, 0];
}
function selOf(ed) {
  const s = getSelection();
  if (!s.rangeCount || !ed.contains(s.anchorNode) || !ed.contains(s.focusNode)) return null;
  const r = s.getRangeAt(0);
  const pre = (node, o) => {
    const x = document.createRange();
    x.selectNodeContents(ed);
    x.setEnd(node, o);
    return x.toString().length;
  };
  return [pre(r.startContainer, r.startOffset), pre(r.endContainer, r.endOffset)];
}
function setCaret(ed, a, b = a) {
  const [n1, o1] = pointAt(ed, a), [n2, o2] = pointAt(ed, b);
  const r = document.createRange();
  r.setStart(n1, o1);
  r.setEnd(n2, o2);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}
// Text and html between two offsets (keeps styling when a row is split).
function sliceRow(ed, a, b) {
  // Trim a deep copy instead of cloning a range, so the wrapping style spans survive.
  const c = ed.cloneNode(true);
  const cut = (fromStart, off) => {
    const [n, o] = pointAt(c, off);
    const r = document.createRange();
    if (fromStart) { r.setStart(c, 0); r.setEnd(n, o); } else { r.setStart(n, o); r.setEnd(c, c.childNodes.length); }
    r.deleteContents();
  };
  cut(false, b);
  cut(true, a);
  c.querySelectorAll('*').forEach(n => { if (!n.textContent) n.remove(); });
  return { text: c.textContent, html: c.textContent ? cleanHtml(c) : '' };
}
// The inline style at a text offset, as the opening/closing span markup plus a flat css string, so a new
// empty bullet can carry it until something is typed. null when the text there is unstyled.
function styleAt(ed, off) {
  const [n] = pointAt(ed, off);
  if (!n || n.nodeType !== 3) return null;
  const chain = [];
  for (let p = n.parentElement; p && p !== ed; p = p.parentElement) chain.unshift(p);
  if (!chain.length) return null;
  const root = document.createElement('div');
  let cur = root;
  for (const p of chain) { const c = p.cloneNode(false); cur.append(c); cur = c; }
  cur.textContent = '\u0001';
  const [pre, post] = cleanHtml(root).split('\u0001');
  if (!pre) return null;
  return { pre, post, css: [...pre.matchAll(/style="([^"]*)"/g)].map(m => m[1]).join(';') };
}
// Style at the end of a stored row (its own text, or the style it is carrying while empty).
function rowStyle(r) {
  if (!r.text) return r.st || null;
  const d = document.createElement('div');
  d.innerHTML = rowHtml(r);
  return styleAt(d, r.text.length);
}
// Style of the nearest earlier bullet at the same level (stops at anything shallower).
function levelStyle(rows, i, indent) {
  for (let j = i - 1; j >= 0; j--) {
    const p = rows[j];
    if (!p.bullet || p.indent < indent) return null;
    if (p.indent === indent) return rowStyle(p);
  }
  return null;
}
// Shows a carried style on an empty row (caret size/colour) and applies it to whatever gets typed first.
function showCarried(ed, r) {
  if (r.st && !r.text) ed.style.cssText = r.st.css; else ed.removeAttribute('style');
}

function caretAtEdge(ed, up) {
  const s = getSelection();
  if (!s.rangeCount) return true;
  const rg = s.getRangeAt(0).cloneRange();
  rg.collapse(true);
  const cr = rg.getClientRects()[0];
  if (!cr || !cr.height) return true;
  const er = ed.getBoundingClientRect();
  return up ? cr.top - er.top < cr.height * 0.9 : er.bottom - cr.bottom < cr.height * 0.9;
}

// The first line of a jot is a Title until the user restyles it (r.plain).
const isDefTitle = (r) => !!curNote && !curNote.calendar && curNote.rows[0] === r && !r.bullet && !r.plain;

const FMT_SIZES = [['Small', 12], ['Normal', null], ['Large', 18], ['Title', 24], ['Huge', 32]];
const TEXT_COLORS = [null, '#E5484D', '#E58A00', '#2FA463', '#3B82F6', '#9B5DE5', '#8A8D9E'];
const HILITES = [null, 'rgba(255,212,0,.40)', 'rgba(255,149,0,.34)', 'rgba(52,199,89,.32)', 'rgba(64,156,255,.30)', 'rgba(255,95,150,.30)', 'rgba(155,93,229,.30)'];
const TOGGLES = ['bold', 'italic', 'underline'];
// Presets set size, weight and colour together (colour null = automatic, so they follow light/dark).
const FMT_STYLES = [
  ['Title', { px: 32, bold: true, color: null }],
  ['Heading', { px: 24, bold: true, color: null }],
  ['Subtitle', { px: 18, bold: false, color: '#8A8D9E' }],
  ['Body', { px: null, bold: false, color: null }],
  ['Caption', { px: 12, bold: false, color: '#8A8D9E' }],
];

// Is any of the selected text (or the text under the caret) highlighted? queryCommandValue can't tell, so read the DOM.
const CLEAR_BG = /^(transparent|rgba\(\s*0,\s*0,\s*0,\s*0\s*\))$/;
function litAncestor(node, ed) {
  for (let n = node.nodeType === 3 ? node.parentElement : node; n && n !== ed && ed.contains(n); n = n.parentElement) {
    if (!CLEAR_BG.test(getComputedStyle(n).backgroundColor)) return n;
  }
  return null;
}
function selHighlighted() {
  const s = getSelection();
  if (!s.rangeCount) return false;
  const r = s.getRangeAt(0);
  const host = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const ed = host && host.closest && host.closest('.ln');
  if (!ed) return false;
  if (r.collapsed) return !!litAncestor(r.startContainer, ed);
  const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    if (!n.nodeValue || !r.intersectsNode(n)) continue;
    if ((n === r.startContainer && r.startOffset >= n.nodeValue.length) || (n === r.endContainer && r.endOffset === 0)) continue;
    if (litAncestor(n, ed)) return true;
  }
  return false;
}

// Runs one formatting command on the current DOM selection, then tidies the markup it left behind.
function runCmd(ed, kind, value) {
  document.execCommand('styleWithCSS', false, true);
  if (TOGGLES.includes(kind)) document.execCommand(kind);
  else if (kind === 'highlight') {
    if (!value) { // removing with just a caret: clear the whole highlighted run it sits in
      const s = getSelection(), hl = s.rangeCount && s.isCollapsed && litAncestor(s.anchorNode, ed);
      if (hl) s.selectAllChildren(hl);
    }
    document.execCommand('hiliteColor', false, value || 'transparent');
  }
  else if (kind === 'color') document.execCommand('foreColor', false, value || NO_COLOR);
  else if (kind === 'size') document.execCommand('fontSize', false, '7');
  else if (kind === 'clear') document.execCommand('removeFormat');
  else if (kind === 'preset') {
    runCmd(ed, 'size', value.px);
    if (document.queryCommandState('bold') !== value.bold) document.execCommand('bold');
    runCmd(ed, 'color', value.color);
    return;
  }
  ed.querySelectorAll('[style]').forEach(n => {
    if (n.style.color === NO_COLOR_CSS) n.style.removeProperty('color');
    if (n.style.backgroundColor === 'transparent' && !n.parentElement?.closest('[style*="background-color"]:not([style*="transparent"])') ) n.style.removeProperty('background-color');
    if (kind === 'size' && n.style.fontSize === 'xxx-large') {
      n.querySelectorAll('[style*="font-size"]').forEach(c => c.style.removeProperty('font-size'));
      if (value) n.style.fontSize = value + 'px'; else n.style.removeProperty('font-size');
    }
  });
}

// Formats the given rows. scope 'sel' acts on the live text selection inside the one row;
// 'row' styles each whole row (used for the right-click menu, the ⋯ button and multi-row selections).
let fmtBusy = false;
function formatIds(ids, kind, value, scope) {
  const rows = ids.map(id => curNote.rows.find(r => r.id === id)).filter(Boolean);
  const edOf = (r) => $(`.row[data-id="${r.id}"] .ln`, rowsBox);
  if (!rows.length) return;
  if (['size', 'preset', 'clear'].includes(kind)) rows.forEach(r => { if (isDefTitle(r)) r.plain = true; });
  fmtBusy = true;
  const wasSelecting = rowsBox.classList.contains('selecting');
  rowsBox.classList.remove('selecting');
  try {
    if (scope === 'sel') {
      const ed = edOf(rows[0]);
      runCmd(ed, kind, value);
      syncRow(rows[0], ed);
    } else {
      const pick = (ed) => { ed.focus(); getSelection().selectAllChildren(ed); };
      let want = true;
      if (TOGGLES.includes(kind)) {
        want = !rows.every(r => { const ed = edOf(r); if (!r.text) return true; pick(ed); return document.queryCommandState(kind); });
      }
      for (const r of rows) {
        const ed = edOf(r);
        if (!ed || !r.text) continue;
        pick(ed);
        if (!TOGGLES.includes(kind) || document.queryCommandState(kind) !== want) runCmd(ed, kind, value);
        syncRow(r, ed);
      }
      if (wasSelecting) {
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        getSelection().removeAllRanges();
      } else {
        const ed = edOf(rows[rows.length - 1]);
        if (ed) setCaret(ed, ed.textContent.length);
      }
    }
  } finally {
    if (wasSelecting) rowsBox.classList.add('selecting');
    fmtBusy = false;
  }
  touch();
  if (tip && tip.refresh) tip.refresh();
}

// select with a leading icon and custom chevron
function pick(select, icon) {
  const w = el('label', 'pick');
  w.append(select);
  w.insertAdjacentHTML('beforeend', svg(icon, 'lead') + svg('chev', 'chev'));
  return w;
}

// ---------- theme ----------
const THEMES = [['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'System', 'monitor']];
const themeInfo = (t) => THEMES.find(x => x[0] === t) || THEMES[2];
const themeTip = () => `Theme: ${themeInfo(theme)[1]} (click to change)`;
let themeTimer;
function setTheme(t) {
  theme = t;
  document.body.classList.add('theming');
  clearTimeout(themeTimer);
  themeTimer = setTimeout(() => document.body.classList.remove('theming'), 450);
  window.api.setTheme(t);
  const segEl = $('.seg');
  if (segEl) {
    segEl.dataset.on = THEMES.findIndex(x => x[0] === t);
    segEl.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.key === t));
  }
  const b = $('.theme-btn');
  if (b) {
    b.title = themeTip();
    b.innerHTML = svg(themeInfo(t)[2]);
    b.classList.remove('spin');
    void b.offsetWidth;
    b.classList.add('spin');
  }
}
function cycleTheme() {
  const next = THEMES[(THEMES.findIndex(x => x[0] === theme) + 1) % THEMES.length];
  setTheme(next[0]);
  toast(`${next[1]} theme`);
}

// Clears #screen and applies the pending enter animation. `animate` tells callers whether to stagger.
function prepScreen(force) {
  const s = $('#screen');
  const a = pendingAnim || (force ? 'fade' : '');
  pendingAnim = null;
  s.innerHTML = '';
  s.className = '';
  void s.offsetWidth;
  if (a) s.classList.add('enter-' + a);
  return { s, animate: !!a };
}
function iconBtn(name, title, onClick, cls = '') {
  const b = el('button', 'icon ' + cls);
  b.title = title;
  b.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
  return b;
}

// ---------- row model & bullet parsing ----------
// row: { id, text, bullet, marker, todo, done, indent, priority (0 none, 1 low, 2 medium, 3 high), from (first day, calendar notes), date (day it's on, or was finished) — YYYY-MM-DD }
// note: { ..., calendar (open to-dos roll over to today), prioSort ('high' | 'low' | 'off') }
// marker: {t:'sym', c} | {t:'num', n, s} | {t:'alpha', n, s, u}
const newRow = (o = {}) => ({ id: uid(), at: Date.now(), text: '', bullet: false, marker: null, todo: false, done: false, indent: 0, priority: 0, date: null, from: plannedDay(), ...o });

const SYM = '[-*•–—>→+]';
const TYPED_MARKER = new RegExp(`^(${SYM}|\\d{1,3}[.)]|[A-Za-z][.)]) $`);
const LINE_MARKER = new RegExp(`^(${SYM}|(\\d{1,3})([.)])|([A-Za-z])([.)]))\\s+(.*)$`);
const TODO_TYPED = /^\[( |x|X)?\] $/;
const TODO_LINE = /^(?:[-*•+]\s+)?\[( |x|X)?\]\s+(.*)$/;

function markerFromToken(tok) {
  let m;
  if ((m = /^(\d{1,3})([.)])$/.exec(tok))) return { t: 'num', n: +m[1], s: m[2] };
  if ((m = /^([A-Za-z])([.)])$/.exec(tok))) {
    const ch = m[1];
    return { t: 'alpha', n: ch.toLowerCase().charCodeAt(0) - 96, s: m[2], u: ch !== ch.toLowerCase() };
  }
  return { t: 'sym', c: tok };
}

function markerText(mk) {
  if (!mk) return '';
  if (mk.t === 'sym') return mk.c === '-' || mk.c === '*' || mk.c === '+' ? '•' : mk.c === '>' ? '›' : mk.c;
  if (mk.t === 'num') return mk.n + mk.s;
  const ch = String.fromCharCode((mk.u ? 64 : 96) + Math.min(Math.max(mk.n, 1), 26));
  return ch + mk.s;
}

const nextMarker = (mk) => (mk && mk.t !== 'sym' ? { ...mk, n: mk.n + 1 } : mk ? { ...mk } : { t: 'sym', c: '•' });

function parseLine(raw) {
  const lead = /^[ \t]*/.exec(raw)[0];
  const indent = Math.min(4, Math.floor(lead.replace(/\t/g, '  ').length / 2));
  const body = raw.slice(lead.length);
  let m;
  if ((m = TODO_LINE.exec(body))) {
    return newRow({ text: m[2], bullet: true, marker: { t: 'sym', c: '•' }, todo: true, done: /x/i.test(m[1] || ''), indent });
  }
  if ((m = LINE_MARKER.exec(body))) {
    return newRow({ text: m[6], bullet: true, marker: markerFromToken(m[1]), indent });
  }
  return newRow({ text: body, indent });
}

// Recompute list numbers/letters so sequences stay continuous after edits.
// resetStart: after a reorder, restart each sequence at its smallest original number.
function renumber(rows, resetStart = false) {
  const counters = [];
  const runs = [];
  for (const r of rows) {
    if (!r.bullet) { counters.length = 0; continue; }
    counters.length = r.indent + 1;
    if (r.todo || !r.marker) continue;
    const mk = r.marker;
    if (mk.t === 'sym') { counters[r.indent] = null; continue; }
    const c = counters[r.indent];
    if (c && c.t === mk.t && !!c.u === !!mk.u) {
      c.run.min = Math.min(c.run.min, mk.n);
      mk.n = c.n + 1;
      c.n = mk.n;
    } else {
      const run = { first: mk, min: mk.n };
      runs.push(run);
      counters[r.indent] = { t: mk.t, u: mk.u, n: mk.n, run };
    }
  }
  if (resetStart) {
    runs.forEach(run => { run.first.n = run.min; });
    renumber(rows);
  }
}

// A "set" is a run of adjacent sibling rows of one kind: to-dos, or plain bullets.
// Sorting only reorders inside a to-do set (open first, done after); sets never swap on their own.
// Sub-items travel with their parent row.
function sortLevel(rows) {
  const blocks = [];
  for (let i = 0; i < rows.length;) {
    const head = rows[i];
    let j = i + 1;
    while (j < rows.length && rows[j].indent > head.indent) j++;
    blocks.push({ head, rows: [head, ...sortLevel(rows.slice(i + 1, j))] });
    i = j;
  }
  const out = [];
  for (let i = 0; i < blocks.length;) {
    const h = blocks[i].head;
    if (!h.todo) { out.push(...blocks[i++].rows); continue; }
    let j = i;
    while (j < blocks.length && blocks[j].head.todo && blocks[j].head.indent === h.indent) j++;
    blocks.slice(i, j)
      .sort((x, y) => (!!x.head.done - !!y.head.done) || prioCmp(x.head, y.head))
      .forEach(bl => out.push(...bl.rows));
    i = j;
  }
  return out;
}

// Order within open to-dos by priority; honours the current note's setting (default: highest first).
const TODO_SORTS = [
  ['high', 'Priority: highest first'],
  ['low', 'Priority: lowest first'],
  ['az', 'Title A → Z'],
  ['za', 'Title Z → A'],
  ['new', 'Newest first'],
  ['old', 'Oldest first'],
  ['off', 'Manual order'],
];
function prioCmp(a, b) {
  const mode = (curNote && curNote.prioSort) || 'high';
  if (mode === 'high') return (b.priority || 0) - (a.priority || 0);
  if (mode === 'low') return (a.priority || 0) - (b.priority || 0);
  if (mode === 'az' || mode === 'za') {
    const d = a.text.localeCompare(b.text, undefined, { sensitivity: 'base' });
    return mode === 'az' ? d : -d;
  }
  if (mode === 'new') return (b.at || 0) - (a.at || 0);
  if (mode === 'old') return (a.at || 0) - (b.at || 0);
  return 0;
}

function sortTodos(rows) {
  rows.splice(0, rows.length, ...sortLevel(rows));
}

// Sibling rows around `row`: same indent, in one unbroken stretch of bullets, grouped into
// blocks (a row plus its sub-items). Returns where the stretch sits in `rows`.
function siblingBlocks(rows, row) {
  const i = rows.indexOf(row), d = row.indent;
  let s = i;
  while (s > 0) {
    const p = rows[s - 1];
    if (p.indent < d || (p.indent === d && !p.bullet)) break;
    s--;
  }
  while (s < i && rows[s].indent > d) s++;
  let e = i + 1;
  while (e < rows.length) {
    const q = rows[e];
    if (q.indent < d || (q.indent === d && !q.bullet)) break;
    e++;
  }
  const blocks = [];
  for (let k = s; k < e;) {
    let m = k + 1;
    while (m < e && rows[m].indent > d) m++;
    blocks.push({ head: rows[k], rows: rows.slice(k, m) });
    k = m;
  }
  return { blocks, s, e };
}

// What kind of list item a row is: 'todo', or its marker type ('sym', 'num', 'alpha'). Plain text is null.
const kindOf = (r) => (!r.bullet ? null : r.todo ? 'todo' : (r.marker && r.marker.t) || 'sym');

// A row just changed kind (e.g. bullet -> to-do). If its list already has a set of that kind it
// joins it (after the open to-dos, or at the end of a bullet set); otherwise it moves to the top.
function joinKindSet(row) {
  const rows = curNote.rows;
  const { blocks, s, e } = siblingBlocks(rows, row);
  const mi = blocks.findIndex(b => b.head === row);
  if (mi < 0) return;
  const kind = kindOf(row);
  const runs = [];
  for (let k = 0; k < blocks.length; k++) {
    if (k === mi || kindOf(blocks[k].head) !== kind) continue;
    const last = runs[runs.length - 1];
    if (last && last.to === k - 1) last.to = k; else runs.push({ from: k, to: k });
  }
  const rest = blocks.filter((_, k) => k !== mi);
  if (!runs.length) {
    rest.unshift(blocks[mi]);
  } else {
    const dist = (r) => (mi < r.from ? r.from - mi : mi > r.to ? mi - r.to : 0);
    const run = runs.reduce((a, b) => (dist(b) < dist(a) ? b : a));
    let after = run.from - 1;
    for (let k = run.from; k <= run.to; k++) if (!blocks[k].head.done) after = k;
    const pos = blocks.slice(0, after + 1).filter((_, k) => k !== mi).length;
    rest.splice(pos, 0, blocks[mi]);
  }
  rows.splice(s, e - s, ...rest.flatMap(b => b.rows));
}

// ---------- priority & calendar ----------
const PRIORITIES = ['No priority', 'Low priority', 'Medium priority', 'High priority'];

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Calendar notes: every row remembers the day it was added (`from`), so a day shows what existed by then and
// today shows everything. Open to-dos left over from earlier days move to today; done ones keep the day they
// were finished. Returns true if anything changed.
function stampDates(note) {
  if (!note.calendar) return false;
  const today = todayKey();
  let changed = false;
  for (const r of note.rows) {
    if (!r.from) { r.from = r.todo ? r.date || today : r.at ? dayKey(new Date(r.at)) : today; changed = true; }
    if (!r.todo) continue;
    if (!r.date || (!r.done && r.date < today)) { r.date = r.from > today ? r.from : today; changed = true; }
  }
  return changed;
}

// Calendar notes: the day being looked at (null = today). Past days are read-only.
let viewDay = null;
const isPast = (note) => !!(note && note.calendar && viewDay && viewDay < todayKey());
// Future days are editable: rows added there belong to that day, and open to-dos carry over into it.
// In a future day, carried-over open to-dos are only previewed (greyed out, read-only); they stay editable on their own day.
const isGhost = (r) => isFuture(curNote) && r.todo && !r.done && !!r.from && r.from < viewDay;
const isFuture = (note) => !!(note && note.calendar && viewDay && viewDay > todayKey());
const plannedDay = () => (isFuture(curNote) ? viewDay : undefined);
const MAX_AHEAD = 365;
const lastDay = () => { const d = parseDay(todayKey()); d.setDate(d.getDate() + MAX_AHEAD); return dayKey(d); };

const parseDay = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function dayLabel(k) {
  const today = parseDay(todayKey());
  const diff = Math.round((today - parseDay(k)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff === -1) return 'Tomorrow';
  return parseDay(k).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function earliestDay(note) {
  return note.rows.reduce((m, r) => (r.text.trim() && r.from && r.from < m ? r.from : m), todayKey());
}

function shiftDay(note, delta) {
  const d = parseDay(viewDay || todayKey());
  d.setDate(d.getDate() + delta);
  const k = dayKey(d);
  if (k > lastDay() || k < earliestDay(note)) return;
  viewDay = k === todayKey() ? null : k;
  renderNote(note);
}

// What a past day looked like: everything added by then. To-dos finished before that day are left out.
function pastDay(note, day) {
  const box = el('div', 'editor pastday');
  const items = note.rows.filter(r => r.text.trim() && (r.from || r.date) <= day && (!r.todo || !r.done || r.date >= day));
  const doneThen = (r) => r.todo && r.done && r.date === day;
  if (!items.length) box.append(el('div', 'empty', 'Nothing on this day.'));
  for (const r of items) {
    const open = r.todo && !doneThen(r);
    const wrap = el('div', 'row' + (doneThen(r) ? ' done' : '') + (open && r.priority ? ' p' + r.priority : ''));
    wrap.style.paddingLeft = r.indent * 22 + 'px';
    if (r.todo) wrap.append(el('span', 'cb'));
    else if (r.bullet) wrap.append(el('span', 'mk', markerText(r.marker)));
    const txt = el('span', 'txt');
    txt.innerHTML = rowHtml(r);
    wrap.append(txt);
    const pill = open && r.from < day ? carryPill(r, day) : null;
    if (pill) wrap.append(pill);
    if (open && r.priority) { const p = el('span', 'prio p' + r.priority); p.title = PRIORITIES[r.priority]; wrap.append(p); }
    box.append(wrap);
  }
  return box;
}

function rollOver() {
  const changed = S.notes.map(stampDates).some(Boolean);
  if (!changed) return;
  save();
  if (S.view.screen !== 'note' || !curNote || isPast(curNote)) return;
  const a = document.activeElement;
  const row = a && a.closest && a.closest('.row');
  const pos = a && a.selectionStart;
  sortTodos(curNote.rows);
  drawRows();
  if (row) focusRow(row.dataset.id, pos);
}

// ---------- note helpers ----------
const getNote = (id) => S.notes.find(n => n.id === id);
const noteTitle = (n) => (n.rows.find(r => r.text.trim()) || {}).text || '';
const isBlank = (n) => n.rows.every(r => !r.text.trim());
const openTodos = (n) => n.rows.filter(r => r.todo && !r.done && r.text.trim() && !(n.calendar && r.from > todayKey())).length;

function noteBody(n) {
  const lines = [];
  let seenTitle = false;
  for (const r of n.rows) {
    if (!r.text.trim()) continue;
    if (!seenTitle) { seenTitle = true; continue; }
    const mk = r.todo ? (r.done ? '☑' : '☐') : r.bullet ? markerText(r.marker) : '';
    lines.push((mk ? mk + ' ' : '') + r.text);
    if (lines.length >= 3) break;
  }
  return lines.join('\n');
}

function createNote() {
  const n = { id: uid(), rows: [newRow({ from: undefined })], created: Date.now(), updated: Date.now(), archived: false };
  S.notes.unshift(n);
  return n;
}

// Starred jots always sit above the rest; the chosen sort orders each group.
const SORT_FNS = {
  edited: ['Recently edited', (a, b) => b.updated - a.updated],
  created: ['Newest first', (a, b) => b.created - a.created],
  oldest: ['Oldest first', (a, b) => a.created - b.created],
  az: ['Title A → Z', (a, b) => noteTitle(a).localeCompare(noteTitle(b), undefined, { sensitivity: 'base' })],
  za: ['Title Z → A', (a, b) => noteTitle(b).localeCompare(noteTitle(a), undefined, { sensitivity: 'base' })],
  todos: ['Most open to-dos', (a, b) => openTodos(b) - openTodos(a) || b.updated - a.updated],
};
const SORTS = Object.fromEntries(Object.entries(SORT_FNS).map(([k, [label, fn]]) =>
  [k, [label, (a, b) => (!!b.starred - !!a.starred) || fn(a, b)]]));

function setStarred(n, v) {
  n.starred = v;
  save();
  render();
}

const fmtDate = (t) => {
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
};

// ---------- toast ----------
let toastTimer;
function hideToast() {
  const t = $('#toast');
  if (t.hidden) return;
  t.classList.add('out');
  setTimeout(() => { if (t.classList.contains('out')) { t.hidden = true; t.classList.remove('out'); } }, 180);
}
function toast(msg, actionLabel, action) {
  const t = $('#toast');
  t.innerHTML = '';
  t.classList.remove('out');
  t.append(el('span', '', msg));
  if (actionLabel) {
    const b = el('button', '', actionLabel);
    b.onclick = () => { action(); hideToast(); };
    t.append(b);
  }
  t.hidden = false;
  t.style.animation = 'none';
  void t.offsetWidth;
  t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 4500);
}

// ---------- navigation ----------
// Wide windows show the jot list as a docked sidebar next to the open jot (like Apple Notes);
// narrow ones keep the one-screen-at-a-time flow.
const SPLIT_MIN = 880;
const isSplit = () => window.innerWidth >= SPLIT_MIN;

function go(screen, noteId = null) {
  viewDay = null;
  pendingAnim = isSplit() ? 'fade' : screen === 'note' ? 'fwd' : 'back';
  S.view = { screen, noteId };
  if (noteId) S.lastId = noteId;
  save();
  render();
}

// Removes the open jot if nothing was written in it. Returns true if it did.
function dropBlank() {
  const n = S.view.screen === 'note' ? getNote(S.view.noteId) : null;
  if (!n || !isBlank(n)) return false;
  S.notes = S.notes.filter(x => x !== n);
  return true;
}

function leaveNote() {
  clearSel();
  dropBlank();
  go('home');
}

// Split view: switch the open jot without a full re-render.
function openNote(id) {
  if (!isSplit()) return go('note', id);
  if (S.view.screen === 'note' && S.view.noteId === id) return;
  clearSel();
  dropBlank();
  viewDay = null;
  pendingAnim = 'fade';
  S.view = { screen: 'note', noteId: id };
  S.lastId = id;
  save();
  renderNote(getNote(id));
  renderSide(false);
}

// The jot to show when none is chosen: the last one opened, else the first in the list.
function pickNote() {
  const pool = S.notes.filter(n => n.archived === (S.tab === 'archived'));
  return pool.find(n => n.id === S.lastId) || pool.slice().sort(SORTS[S.sort][1])[0] || null;
}

function removeNote(n) {
  const idx = S.notes.indexOf(n);
  S.notes.splice(idx, 1);
  save();
  toast('Jot deleted', 'Undo', () => { S.notes.splice(idx, 0, n); reopen(n); save(); render(); });
}

function setArchived(n, v) {
  n.archived = v;
  save();
  toast(v ? 'Jot archived' : 'Jot restored', 'Undo', () => { n.archived = !v; reopen(n); save(); render(); });
}

function reopen(n) {
  if (isSplit()) { S.view = { screen: 'note', noteId: n.id }; S.lastId = n.id; }
}

// ---------- render ----------
function render() {
  if (inGame) return;
  if (inSettings && isSplit()) inSettings = false;
  if (inSettings) {
    document.body.classList.remove('split', 'side-off');
    $('#side-toggle').hidden = true;
    return renderSettingsPage();
  }
  const split = isSplit();
  document.body.classList.toggle('split', split);
  document.body.classList.toggle('side-off', split && !S.side);
  $('#side-toggle').hidden = !split;
  let note = S.view.screen === 'note' ? getNote(S.view.noteId) : null;
  if (split) {
    if (!note) note = pickNote();
    S.view = note ? { screen: 'note', noteId: note.id } : { screen: 'home', noteId: null };
    if (note) S.lastId = note.id;
    renderSide(sideFresh);
    sideFresh = false;
    if (note) renderNote(note); else renderEmptyPane();
    return;
  }
  if (S.view.screen === 'note' && !note) S.view = { screen: 'home', noteId: null };
  if (note) renderNote(note); else renderHome();
}

function setBar(title, showBack, actions) {
  $('#back').hidden = !showBack;
  $('#bar-title').textContent = title;
  const box = $('#bar-actions');
  box.innerHTML = '';
  actions.forEach(a => box.append(a));
}

// Narrow windows: only theme stays in the bar; the rest live in a ⋯ dropdown.
function moreBtn(items) {
  const b = iconBtn('more', 'More', () => showMenu({ rect: b.getBoundingClientRect() }, items));
  return b;
}
const commonItems = () => [
  { icon: 'game', label: 'Dino game', fn: openGame },
  { icon: 'gear', label: 'Settings', fn: openSettings },
];

const themeBtn = () => iconBtn(themeInfo(theme)[2], themeTip(), cycleTheme, 'theme-btn');

function renderHome(force) {
  setBar('Jots', false, [themeBtn(), moreBtn(commonItems())]);
  const { s: screen, animate } = prepScreen(force);
  buildList(screen, animate);
}

// Split view: the sidebar list. `fresh` replays the entrance animation (first draw, tab or sort change).
let sideFresh = true;
function renderSide(fresh) {
  const side = $('#side');
  const y = (side.querySelector('.list') || {}).scrollTop || 0;
  side.innerHTML = '';
  buildList(side, !!fresh);
  const list = side.querySelector('.list');
  if (list) list.scrollTop = y;
}

let sideTimer;
function refreshSide() {
  if (!isSplit() || inGame) return;
  clearTimeout(sideTimer);
  sideTimer = setTimeout(() => renderSide(false), 350);
}

function renderEmptyPane() {
  setBar('', false, [iconBtn('game', 'Dino game', openGame), themeBtn(), iconBtn('gear', 'Settings', openSettings)]);
  const { s: screen } = prepScreen(true);
  screen.classList.add('paper');
  const e = el('div', 'empty big');
  e.innerHTML = `<img class="logo" src="assets/logo.png" alt=""><b>No jot open</b><span>Pick one from the list, or press ⌘N to start a new one.</span>`;
  const b = el('button', 'cta');
  b.innerHTML = `${svg('plus')}<span>New jot</span>`;
  b.onclick = newNoteAndOpen;
  e.append(b);
  screen.append(e);
}

// Jot list: tabs, sort, cards and the + button. Lives in #screen (narrow) or #side (split).
function redrawHome(force) {
  if (isSplit()) renderSide(true); else renderHome(force);
}

function buildList(host, animate) {
  const split = isSplit();
  const showArchived = S.tab === 'archived';
  const activeCount = S.notes.filter(n => !n.archived).length;
  const archCount = S.notes.length - activeCount;

  const tb = el('div', 'toolbar');
  const tabs = el('div', 'tabs');
  tabs.dataset.on = showArchived ? 1 : 0;
  for (const [key, label, count, icon] of [['active', 'Jots', activeCount, 'note'], ['archived', 'Archived', archCount, 'archive']]) {
    const b = el('button', key === S.tab ? 'on' : '');
    b.innerHTML = `${svg(icon)}<span>${label}</span><i>${count}</i>`;
    b.onclick = () => {
      if (S.tab === key) return;
      S.tab = key; save();
      tabs.dataset.on = key === 'archived' ? 1 : 0; // let the pill slide, then swap the list
      tabs.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      setTimeout(() => { if (split ? isSplit() : S.view.screen === 'home') redrawHome(true); }, 180);
    };
    tabs.append(b);
  }
  const sort = el('select');
  sort.id = 'sort';
  sort.title = 'Sort jots';
  for (const [k, [label]] of Object.entries(SORTS)) {
    const o = el('option', '', label);
    o.value = k;
    sort.append(o);
  }
  sort.value = S.sort;
  sort.onchange = () => { S.sort = sort.value; save(); redrawHome(true); };
  if (split) {
    tb.append(tabs, pick(sort, 'sort'));
  } else {
    // One-screen layout: the sort dropdown collapses to an icon that opens a menu.
    const sb = iconBtn('sort', `Sort: ${SORTS[S.sort][0]}`, () => showMenu({ rect: sb.getBoundingClientRect() },
      Object.entries(SORTS).map(([k, [label]]) => ({ label, on: k === S.sort, fn: () => { S.sort = k; save(); redrawHome(true); } }))), 'sort-btn');
    tb.append(tabs, sb);
  }

  const list = el('div', 'list');
  const notes = S.notes.filter(n => n.archived === showArchived).sort(SORTS[S.sort][1]);
  if (!notes.length) {
    const e = el('div', 'empty');
    e.innerHTML = showArchived
      ? `<div class="ic">${svg('archive')}</div><b>Nothing archived</b><span>Archived jots will show up here.</span>`
      : `<img class="logo" src="assets/logo.png" alt=""><b>No jots yet</b><span>Tap + or press ⌘N to start one.</span>`;
    list.append(e);
  }
  notes.forEach((n, i) => {
    const c = el('div', 'card' + (animate ? ' rise' : '') + (split && S.view.noteId === n.id ? ' active' : ''));
    c.style.setProperty('--i', Math.min(i, 8));
    const title = noteTitle(n);
    const tEl = el('div', 't' + (title ? '' : ' none'), title || 'Empty jot');
    if (n.starred) tEl.insertAdjacentHTML('afterbegin', svg('star', 'starred'));
    c.append(tEl);
    const body = noteBody(n);
    if (body) c.append(el('div', 'p', body));
    const m = el('div', 'm');
    m.append(el('span', '', fmtDate(n.updated)));
    const open = openTodos(n);
    if (open) {
      const o = el('span', 'badge');
      o.innerHTML = `${svg('checkCircle')}${open} open`;
      m.append(o);
    }
    if (n.calendar) {
      const cl = el('span', '');
      cl.title = 'Calendar jot';
      cl.innerHTML = svg('calendar');
      m.append(cl);
    }
    c.append(m);
    // Slide the card away before removing it.
    const leave = (fn) => { c.classList.add('leaving'); setTimeout(fn, 200); };
    const archive = () => leave(() => { const cur = S.view.noteId === n.id; setArchived(n, !showArchived); if (cur) S.view = { screen: 'home', noteId: null }; render(); });
    const trash = () => leave(() => { const cur = S.view.noteId === n.id; removeNote(n); if (cur) S.view = { screen: 'home', noteId: null }; render(); });
    const acts = el('div', 'acts');
    acts.append(
      iconBtn('star', n.starred ? 'Unstar' : 'Star', () => setStarred(n, !n.starred), n.starred ? 'on' : ''),
      iconBtn(showArchived ? 'unarchive' : 'archive', showArchived ? 'Restore' : 'Archive', archive),
      iconBtn('trash', 'Delete', trash, 'danger'),
    );
    c.append(acts);
    c.onclick = () => openNote(n.id);
    c.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu({ x: e.clientX, y: e.clientY }, [
        { icon: 'open', label: 'Open', fn: () => openNote(n.id) },
        { icon: 'star', label: n.starred ? 'Unstar' : 'Star', fn: () => setStarred(n, !n.starred) },
        { icon: showArchived ? 'unarchive' : 'archive', label: showArchived ? 'Restore' : 'Archive', fn: archive },
        { icon: 'trash', label: 'Delete', fn: trash, danger: true },
      ]);
    };
    list.append(c);
  });
  host.append(tb, list);

  if (!showArchived) {
    const fab = el('button', 'fab');
    fab.innerHTML = svg('plus');
    fab.title = 'New jot (⌘N)';
    fab.onclick = newNoteAndOpen;
    host.append(fab);
  }
}

function newNoteAndOpen() {
  // An untouched blank jot is already a fresh page: reuse it.
  const cur = isSplit() && S.view.screen === 'note' ? getNote(S.view.noteId) : null;
  if (cur && isBlank(cur) && !cur.archived) { focusRow(cur.rows[0].id, 'end'); return; }
  if (S.tab === 'archived') { S.tab = 'active'; sideFresh = true; }
  const n = createNote();
  go('note', n.id);
}

// ---------- editor ----------
let curNote = null;
let rowsBox = null;

function renderNote(note) {
  curNote = note;
  stampDates(note);
  sortTodos(note.rows);
  renumber(note.rows);

  const split = isSplit();
  const arch = iconBtn(note.archived ? 'unarchive' : 'archive', note.archived ? 'Restore' : 'Archive', () => {
    setArchived(note, !note.archived);
    go('home');
  });
  const del = iconBtn('trash', 'Delete', () => { removeNote(note); go('home'); }, 'danger');
  const game = iconBtn('game', 'Dino game', openGame);
  const star = iconBtn('star', note.starred ? 'Unstar' : 'Star', () => setStarred(note, !note.starred), note.starred ? 'on' : '');
  setBar('', !split, split
    ? [star, arch, del, game, themeBtn(), iconBtn('gear', 'Settings', openSettings)]
    : [themeBtn(), moreBtn([
      { icon: 'star', label: note.starred ? 'Unstar' : 'Star', fn: () => setStarred(note, !note.starred) },
      { icon: note.archived ? 'unarchive' : 'archive', label: note.archived ? 'Restore' : 'Archive', fn: () => { setArchived(note, !note.archived); go('home'); } },
      { icon: 'trash', label: 'Delete', danger: true, fn: () => { removeNote(note); go('home'); } },
      ...commonItems(),
    ])]);
  updateTitle();

  const { s: screen } = prepScreen();
  screen.classList.add('paper');
  const ed = el('div', 'editor');
  if (isPast(note)) {
    clearSel();
    rowsBox = null;
    screen.append(noteOptions(note), pastDay(note, viewDay), el('div', 'hint', 'Read-only: go to Today to edit'));
    return;
  }
  rowsBox = el('div', 'rows');
  ed.append(rowsBox);
  installDnD(rowsBox);
  ed.addEventListener('mousedown', (e) => {
    if (e.target === ed && e.button === 0) { e.preventDefault(); focusRow(visibleRows(note).at(-1).id, 'end'); }
  });
  screen.append(noteOptions(note), ed, el('div', 'hint', isFuture(note)
    ? `Planning ${dayLabel(viewDay)}  ·  unfinished to-dos carry over here`
    : '-  1.  make a list  ·  [] to-do  ·  select text to style  ·  right-click for more'));
  drawRows();
  const first = note.rows.find(r => !r.text);
  if (isBlank(note)) focusRow(note.rows[0].id, 'end');
  else if (first) { /* leave focus alone for existing notes */ }
}

// Calendar notes: a scrolling strip of days (today highlighted) that expands into a month grid.
// Dots mark days with content; days outside the note's history are disabled.
let calOpen = false;
function markedDays(note) {
  const mark = new Set();
  for (const r of note.rows) {
    if (!r.text.trim()) continue;
    if (r.from) mark.add(r.from);
    if (r.todo && r.done && r.date) mark.add(r.date);
  }
  return mark;
}

function pickDay(note, k) {
  calOpen = false;
  viewDay = k === todayKey() ? null : k;
  renderNote(note);
}

function monthGrid(note) {
  const today = todayKey(), min = earliestDay(note), mark = markedDays(note);
  const chosen = viewDay || today;
  const month = parseDay(chosen);
  month.setDate(1);
  const monthKey = (d) => d.getFullYear() * 12 + d.getMonth();
  const pop = el('div', 'calinline');
  pop.addEventListener('click', (e) => e.stopPropagation());
  const draw = () => {
    pop.innerHTML = '';
    const head = el('div', 'calhead');
    const pm = iconBtn('back', 'Previous month', () => { month.setMonth(month.getMonth() - 1); draw(); });
    const nm = iconBtn('fwd', 'Next month', () => { month.setMonth(month.getMonth() + 1); draw(); });
    pm.disabled = monthKey(month) <= monthKey(parseDay(min));
    nm.disabled = monthKey(month) >= monthKey(parseDay(lastDay()));
    head.append(pm, el('b', '', month.toLocaleDateString([], { month: 'long', year: 'numeric' })), nm);
    pop.append(head);
    const grid = el('div', 'calgrid');
    for (const w of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) grid.append(el('span', 'wd', w));
    const d = new Date(month);
    d.setDate(1 - month.getDay());
    for (let i = 0; i < 42; i++, d.setDate(d.getDate() + 1)) {
      const k = dayKey(d);
      const b = el('button', 'calday' + (d.getMonth() !== month.getMonth() ? ' out' : '') + (k === chosen ? ' sel' : '')
        + (k === today ? ' today' : '') + (mark.has(k) ? ' has' : ''), String(d.getDate()));
      b.disabled = k > lastDay() || k < min;
      b.onclick = () => pickDay(note, k);
      grid.append(b);
    }
    pop.append(grid);
    const off = el('button', 'caloff', 'Turn off calendar');
    off.title = 'Stop rolling unfinished to-dos over to the next day';
    off.onclick = () => setCalendar(note, false);
    pop.append(off);
  };
  draw();
  return pop;
}

function setCalendar(note, on) {
  note.calendar = on;
  calOpen = false;
  viewDay = null;
  stampDates(note);
  touch();
  renderNote(note);
  toast(on ? 'Calendar on: unfinished to-dos roll over daily' : 'Calendar off');
}

// The button that turns the calendar on (off state) or opens / closes the month dropdown (on state).
function calButton(note) {
  const b = el('button', 'calbtn' + (note.calendar && calOpen ? ' on' : ''));
  b.innerHTML = svg('calendar');
  b.title = !note.calendar ? 'Turn on calendar: unfinished to-dos roll over to the next day' : calOpen ? 'Hide calendar' : 'Show calendar';
  b.onclick = (e) => {
    e.stopPropagation();
    if (!note.calendar) return setCalendar(note, true);
    calOpen = !calOpen;
    renderNote(note);
  };
  return b;
}

function dayStrip(note) {
  const today = todayKey(), chosen = viewDay || today, mark = markedDays(note);
  const wrap = el('div', 'daynav');
  const row = el('div', 'daystrip-row');
  const strip = el('div', 'daystrip');
  const start = parseDay(earliestDay(note));
  const floor = parseDay(today);
  floor.setDate(floor.getDate() - 180);
  const d = start < floor ? floor : start;
  const end = parseDay(today);
  end.setDate(end.getDate() + 30); // upcoming days can be planned
  for (const cur = new Date(d); cur <= end; cur.setDate(cur.getDate() + 1)) {
    const k = dayKey(cur);
    const b = el('button', 'dchip' + (k === chosen ? ' sel' : '') + (k === today ? ' today' : '') + (k > today ? ' future' : '') + (mark.has(k) ? ' has' : ''));
    b.innerHTML = `<em>${cur.toLocaleDateString([], { weekday: 'short' })}</em><b>${cur.getDate()}</b>`;
    b.title = dayLabel(k);
    b.dataset.day = k;
    b.onclick = () => pickDay(note, k);
    strip.append(b);
  }
  const page = (dir) => () => strip.scrollBy({ left: dir * strip.clientWidth * 0.8, behavior: 'smooth' });
  const prev = iconBtn('back', 'Earlier days', page(-1), 'dnav');
  const next = iconBtn('fwd', 'Later days', page(1), 'dnav');
  row.append(prev, strip, next, calButton(note), sortButton(note, true));
  wrap.append(row);
  if (calOpen) {
    wrap.append(monthGrid(note));
    const away = () => { document.removeEventListener('click', away); if (calOpen) { calOpen = false; if (curNote === note) renderNote(note); } };
    setTimeout(() => document.addEventListener('click', away));
  }
  requestAnimationFrame(() => {
    const sel = strip.querySelector('.dchip.sel');
    if (sel) strip.scrollLeft = sel.offsetLeft - strip.clientWidth / 2 + sel.offsetWidth / 2;
  });
  return wrap;
}

// Sort-to-dos picker: a labelled chip on plain notes, an icon beside the calendar button on calendar notes.
function sortButton(note, icon) {
  const modeLabel = () => TODO_SORTS.find(x => x[0] === (note.prioSort || 'high'))[1];
  const sb = el('button', icon ? 'calbtn' : 'chip');
  sb.innerHTML = icon ? svg('sort') : `${svg('sort')}<span>Sort to-dos</span>`;
  sb.title = `Sort to-dos: ${modeLabel()}`;
  sb.onclick = (e) => {
    e.stopPropagation();
    showMenu({ rect: sb.getBoundingClientRect() },
      TODO_SORTS.map(([k, label]) => ({ label, on: k === (note.prioSort || 'high'), fn: () => {
        note.prioSort = k; sortTodos(note.rows);
        if (rowsBox) drawRows();
        touch(); sb.title = `Sort to-dos: ${modeLabel()}`;
      } })));
  };
  return sb;
}

function noteOptions(note) {
  const wrap = el('div');
  if (note.calendar) { wrap.append(dayStrip(note)); return wrap; }
  const box = el('div', 'opts');
  box.append(calButton(note), sortButton(note));
  wrap.append(box);
  return wrap;
}

function updateTitle() {
  if (curNote) $('#bar-title').textContent = noteTitle(curNote) || 'New jot';
}

function touch() {
  curNote.updated = Date.now();
  updateTitle();
  save();
  refreshSide();
}

// Calendar notes: what the open day shows. A to-do finished on an earlier day (and its sub-items) only shows on
// that day's view, and rows planned for a later day stay out of sight until it arrives.
function visibleRows(note) {
  if (!note.calendar) return note.rows;
  const day = viewDay || todayKey(), out = [];
  let hideAbove = null;
  for (const r of note.rows) {
    if (hideAbove !== null && r.indent > hideAbove) continue;
    const gone = (r.from && r.from > day) || (r.todo && r.done && r.date && r.date < day);
    hideAbove = gone ? r.indent : null;
    if (!gone) out.push(r);
  }
  return out;
}

function drawRows() {
  xsel = false;
  rowsBox.innerHTML = '';
  let rows = visibleRows(curNote);
  if (!rows.length) { const r = newRow(); curNote.rows.push(r); rows = [r]; }
  for (const r of rows) rowsBox.append(buildRow(r));
  findRefresh();
}

// What the day badge means: a prediction on a future day, what happened on a past one, the current state today.
function carryTip(r, day) {
  const n = daysBetween(r.from, day), days = `${n} day${n > 1 ? 's' : ''}`;
  const since = dayLabel(r.from).replace('Yesterday', 'yesterday');
  if (day > todayKey()) return `If it's still not done, it will have carried over ${days} by ${dayLabel(day)} (planned for ${since})`;
  if (day < todayKey()) return `On ${dayLabel(day)} it had been carried over ${days} (open since ${since})`;
  return `Carried over ${days} so far (open since ${since})`;
}
// The pill on a carried-over to-do: its age on today/past days, a plain "carries over" on a future (predicted) day.
function carryPill(r, day) {
  const n = daysBetween(r.from, day);
  if (n < 1) return null; // added on this very day: nothing was carried
  const b = el('span', 'day', day > todayKey() ? 'carries over' : `${n}d`);
  b.dataset.tip = carryTip(r, day);
  return b;
}
// How many days an open to-do has been carried over into the day being viewed.
const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 864e5);
function carriedDays(r) {
  if (!curNote || !curNote.calendar || !r.todo || r.done || !r.from) return 0;
  return Math.max(0, daysBetween(r.from, viewDay || todayKey()));
}
function rowDetails(r) {
  const fmt = (t) => new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const lines = [];
  if (r.at) lines.push(['Added', fmt(r.at)]);
  if (curNote && curNote.calendar && r.from) {
    lines.push(['Planned for', dayLabel(r.from)]);
    const age = carriedDays(r);
    if (age > 0 && !isGhost(r)) lines.push(['Carried over', `${age} day${age > 1 ? 's' : ''}`]);
    if (r.todo && r.done && r.date) lines.push(['Done on', dayLabel(r.date)]);
  }
  return lines;
}

function buildRow(r) {
  const wrap = el('div', 'row' + (r.todo && r.done ? ' done' : '') + (r.todo && r.priority ? ' p' + r.priority : '') + (isDefTitle(r) ? ' deftitle' : '') + (isGhost(r) ? ' ghost' : ''));
  wrap.dataset.id = r.id;
  wrap.style.paddingLeft = r.indent * 22 + 'px';

  if (r.todo) {
    const cb = el('button', 'cb');
    cb.tabIndex = -1;
    cb.title = r.done ? 'Mark as not done' : 'Mark as done';
    if (isGhost(r)) { cb.disabled = true; cb.title = 'Carried over from ' + dayLabel(r.from) + ' · finish it on its own day'; }
    else cb.onclick = () => toggleDone(r);
    wrap.append(cb);
  } else if (r.bullet) {
    wrap.append(el('span', 'mk', markerText(r.marker)));
  }

  const ed = el('div', 'ln');
  const ghost = isGhost(r);
  ed.contentEditable = ghost ? 'false' : 'true';
  ed.spellcheck = true;
  ed.setAttribute('role', 'textbox');
  if (r.html) ed.innerHTML = r.html; else ed.textContent = r.text;
  showCarried(ed, r);
  if (!r.bullet && curNote.rows.length === 1 && !r.text) ed.dataset.ph = 'Start typing…';
  if (!ghost) {
    ed.addEventListener('input', () => onInput(r, ed));
    ed.addEventListener('keydown', (e) => onKey(e, r, ed));
    ed.addEventListener('paste', (e) => onPaste(e, r, ed));
  }
  ed.addEventListener('drop', (e) => e.preventDefault());
  wrap.append(ed);
  setFs(wrap, r);

  const pill = r.todo && !r.done && r.from && curNote.calendar ? carryPill(r, viewDay || todayKey()) : null;
  if (pill && ghost) {
    const c = el('div', 'carry');
    c.innerHTML = `${svg('calendar')}<span>Carries over if not done</span><em>${daysBetween(r.from, viewDay)}d</em>`;
    c.dataset.tip = pill.dataset.tip;
    wrap.append(c);
  } else if (pill) wrap.append(pill);
  const menu = el('button', 'row-menu');
  menu.innerHTML = svg('more');
  menu.tabIndex = -1;
  menu.title = 'Make to-do, bullet or text';
  menu.onmousedown = (e) => e.preventDefault();
  menu.onclick = () => openRowMenu([r.id], 'row', { rect: menu.getBoundingClientRect() });
  if (ghost) return wrap;
  wrap.append(menu);

  const grip = el('div', 'grip');
  grip.innerHTML = svg('grip');
  grip.title = 'Drag to reorder';
  grip.draggable = true;
  grip.addEventListener('dragstart', (e) => onDragStart(e, r, wrap));
  grip.addEventListener('dragend', onDragEnd);
  wrap.append(grip);
  if (sel.includes(r.id)) wrap.classList.add('sel');

  return wrap;
}

function focusRow(id, pos = 'end') {
  requestAnimationFrame(() => {
    const ed = $(`.row[data-id="${id}"] .ln`, rowsBox);
    if (!ed) return;
    ed.focus();
    const len = ed.textContent.length;
    setCaret(ed, Math.min(len, pos === 'end' ? len : pos === 'start' ? 0 : pos));
    ed.scrollIntoView({ block: 'nearest' });
  });
}

function redraw(focusId, pos, resetStart = false) {
  stampDates(curNote);
  renumber(curNote.rows, resetStart);
  drawRows();
  touch();
  if (focusId) focusRow(focusId, pos);
}

const idx = (r) => curNote.rows.indexOf(r);

function onInput(r, ed) {
  if (fmtBusy) return;
  if (sel.length) clearSel();
  if (!ed.textContent) ed.innerHTML = ''; // browsers leave a stray <br> behind
  if (r.st && ed.textContent && !ed.children.length) {
    ed.innerHTML = r.st.pre + escHtml(ed.textContent) + r.st.post;
    ed.removeAttribute('style');
    setCaret(ed, ed.textContent.length);
  }
  const v = ed.textContent.replace(/\u00A0/g, ' ');
  // Typing a bullet marker + space turns the line into a bullet.
  if (!r.bullet && TYPED_MARKER.test(v)) {
    r.bullet = true;
    r.marker = markerFromToken(v.slice(0, -1));
    setRich(r, '');
    return redraw(r.id, 'start');
  }
  // "[] " or "[ ] " makes it a to-do (works on plain lines and bullets).
  if (TODO_TYPED.test(v)) {
    r.bullet = true;
    r.marker = r.marker || { t: 'sym', c: '•' };
    r.todo = true;
    r.done = /x/i.test(v);
    setRich(r, '');
    if (!r.done) joinKindSet(r);
    return redraw(r.id, 'start');
  }
  syncRow(r, ed);
  touch();
}

function toggleTodo(r) {
  if (r.todo) { r.todo = false; r.done = false; joinKindSet(r); }
  else { r.todo = true; r.bullet = true; r.marker = r.marker || { t: 'sym', c: '•' }; joinKindSet(r); }
  sortTodos(curNote.rows);
  redraw(r.id, 'end');
}

function toggleDone(r) {
  if (isFuture(curNote) && r.from < viewDay) return toast('Carried over from an earlier day: finish it then');
  r.done = !r.done;
  if (curNote.calendar) r.date = viewDay || todayKey(); // done: finished that day; reopened: belongs to it
  sortTodos(curNote.rows);
  redraw(null);
  const cb = $(`.row[data-id="${r.id}"] .cb`, rowsBox);
  if (cb && r.done) cb.classList.add('pop');
}

function onKey(e, r, ed) {
  const rows = curNote.rows;
  const i = idx(r);
  const len = ed.textContent.length;
  const [start, end] = selOf(ed) || [len, len];
  const collapsed = start === end;

  if ((e.metaKey || e.ctrlKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    const cmd = { b: 'bold', i: 'italic', u: 'underline' }[k];
    if (cmd && !e.shiftKey) { e.preventDefault(); return formatIds([r.id], cmd, null, 'sel'); }
    if (k === 'h' && e.shiftKey) {
      e.preventDefault();
      return formatIds([r.id], 'highlight', selHighlighted() ? null : S.hilite || HILITES[1], 'sel');
    }
  }

  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    return toggleTodo(r);
  }

  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    // Enter on an empty bullet leaves the list (or outdents).
    if (r.bullet && !r.text) {
      if (r.indent > 0) {
        r.indent--;
        const st = levelStyle(rows, i, r.indent);
        if (st) r.st = st; else delete r.st;
      }
      else { r.bullet = false; r.todo = false; r.done = false; r.marker = null; delete r.st; }
      return redraw(r.id, 'start');
    }
    const carry = r.bullet ? (len ? styleAt(ed, start) : r.st) : null;
    const before = sliceRow(ed, 0, start);
    const after = sliceRow(ed, end, len);
    setRich(r, before.text, before.html);
    if (carry && !before.text) r.st = carry;
    const nr = newRow({ indent: r.indent });
    setRich(nr, after.text, after.html);
    if (carry && !after.text) nr.st = carry;
    if (r.bullet) {
      nr.bullet = true;
      nr.marker = nextMarker(r.marker);
      nr.todo = r.todo;
      if (r.todo) nr.priority = r.priority || 0;
    }
    rows.splice(i + 1, 0, nr); // stays right below; it's sorted into place the next time the jot is opened
    return redraw(nr.id, 'start');
  }

  if (e.key === 'Tab') {
    e.preventDefault();
    const d = e.shiftKey ? -1 : 1;
    const ni = Math.min(4, Math.max(0, r.indent + d));
    if (ni !== r.indent) {
      r.indent = ni;
      if (r.bullet && r.marker && r.marker.t !== 'sym') r.marker = { ...r.marker, n: 1 };
      if (r.bullet && !r.text) {
        const st = levelStyle(rows, i, ni);
        if (st) r.st = st; else delete r.st;
      }
      redraw(r.id, start);
    }
    return;
  }

  if (e.key === 'Backspace' && collapsed && start === 0) {
    if (r.todo) { e.preventDefault(); r.todo = false; r.done = false; return redraw(r.id, 0); }
    if (r.bullet) { e.preventDefault(); r.bullet = false; r.marker = null; return redraw(r.id, 0); }
    if (r.indent > 0) { e.preventDefault(); r.indent--; return redraw(r.id, 0); }
    const vis = visibleRows(curNote), vi = vis.indexOf(r);
    if (vi > 0 && !isGhost(vis[vi - 1])) {
      e.preventDefault();
      const prev = vis[vi - 1];
      const at = prev.text.length;
      setRich(prev, prev.text + r.text, rowHtml(prev) + rowHtml(r));
      rows.splice(i, 1);
      return redraw(prev.id, at);
    }
    return;
  }

  const visAll = visibleRows(curNote);
  if (e.key === 'Delete' && collapsed && start === len && visAll.indexOf(r) < visAll.length - 1 && !isGhost(visAll[visAll.indexOf(r) + 1])) {
    e.preventDefault();
    const next = visAll[visAll.indexOf(r) + 1];
    const at = r.text.length;
    setRich(r, r.text + next.text, rowHtml(r) + rowHtml(next));
    rows.splice(rows.indexOf(next), 1);
    return redraw(r.id, at);
  }

  if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const up = e.key === 'ArrowUp';
    const target = rows[i + (up ? -1 : 1)];
    if (target && (up ? start === 0 : end === len)) {
      e.preventDefault();
      selAnchor = r.id;
      selFocus = target.id;
      ed.blur();
      setSel(rangeIds(selAnchor, selFocus));
      showSelMenu();
    }
    return;
  }

  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && collapsed && !e.shiftKey && !e.altKey && !e.metaKey) {
    const up = e.key === 'ArrowUp';
    const vis = visibleRows(curNote).filter(x => !isGhost(x));
    const target = vis[vis.indexOf(r) + (up ? -1 : 1)];
    if (target && caretAtEdge(ed, up)) {
      e.preventDefault();
      focusRow(target.id, Math.min(start, target.text.length));
    }
  }
}

// Always paste as plain text so foreign styling never sneaks in; multi-line text becomes several rows.
function onPaste(e, r, ed) {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain').replace(/\r/g, '');
  if (!/\n/.test(text)) {
    if (text) document.execCommand('insertText', false, text);
    return;
  }
  const lines = text.replace(/\n+$/, '').split('\n');
  const len = ed.textContent.length;
  const [s0, e0] = selOf(ed) || [len, len];
  const before = sliceRow(ed, 0, s0);
  const after = sliceRow(ed, e0, len);
  const parsed = lines.map(parseLine);
  // First pasted line merges into the current row (keeps its own bullet style if it has none).
  const first = parsed[0];
  setRich(r, before.text + first.text, before.html + escHtml(first.text));
  if (!r.bullet && first.bullet && !before.text) {
    Object.assign(r, { bullet: true, marker: first.marker, todo: first.todo, done: first.done, indent: first.indent });
  }
  const rest = parsed.slice(1);
  const last = rest.length ? rest[rest.length - 1] : r;
  const at = last.text.length;
  setRich(last, last.text + after.text, rowHtml(last) + after.html);
  curNote.rows.splice(idx(r) + 1, 0, ...rest);
  sortTodos(curNote.rows);
  redraw(last.id, at);
}

// ---------- multi-select, menus ----------
let sel = [];          // ids of selected rows (contiguous)
let selAnchor = null;
let selFocus = null;
let mouseAnchor = null;
let tip = null;        // the open popover (row menu, text-style bar or context menu)
let tipKind = null;    // 'rows' | 'fmt' | 'ctx'

function rangeIds(a, b) {
  const rows = curNote.rows;
  const i = rows.findIndex(r => r.id === a), j = rows.findIndex(r => r.id === b);
  return rows.slice(Math.min(i, j), Math.max(i, j) + 1).map(r => r.id);
}

function setSel(ids) {
  sel = ids;
  rowsBox.classList.toggle('selecting', ids.length > 0);
  rowsBox.querySelectorAll('.row').forEach(n => n.classList.toggle('sel', ids.includes(n.dataset.id)));
}

function hideTip() {
  if (tip) { tip.remove(); tip = null; tipKind = null; }
}

function clearSel() {
  hideTip();
  sel = [];
  selAnchor = selFocus = null;
  if (rowsBox) setSel([]);
}

// Places a popover at a point ({x, y}) or beside a rect ({rect}: above it, or below when there's no room).
function placeTip(anchor) {
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left, top;
  if (anchor.rect) {
    const r = anchor.rect;
    left = r.left;
    top = r.top - th - 6;
    if (top < 46) top = r.bottom + 6;
  } else {
    left = anchor.x;
    top = anchor.y;
  }
  tip.style.left = Math.max(6, Math.min(left, window.innerWidth - tw - 6)) + 'px';
  tip.style.top = Math.max(46, Math.min(top, window.innerHeight - th - 6)) + 'px';
}

const keepFocus = (b) => { b.onmousedown = (e) => e.preventDefault(); return b; };

// A simple list menu: items are { icon, label, fn, danger }.
function showMenu(anchor, items) {
  hideTip();
  tip = el('div', 'menu');
  tipKind = 'ctx';
  tip.append(menuItems(items));
  document.body.append(tip);
  placeTip(anchor);
}

function menuItems(items) {
  const box = el('div', 'items');
  for (const it of items) {
    const b = keepFocus(el('button', 'mi' + (it.danger ? ' danger' : '') + (it.on ? ' on' : '')));
    b.innerHTML = `${it.icon ? svg(it.icon) : ''}<span>${it.label}</span>${it.on ? svg('check', 'tick') : ''}`;
    b.title = it.tip || it.label.replace(/<[^>]*>/g, '');
    b.onclick = () => { hideTip(); it.fn(); };
    box.append(b);
  }
  return box;
}

// The row menu. `ids` are the rows it acts on; `scope` is 'sel' (style only the selected text of one row)
// or 'row' (style whole rows). `full: false` is the slim floating bar shown over selected text.
function openRowMenu(ids, scope, anchor, full = true) {
  hideTip();
  const rows = ids.map(id => curNote.rows.find(r => r.id === id)).filter(Boolean);
  if (!rows.length) return;
  if (scope === 'row') { selAnchor = ids[0]; selFocus = ids[ids.length - 1]; setSel(ids); }
  tip = el('div', 'menu' + (full ? '' : ' slim'));
  tipKind = full ? 'rows' : 'fmt';
  const me = tip;

  const bar = el('div', 'fmtbar');
  const tool = (icon, title, fn, cmd) => {
    const b = keepFocus(el('button', 'fb'));
    b.innerHTML = svg(icon);
    b.title = title;
    if (cmd) b.dataset.cmd = cmd;
    b.onclick = fn;
    return b;
  };
  const sub = el('div', 'sub');
  sub.hidden = true;
  let open = null;
  const panel = (key, build) => () => {
    sub.innerHTML = '';
    if (open === key) { open = null; sub.hidden = true; } else { open = key; build(sub); sub.hidden = false; }
    bar.querySelectorAll('.fb[data-panel]').forEach(b => b.classList.toggle('on', b.dataset.panel === open));
    placeTip(anchor);
  };
  const apply = (kind, value) => { formatIds(ids, kind, value, scope); };
  const swatches = (list, kind) => (box) => {
    box.className = 'sub sw';
    list.forEach((c) => {
      const b = keepFocus(el('button', 'swatch' + (c ? '' : ' none')));
      if (c) b.style.setProperty('--c', c); else b.innerHTML = svg('x');
      b.title = c ? '' : 'None';
      b.onclick = () => {
        if (kind === 'highlight' && c) { S.hilite = c; save(); hlBtn.style.setProperty('--c', c); }
        apply(kind, c);
      };
      box.append(b);
    });
    if (kind === 'color') {
      // Native picker steals focus, so remember the selection and put it back before applying.
      const pick = el('label', 'swatch custom');
      pick.title = 'Custom colour';
      pick.innerHTML = svg('palette');
      const inp = el('input');
      inp.type = 'color';
      inp.value = '#635bdb';
      let saved = null;
      pick.onmousedown = () => { const s = getSelection(); saved = s.rangeCount ? s.getRangeAt(0).cloneRange() : null; };
      inp.onchange = () => {
        if (saved) {
          const ed = saved.startContainer.parentElement && saved.startContainer.parentElement.closest('.ln');
          if (ed) ed.focus();
          const s = getSelection();
          s.removeAllRanges();
          s.addRange(saved);
        }
        apply('color', inp.value);
      };
      pick.append(inp);
      box.append(pick);
    }
  };
  const styles = (box) => {
    box.className = 'sub st';
    for (const [label, spec] of FMT_STYLES) {
      const b = keepFocus(el('button', '', label));
      b.style.fontSize = Math.min(spec.px || 14, 22) + 'px';
      b.style.fontWeight = spec.bold ? 700 : 400;
      if (spec.color) b.style.color = spec.color;
      b.onclick = () => apply('preset', spec);
      box.append(b);
    }
  };
  const sizes = (box) => {
    box.className = 'sub sz';
    for (const [label, px] of FMT_SIZES) {
      const b = keepFocus(el('button', '', label));
      b.style.fontSize = Math.min(px || 14, 20) + 'px';
      b.onclick = () => apply('size', px);
      box.append(b);
    }
  };
  const panelTool = (key, icon, title, build) => {
    const b = tool(icon, title, panel(key, build));
    b.dataset.panel = key;
    return b;
  };
  // Click applies the last-used highlight colour; right-click picks another.
  // Is any of the targeted text highlighted? (then the button clears it instead)
  const isHl = () => {
    if (scope === 'sel') return selHighlighted();
    return rows.some(r => /background-color:(?!transparent)/.test(r.html || ''));
  };
  const hlBtn = tool('highlight', 'Highlight (⌘⇧H) · click again to remove · right-click to change colour', () => apply('highlight', isHl() ? null : (S.hilite || HILITES[1])));
  hlBtn.classList.add('hl');
  hlBtn.dataset.panel = 'hl';
  hlBtn.style.setProperty('--c', S.hilite || HILITES[1]);
  hlBtn.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); panel('hl', swatches(HILITES, 'highlight'))(); };
  bar.append(
    tool('bold', 'Bold (⌘B)', () => apply('bold'), 'bold'),
    tool('italic', 'Italic (⌘I)', () => apply('italic'), 'italic'),
    tool('underline', 'Underline (⌘U)', () => apply('underline'), 'underline'),
    el('i', 'sep'),
    hlBtn,
    panelTool('styles', 'heading', 'Text styles (Title, Heading, Body…)', styles),
    panelTool('color', 'color', 'Text colour', swatches(TEXT_COLORS, 'color')),
    panelTool('size', 'size', 'Text size', sizes),
    el('i', 'sep'),
    tool('clear', 'Clear styling', () => apply('clear')),
  );
  tip.append(bar, sub);

  if (full) {
    const kinds = rows.map(kindOf);
    const same = kinds.every(k => k === kinds[0]) ? kinds[0] : undefined;
    const allTodo = rows.every(r => r.todo);
    const n = rows.length;
    tip.append(
      el('hr'),
      menuItems([
        { icon: 'todo', label: allTodo ? 'Remove to-do' : 'To-do', tip: allTodo ? 'Turn back into plain rows' : 'Turn into checkable to-dos', on: same === 'todo', fn: () => applyFormat('todo', ids) },
        { icon: 'list', label: 'Bullet', tip: 'Turn into bullet points', on: same === 'sym', fn: () => applyFormat('bullet', ids) },
        { icon: 'listOrdered', label: 'Numbered', tip: 'Turn into a numbered list', on: same === 'num', fn: () => applyFormat('number', ids) },
        { icon: 'text', label: 'Text', tip: 'Plain text, no bullet or to-do', on: same === null, fn: () => applyFormat('text', ids) },
      ]),
    );
    if (allTodo) {
      const pr = el('div', 'prios');
      pr.append(el('span', '', 'Priority'));
      PRIORITIES.forEach((label, p) => {
        const b = keepFocus(el('button', 'prio p' + p + (rows.every(r => (r.priority || 0) === p) ? ' cur' : '')));
        b.title = label;
        b.onclick = () => {
          rows.forEach(r => { r.priority = p; });
          clearSel();
          sortTodos(curNote.rows);
          redraw(null);
        };
        pr.append(b);
      });
      tip.append(pr);
    }
    const info = n === 1 ? rowDetails(rows[0]) : [];
    if (info.length) {
      const d = el('div', 'details');
      for (const [k, v] of info) d.append(el('span', '', k), el('b', '', v));
      tip.append(el('hr'), d);
    }
    tip.append(el('hr'), menuItems([
      { icon: 'trash', label: n > 1 ? `Delete ${n} rows` : 'Delete row', tip: n > 1 ? 'Permanently delete the selected rows' : 'Permanently delete this row', danger: true, fn: () => deleteRows(ids) },
    ]));
  }

  tip.refresh = () => {
    if (scope !== 'sel' || tip !== me) return;
    bar.querySelectorAll('.fb[data-cmd]').forEach(b => {
      let on = false;
      try { on = document.queryCommandState(b.dataset.cmd); } catch { /* no selection */ }
      b.classList.toggle('on', on);
    });
    hlBtn.classList.toggle('on', isHl());
  };
  document.body.append(tip);
  placeTip(anchor);
  tip.refresh();
}

// Rows selected by dragging or shift+arrows: show the full menu above the first one.
function showSelMenu() {
  if (!sel.length) return;
  const first = rowsBox.querySelector(`.row[data-id="${sel[0]}"]`);
  openRowMenu([...sel], 'row', { rect: first.getBoundingClientRect() });
}

// Floating style bar over selected text inside one row.
function checkTextSel() {
  if (sel.length || !curNote || !rowsBox || S.view.screen !== 'note' || inGame) return;
  if (tip && tipKind !== 'fmt') return;
  const s = getSelection();
  if (!s.rangeCount || s.isCollapsed) { if (tipKind === 'fmt') hideTip(); return; }
  const node = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
  const ed = node && node.closest('.ln');
  if (!ed || !ed.contains(s.focusNode) || !rowsBox.contains(ed)) return;
  openRowMenu([ed.closest('.row').dataset.id], 'sel', { rect: s.getRangeAt(0).getBoundingClientRect() }, false);
}

document.addEventListener('selectionchange', () => {
  if (!tip) return;
  if (tipKind === 'fmt' && getSelection().isCollapsed) return hideTip();
  if (tip.refresh) tip.refresh();
});

function deleteRows(ids) {
  ids = ids.filter(id => !isGhost(curNote.rows.find(r => r.id === id) || {}));
  if (!ids.length) return clearSel();
  const keep = curNote.rows.filter(r => !ids.includes(r.id));
  const at = curNote.rows.findIndex(r => ids.includes(r.id));
  curNote.rows = keep.length ? keep : [newRow()];
  clearSel();
  redraw((curNote.rows[Math.max(0, at - 1)] || curNote.rows[0]).id, 'end');
}

function applyFormat(kind, ids = sel) {
  const rows = curNote.rows.filter(r => ids.includes(r.id));
  if (!rows.length) return;
  const lastId = rows[rows.length - 1].id;
  const allTodo = rows.every(r => r.todo);
  for (const r of rows) {
    if (kind === 'todo') {
      if (allTodo) { r.todo = false; r.done = false; joinKindSet(r); }
      else {
        const was = r.todo;
        r.todo = true; r.bullet = true; r.marker = r.marker || { t: 'sym', c: '•' };
        if (!was) joinKindSet(r);
      }
    } else if (kind === 'bullet' || kind === 'number') {
      const was = r.todo;
      Object.assign(r, { bullet: true, todo: false, done: false,
        marker: kind === 'bullet' ? { t: 'sym', c: '•' } : { t: 'num', n: 1, s: '.' } });
      if (was) joinKindSet(r);
    } else {
      Object.assign(r, { bullet: false, todo: false, done: false, marker: null });
    }
  }
  clearSel();
  sortTodos(curNote.rows);
  redraw(lastId, 'end');
}

document.addEventListener('mousedown', (e) => {
  if (tip && tip.contains(e.target)) return;
  const t = e.target.closest ? e.target : e.target.parentElement;
  if (e.button === 2 && t && t.closest('.row.sel')) return; // keep a multi-row selection for the context menu
  hideTip();
  if (!curNote || S.view.screen !== 'note' || !rowsBox) return;
  if (e.button !== 2) endXsel();
  if (sel.length) clearSel();
  const ed = t && t.closest('.row .ln');
  if (e.button === 2 && ed) {
    // Right-click shouldn't move the caret or grab a word; keep any selection that was clicked on.
    const s = getSelection();
    const hit = s.rangeCount && !s.isCollapsed && ed.contains(s.anchorNode) &&
      [...s.getRangeAt(0).getClientRects()].some(q => e.clientX >= q.left && e.clientX <= q.right && e.clientY >= q.top && e.clientY <= q.bottom);
    if (!hit) e.preventDefault();
  }
  mouseAnchor = e.button === 0 && ed ? ed.closest('.row').dataset.id : null;
  pressAt = mouseAnchor ? caretAt(e.clientX, e.clientY) : null;
});


// Instant tooltips for the carry badges (native title tooltips don't show reliably in this window).
let tipTimer = 0, tipEl = null;
function hideBadgeTip() { clearTimeout(tipTimer); if (tipEl) { tipEl.remove(); tipEl = null; } }
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest && e.target.closest('[data-tip]');
  if (!t) return;
  hideBadgeTip();
  tipTimer = setTimeout(() => {
    tipEl = el('div', 'badge-tip', t.dataset.tip);
    document.body.append(tipEl);
    const r = t.getBoundingClientRect(), w = tipEl.offsetWidth;
    tipEl.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
    tipEl.style.top = (r.bottom + 6 + tipEl.offsetHeight > innerHeight ? r.top - tipEl.offsetHeight - 6 : r.bottom + 6) + 'px';
  }, 120);
});
document.addEventListener('mouseout', (e) => { if (e.target.closest && e.target.closest('[data-tip]')) hideBadgeTip(); });
document.addEventListener('mousedown', hideBadgeTip, true);
document.addEventListener('scroll', hideBadgeTip, true);

// ---------- find in jot (⌘F) ----------
// WKWebView has no find bar, so: a compact bar plus highlight boxes drawn over the matching text.
let findBar = null, findLayer = null, findInput = null, findCount = null;
let findHits = [];   // Ranges
let findCur = 0;
let findRaf = 0;

function findCompute() {
  findHits = [];
  const q = findInput.value.toLowerCase();
  if (q && rowsBox && S.view.screen === 'note') {
    rowsBox.querySelectorAll('.ln').forEach((ed) => {
      const t = ed.textContent.toLowerCase();
      for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) {
        const [n1, o1] = pointAt(ed, i), [n2, o2] = pointAt(ed, i + q.length);
        const r = document.createRange();
        r.setStart(n1, o1);
        r.setEnd(n2, o2);
        findHits.push(r);
      }
    });
  }
  if (findCur >= findHits.length) findCur = 0;
  findCount.textContent = !q ? '' : findHits.length ? `${findCur + 1}/${findHits.length}` : 'No results';
  findCount.classList.toggle('none', !!q && !findHits.length);
  findDraw();
}
function findDraw() {
  findLayer.innerHTML = '';
  const host = $('#screen').getBoundingClientRect();
  Object.assign(findLayer.style, { left: host.left + 'px', top: host.top + 'px', width: host.width + 'px', height: host.height + 'px' });
  findHits.forEach((r, i) => {
    for (const q of r.getClientRects()) {
      const b = el('i', 'hit' + (i === findCur ? ' cur' : ''));
      Object.assign(b.style, { left: q.left - host.left - 1 + 'px', top: q.top - host.top + 'px', width: q.width + 2 + 'px', height: q.height + 'px' });
      findLayer.append(b);
    }
  });
}
// Called after anything that moves or rewrites the text; coalesced to one pass per frame.
function findRefresh() {
  if (!findBar || findRaf) return;
  findRaf = requestAnimationFrame(() => { findRaf = 0; if (S.view.screen !== 'note' || !rowsBox || !document.contains(rowsBox)) closeFind(); else findCompute(); });
}
function findStep(d) {
  if (!findHits.length) return;
  findCur = (findCur + d + findHits.length) % findHits.length;
  const n = findHits[findCur].startContainer;
  (n.nodeType === 1 ? n : n.parentElement).scrollIntoView({ block: 'center', behavior: 'smooth' });
  findCount.textContent = `${findCur + 1}/${findHits.length}`;
  findDraw();
  setTimeout(findDraw, 350); // after the smooth scroll settles
}
function closeFind() {
  if (!findBar) return;
  findBar.remove(); findLayer.remove();
  findBar = findLayer = findInput = findCount = null;
  findHits = [];
}
function openFind() {
  if (!curNote || S.view.screen !== 'note' || !rowsBox || inGame) return;
  if (findBar) { findInput.focus(); findInput.select(); return; }
  const s = getSelection();
  const picked = s.rangeCount && !s.isCollapsed && !String(s).includes('\n') ? String(s) : '';
  findLayer = el('div', 'find-layer');
  findBar = el('div', 'findbar');
  findInput = el('input');
  findInput.placeholder = 'Find';
  findInput.spellcheck = false;
  findInput.value = picked;
  findCount = el('span', 'cnt');
  const btn = (icon, title, fn, cls = '') => {
    const b = keepFocus(el('button', 'icon ' + cls));
    b.innerHTML = svg(icon);
    b.title = title;
    b.onclick = fn;
    return b;
  };
  findBar.append(findInput, findCount, btn('chev', 'Previous (⇧⌘G)', () => findStep(-1), 'up'), btn('chev', 'Next (⌘G)', () => findStep(1)), btn('plus', 'Close (Esc)', closeFind, 'x'));
  findInput.addEventListener('input', () => { findCur = 0; findCompute(); if (findHits.length) findStep(0); });
  findInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    else if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); findInput.select(); }
  });
  document.body.append(findLayer, findBar);
  findInput.focus();
  findInput.select();
  findCompute();
  if (findHits.length) findStep(0);
}
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'f') { e.preventDefault(); openFind(); }
  else if (k === 'g' && findBar) { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
}, true);
document.addEventListener('scroll', findRefresh, true);
window.addEventListener('resize', findRefresh);
document.addEventListener('input', (e) => { if (findBar && e.target !== findInput) findRefresh(); });

// Text selected across rows. Each row is its own editable box and the browser won't select across boxes,
// so once a drag leaves its row every row turns non-editable and we drive the selection ourselves.
let xsel = false;
let pressAt = null; // caret position where the mouse went down: { node, offset }
const caretAt = (x, y) => {
  const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
  const n = r && (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement);
  if (n && n.closest && n.closest('.ln') && rowsBox && rowsBox.contains(n) && r.startContainer.textContent !== undefined) {
    const ed = n.closest('.ln');
    if (ed.textContent || r.startContainer === ed) return { node: r.startContainer, offset: r.startOffset };
  }
  // Empty rows (and the gutters beside a row) have no text to land on: use the row itself.
  const hit = document.elementFromPoint(x, y);
  const row = hit && hit.closest && hit.closest('.row');
  const ed = row && rowsBox && rowsBox.contains(row) && row.querySelector('.ln');
  if (!ed) return null;
  if (!ed.textContent) return { node: ed, offset: 0 };
  const [node, offset] = pointAt(ed, x < ed.getBoundingClientRect().left ? 0 : ed.textContent.length);
  return { node, offset };
};
function endXsel() {
  if (!xsel) return;
  xsel = false;
  if (rowsBox) rowsBox.querySelectorAll('.row.xs').forEach(n => n.classList.remove('xs'));
  if (rowsBox) rowsBox.querySelectorAll('.ln').forEach(n => { n.contentEditable = 'true'; });
}
function dragXsel(e) {
  const to = caretAt(e.clientX, e.clientY);
  if (!to || !pressAt) return;
  if (!xsel) {
    if (document.activeElement) document.activeElement.blur();
    rowsBox.querySelectorAll('.ln').forEach(n => { n.contentEditable = 'false'; });
    xsel = true;
  }
  getSelection().setBaseAndExtent(pressAt.node, pressAt.offset, to.node, to.offset);
  // Empty rows show no text highlight, so mark every row the selection covers.
  const rg = getSelection().rangeCount ? getSelection().getRangeAt(0) : null;
  if (rg) rowsBox.querySelectorAll('.row').forEach(n => n.classList.toggle('xs', rg.intersectsNode(n.querySelector('.ln'))));
}
// Offset of a boundary inside its row's text, and the row it belongs to.
function rowPoint(node, off) {
  const ed = (node.nodeType === 1 ? node : node.parentElement).closest('.ln');
  const r = document.createRange();
  r.selectNodeContents(ed);
  r.setEnd(node, off);
  return { ed, id: ed.closest('.row').dataset.id, off: r.toString().length };
}
// Delete the cross-row selection, joining what's left of its first and last rows.
function deleteXsel() {
  const s = getSelection();
  if (!s.rangeCount || s.isCollapsed) return null;
  const rg = s.getRangeAt(0);
  const a = rowPoint(rg.startContainer, rg.startOffset), b = rowPoint(rg.endContainer, rg.endOffset);
  if (a.id === b.id) return null;
  const ids = [...rowsBox.querySelectorAll('.row')].map(n => n.dataset.id);
  const gone = ids.slice(ids.indexOf(a.id) + 1, ids.indexOf(b.id) + 1);
  if (ids.slice(ids.indexOf(a.id), ids.indexOf(b.id) + 1).some(id => isGhost(curNote.rows.find(r => r.id === id)))) return null;
  const head = sliceRow(a.ed, 0, a.off), tail = sliceRow(b.ed, b.off, b.ed.textContent.length);
  const first = curNote.rows.find(r => r.id === a.id);
  setRich(first, head.text + tail.text, (head.html || escHtml(head.text)) + (tail.html || escHtml(tail.text)));
  curNote.rows = curNote.rows.filter(r => !gone.includes(r.id));
  endXsel();
  redraw(a.id, a.off);
  return a;
}
function onXselKey(e) {
  if (e.metaKey || e.ctrlKey) {
    const k = e.key.toLowerCase();
    if (k === 'c' || k === 'a') return false;
    e.preventDefault();
    if (k === 'x') { document.execCommand('copy'); deleteXsel(); }
    return true;
  }
  if (['Shift', 'Meta', 'Control', 'Alt', 'CapsLock'].includes(e.key)) return false;
  e.preventDefault();
  if (e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter') { deleteXsel(); return true; }
  if (e.key.length === 1) {
    const at = deleteXsel();
    if (at) requestAnimationFrame(() => document.execCommand('insertText', false, e.key));
    return true;
  }
  const s = getSelection();
  const at = s.focusNode && s.focusNode.nodeType ? rowPoint(s.focusNode, s.focusOffset) : null;
  endXsel();
  s.removeAllRanges();
  if (at) focusRow(at.id, at.off);
  return true;
}

document.addEventListener('mousemove', (e) => {
  if (!mouseAnchor || !(e.buttons & 1)) return;
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const row = hit && hit.closest && hit.closest('.row');
  if (!xsel && (!row || row.dataset.id === mouseAnchor)) return;
  dragXsel(e);
});

document.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  const was = mouseAnchor;
  mouseAnchor = null;
  if (was && sel.length) showSelMenu();
  else if (was && !xsel) setTimeout(checkTextSel, 0);
});

document.addEventListener('keyup', (e) => {
  if (e.key === 'Shift' || (e.shiftKey && e.key.startsWith('Arrow')) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a')) checkTextSel();
});

// Right-click: the same options as the ⋯ button, on any row; on a jot card, its actions (see buildList).
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!curNote || !rowsBox || S.view.screen !== 'note' || inGame) return;
  const row = e.target.closest && e.target.closest('.row');
  if (!row || !rowsBox.contains(row)) return;
  const id = row.dataset.id;
  if (row.classList.contains('ghost')) return;
  const anchor = { x: e.clientX, y: e.clientY };
  if (sel.includes(id)) return openRowMenu([...sel], 'row', anchor);
  clearSel();
  const ed = row.querySelector('.ln');
  const s = ed && selOf(ed);
  if (s && s[0] !== s[1]) openRowMenu([id], 'sel', anchor);
  else openRowMenu([id], 'row', anchor);
});

// Keys while rows (not text) are selected.
function onSelKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); const id = selFocus; clearSel(); if (id) focusRow(id, 'end'); return true; }
  if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const rows = curNote.rows;
    const i = rows.findIndex(r => r.id === selFocus) + (e.key === 'ArrowUp' ? -1 : 1);
    if (rows[i]) { selFocus = rows[i].id; setSel(rangeIds(selAnchor, selFocus)); showSelMenu(); }
    return true;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); applyFormat('todo'); return true; }
  const cmd = { b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()];
  if ((e.metaKey || e.ctrlKey) && cmd) { e.preventDefault(); formatIds([...sel], cmd, null, 'row'); return true; }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    deleteRows([...sel]);
    return true;
  }
  if (e.metaKey || e.ctrlKey || e.key.length > 1) return false;
  clearSel();
  return false;
}

// ---------- drag to reorder ----------
let dragIds = [];

// A row plus the deeper-indented rows right below it (its sub-items).
function blockOf(row) {
  const rows = curNote.rows;
  const i = rows.indexOf(row);
  let j = i + 1;
  while (j < rows.length && rows[j].indent > row.indent) j++;
  return rows.slice(i, j);
}

function onDragStart(e, r, wrap) {
  dragIds = sel.includes(r.id) ? [...sel] : [r.id];
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'row');
  e.dataTransfer.setDragImage(wrap, 12, 10);
  hideTip();
  requestAnimationFrame(() => dragIds.forEach(id => {
    const n = rowsBox.querySelector(`.row[data-id="${id}"]`);
    if (n) n.classList.add('dragging');
  }));
}

function dropTarget(e) {
  const row = e.target.closest && e.target.closest('.row');
  if (!row || dragIds.includes(row.dataset.id)) return null;
  const rect = row.getBoundingClientRect();
  return { id: row.dataset.id, after: e.clientY > rect.top + rect.height / 2 };
}

function clearDropMarks() {
  rowsBox.querySelectorAll('.drop-before, .drop-after').forEach(n => n.classList.remove('drop-before', 'drop-after'));
}

function onDragEnd() {
  dragIds = [];
  clearDropMarks();
  rowsBox.querySelectorAll('.dragging').forEach(n => n.classList.remove('dragging'));
}

function installDnD(box) {
  box.addEventListener('dragover', (e) => {
    if (!dragIds.length) return;
    e.preventDefault();
    clearDropMarks();
    const t = dropTarget(e);
    if (t) box.querySelector(`.row[data-id="${t.id}"]`).classList.add(t.after ? 'drop-after' : 'drop-before');
  });
  box.addEventListener('drop', (e) => {
    if (!dragIds.length) return;
    e.preventDefault();
    const t = dropTarget(e);
    const ids = dragIds;
    onDragEnd();
    if (t) moveRows(ids, t);
  });
}

// Dragging a lone item onto a different kind (to-do, •, 1., a.) moves its whole set instead of one row.
function moveSet(row, target, after) {
  const rows = curNote.rows;
  const { blocks, s, e } = siblingBlocks(rows, row);
  const bi = blocks.findIndex(b => b.head === row);
  const ti = blocks.findIndex(b => b.head === target);
  if (bi < 0 || ti < 0) return false;
  const run = (k) => {
    const kind = kindOf(blocks[k].head);
    let from = k, to = k;
    while (from > 0 && kindOf(blocks[from - 1].head) === kind) from--;
    while (to < blocks.length - 1 && kindOf(blocks[to + 1].head) === kind) to++;
    return { from, to };
  };
  const mine = run(bi), theirs = run(ti);
  const moving = blocks.slice(mine.from, mine.to + 1);
  const rest = blocks.filter((_, k) => k < mine.from || k > mine.to);
  const t0 = rest.indexOf(blocks[theirs.from]);
  const tEnd = rest.indexOf(blocks[theirs.to]);
  rest.splice(after ? tEnd + 1 : t0, 0, ...moving);
  rows.splice(s, e - s, ...rest.flatMap(b => b.rows));
  return true;
}

function moveRows(ids, t) {
  const rows = curNote.rows;
  if (ids.length === 1) {
    const r = rows.find(x => x.id === ids[0]);
    const target = rows.find(x => x.id === t.id);
    if (r && target && r.bullet && target.bullet && kindOf(r) !== kindOf(target) && r.indent === target.indent
        && moveSet(r, target, t.after)) {
      clearSel();
      sortTodos(curNote.rows);
      return redraw(null, 0, true);
    }
  }
  const picked = rows.filter(r => ids.includes(r.id));
  const moving = [];
  picked.forEach(r => blockOf(r).forEach(b => { if (!moving.includes(b)) moving.push(b); }));
  const target = rows.find(r => r.id === t.id);
  if (moving.includes(target)) return;
  const rest = rows.filter(r => !moving.includes(r));
  let at = rest.indexOf(target);
  if (t.after) at += blockOf(target).filter(b => !moving.includes(b)).length;
  // Adopt the drop position's indent so list levels (and numbering) line up.
  const delta = target.indent - moving[0].indent;
  moving.forEach(r => { r.indent = Math.min(4, Math.max(0, r.indent + delta)); });
  rest.splice(at, 0, ...moving);
  curNote.rows = rest;
  clearSel();
  sortTodos(curNote.rows);
  redraw(null, 0, true);
}

// ---------- settings ----------
const KEY_NAMES = { Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Enter: 'Return', Backspace: 'Backspace', Tab: 'Tab', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/',
  Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`' };

function accFromEvent(e) {
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else if (KEY_NAMES[e.code]) key = KEY_NAMES[e.code];
  if (!key) return null;
  const mods = [];
  if (e.metaKey) mods.push('Command');
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}

const prettyAcc = (a) => a.replace('Command', '⌘').replace('Control', '⌃').replace('Alt', '⌥').replace('Shift', '⇧').replace(/\+/g, ' ');

function closeModal() {
  const m = $('#modal');
  if (m.hidden || m.classList.contains('out')) return;
  m.classList.add('out');
  setTimeout(() => { m.hidden = true; m.classList.remove('out'); }, 160);
}

// Narrow windows show settings as a page of its own; wider ones keep the modal.
let inSettings = false;
function exitSettings() {
  inSettings = false;
  pendingAnim = 'back';
  render();
}
function renderSettingsPage() {
  setBar('Settings', true, []);
  const { s: screen } = prepScreen(true);
  const page = el('div', 'settings-page');
  fillSettings(page);
  screen.append(page);
}

function openSettings() {
  if (!isSplit()) {
    inSettings = true;
    pendingAnim = 'fwd';
    render();
    return;
  }
  const m = $('#modal');
  m.innerHTML = '';
  m.classList.remove('out');
  m.hidden = false;
  const sheet = el('div', 'sheet');
  const h = el('h3');
  h.innerHTML = `<img class="logo-sm" src="assets/logo.png" alt=""><span>Settings</span>`;
  sheet.append(h);
  fillSettings(sheet);
  const btns = el('div', 'btns');
  const done = el('button', '', 'Done');
  done.onclick = closeModal;
  btns.append(done);
  sheet.append(btns);
  m.append(sheet);
  m.onmousedown = (e) => { if (e.target === m) closeModal(); };
}

function fillSettings(sheet) {
  // Appearance
  sheet.append(el('span', 'sec', 'Appearance'));
  const seg = el('div', 'seg');
  seg.dataset.on = THEMES.findIndex(x => x[0] === theme);
  for (const [key, label, icon] of THEMES) {
    const b = el('button', key === theme ? 'on' : '');
    b.dataset.key = key;
    b.innerHTML = `${svg(icon)}<span>${label}</span>`;
    b.onclick = () => setTheme(key);
    seg.append(b);
  }
  sheet.append(seg);

  // Shortcut
  sheet.append(el('span', 'sec', 'Global shortcut'));
  const box = el('button', 'keybox');
  const label = () => { box.innerHTML = `${svg('keyboard')}<span>${prettyAcc(shortcut)}</span>`; };
  label();
  const msg = el('div', 'note', 'Click, then press the keys you want. Tip: a bare Shift+1 stops you typing “!” elsewhere; ⌘⇧1 avoids that.');
  let rec = false;
  const stop = () => { rec = false; box.classList.remove('rec'); label(); };
  box.onclick = () => { rec = true; box.classList.add('rec'); box.innerHTML = '<span>Press shortcut…</span>'; box.focus(); };
  box.onblur = stop;
  box.onkeydown = async (e) => {
    if (!rec) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') return stop();
    const acc = accFromEvent(e);
    if (!acc) return;
    const res = await window.api.setShortcut(acc);
    if (res.ok) { shortcut = acc; msg.textContent = 'Shortcut updated.'; msg.className = 'note ok'; }
    else { msg.textContent = 'Couldn’t register that shortcut (in use by the system?).'; msg.className = 'note err'; }
    stop();
  };
  sheet.append(box, msg);

  // Launch at login
  const chk = el('label', 'toggle');
  const cb = el('input', 'switch');
  cb.type = 'checkbox';
  cb.checked = loginItem;
  cb.onchange = async () => { loginItem = await window.api.setLoginItem(cb.checked); cb.checked = loginItem; };
  chk.append(el('span', '', 'Launch at login'), cb);
  sheet.append(chk);
}

// ---------- global keys ----------
document.addEventListener('keydown', (e) => {
  if (xsel && S.view.screen === 'note' && onXselKey(e)) return;
  if (inGame) return; // the game handles its own keys
  if (e.key === 'Escape' && calOpen && S.view.screen === 'note') { e.preventDefault(); calOpen = false; renderNote(curNote); return; }
  if (!$('#modal').hidden) { if (e.key === 'Escape') closeModal(); return; }
  if (inSettings && e.key === 'Escape') { e.preventDefault(); exitSettings(); return; }
  if (sel.length && S.view.screen === 'note' && !(e.target.matches && e.target.matches('.ln') && e.key !== 'Escape') && onSelKey(e)) return;
  if (e.key === 'Escape' && (sel.length || tip)) { clearSel(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newNoteAndOpen(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); toggleSide(); return; }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (S.view.screen === 'note' && !isSplit()) leaveNote(); else window.api.hide();
  }
});
$('#back').addEventListener('click', () => (inGame ? exitGame() : inSettings ? exitSettings() : leaveNote()));

function toggleSide() {
  if (!isSplit()) return;
  S.side = !S.side;
  document.body.classList.toggle('side-off', !S.side);
  save();
}
$('#side-toggle').innerHTML = svg('side');
$('#side-toggle').addEventListener('click', toggleSide);

// Crossing the split threshold (resize, full screen) swaps between the one-screen and docked layouts.
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (inGame) return;
    if (isSplit() !== document.body.classList.contains('split')) { clearSel(); pendingAnim = 'fade'; sideFresh = true; render(); }
  }, 120);
});

window.addEventListener('blur', flush);
window.addEventListener('beforeunload', () => window.api.saveSync(S));
window.api.onFullscreen((v) => document.body.classList.toggle('fs', v));
setInterval(rollOver, 60 * 1000);
window.api.onShown(() => {
  rollOver();
  // Re-focus the editor if we were mid-note so typing can resume immediately.
  if (S.view.screen === 'note' && curNote) {
    const last = $('.row:last-child .ln', rowsBox || document);
    if (last && document.activeElement !== last && !document.activeElement?.matches?.('.ln')) last.focus();
  }
});

// ---------- boot ----------
(async function init() {
  const data = await window.api.load();
  if (data.state) S = { ...S, ...data.state };
  shortcut = data.shortcut;
  loginItem = data.loginItem;
  theme = data.theme || 'system';
  if (!SORTS[S.sort]) S.sort = 'edited';
  // Normalize older/odd data.
  S.notes.forEach(n => { if (!n.rows || !n.rows.length) n.rows = [newRow()]; });
  S.notes.forEach(stampDates);
  pendingAnim = 'fade';
  render(); // resumes on the same screen/note we left off
})();

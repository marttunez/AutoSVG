const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const stage = $('#stage'), list = $('#list'), tip = $('#tip');
const SHAPES = 'path,polygon,polyline,rect,circle,ellipse';
const AUTO = /^(path|g|rect|svg|circle|ellipse|polygon|polyline|line|use|defs|layer|group|image|text|tspan|clippath|mask|pattern|symbol|filter|a|[a-z]*gradient)[-_ ]?\d*([-_]\d+)*$/i;

let svg = null, SH = [], maxDepth = 0, units = [], colors = new Map(), assign = new Map();
let legends = [], activeL = 0, nextL = 1, z = 1;
let toolMode = 'paint', spaceDown = false, isPainting = false, paintAction = null;
let hist = [], histIdx = -1; // (antes "history": tapaba a window.history)
let lastLevel = 'auto';

// Estado de encuadre de exportación (Crop Box) y posición de la leyenda dentro del mapa
let origVB = { x: 0, y: 0, w: 800, h: 600 };
let cropBox = { x: 0, y: 0, w: 800, h: 600 };
let legPos = { x: 20, y: 20 };

const PALETTES = {
  default: ['#2e86de', '#e4572e', '#27ae60', '#f2b134', '#8e44ad', '#e84393', '#16a085', '#7f8c8d'],
  okabe: ['#0072B2', '#D55E00', '#009E73', '#E69F00', '#CC79A7', '#56B4E9', '#F0E442', '#333333'],
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725', '#f89540', '#cc4778'],
  diverging: ['#2166ac', '#67a9cf', '#d1e5f0', '#fddbc7', '#ef8a62', '#b2182b']
};

function toast(m) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = m;
  t.style.display = 'block';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.style.display = 'none', 3200);
}

// Agrupa renders consecutivos en un solo frame (pintar arrastrando)
let rafId = 0;
function renderSoon() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => { rafId = 0; render(); });
}

// Conversión de coordenadas de pantalla (puntero) a coordenadas internas del SVG
function clientToSVG(clientX, clientY) {
  if (!svg) return { x: 0, y: 0 };
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  return ctm ? pt.matrixTransform(ctm.inverse()) : { x: 0, y: 0 };
}

// --- HISTORIAL (UNDO / REDO) ---
function pushHistory() {
  if (!svg) return;
  const snap = JSON.stringify({
    assign: [...assign.entries()],
    legends: legends.map(l => ({ ...l })),
    activeL,
    vmode: $('#vmode').checked,
    cropBox: { ...cropBox },
    legPos: { ...legPos }
  });
  if (histIdx >= 0 && hist[histIdx] === snap) return;
  hist = hist.slice(0, histIdx + 1);
  hist.push(snap);
  if (hist.length > 50) hist.shift();
  histIdx = hist.length - 1;
  $('#undo').disabled = histIdx <= 0;
  $('#redo').disabled = histIdx >= hist.length - 1;
}

function restoreSnap(snapStr) {
  const s = JSON.parse(snapStr);
  assign = new Map(s.assign);
  legends = s.legends;
  activeL = s.activeL;
  $('#vmode').checked = s.vmode;
  document.body.classList.toggle('vm', s.vmode);
  $('#vopts').hidden = !s.vmode;
  if (s.cropBox) cropBox = { ...s.cropBox };
  if (s.legPos) legPos = { ...s.legPos };
  renderLegs();
  render();
  $('#undo').disabled = histIdx <= 0;
  $('#redo').disabled = histIdx >= hist.length - 1;
}

$('#undo').onclick = () => { if (histIdx > 0) restoreSnap(hist[--histIdx]); };
$('#redo').onclick = () => { if (histIdx < hist.length - 1) restoreSnap(hist[++histIdx]); };

// --- PESTAÑAS Y TEMA ---
$$('.tab-btn').forEach(btn => {
  btn.onclick = () => {
    $$('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    $$('.pane').forEach(p => p.hidden = p.id !== btn.dataset.pane);
  };
});

$('#theme-btn').onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme');
  document.documentElement.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
};

// --- FUNCIONES DE CARGA SVG ---
function pretty(id) {
  let s = id.replace(/^(region|regi[oó]n)[_\- ]+/i, '').replace(/_+/g, ' ').replace(/[-\s]\d+$/, '').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : id;
}

function label(e) {
  const a = e.getAttribute('data-name') || e.getAttribute('inkscape:label') || e.getAttribute('aria-label');
  if (a && a.trim()) return a.trim();
  const t = [...e.children].find(c => c.localName === 'title');
  if (t && t.textContent.trim()) return t.textContent.trim();
  const id = e.getAttribute('id');
  return id && !AUTO.test(id) ? pretty(id) : '';
}

function sanitize(root) {
  // animate/set pueden reescribir atributos (p. ej. href) después de la limpieza
  root.querySelectorAll('script,foreignObject,iframe,object,embed,animate,set,animateTransform,animateMotion').forEach(e => e.remove());
  root.querySelectorAll('image').forEach(e => {
    const h = e.getAttribute('href') || e.getAttribute('xlink:href') || '';
    if (!/^data:image\//i.test(h)) e.remove();
  });
  root.querySelectorAll('*').forEach(e => [...e.attributes].forEach(a => {
    const n = a.name.toLowerCase(), v = a.value.trim().toLowerCase();
    if (n.startsWith('on') || (/href$/.test(n) && v.startsWith('javascript:'))) e.removeAttribute(a.name);
  }));
}

const num = v => v && !/%$/.test(v) ? parseFloat(v) : NaN;

function load(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') {
    return toast('El archivo no es un SVG válido.');
  }
  const el = document.importNode(doc.documentElement, true);
  sanitize(el);
  stage.innerHTML = '';
  stage.appendChild(el);
  svg = el;
  assign.clear();
  z = 1;
  $('#zoom-lbl').textContent = '100%';

  const vb = el.viewBox.baseVal;
  if (!vb || !vb.width) {
    const w = num(el.getAttribute('width')), h = num(el.getAttribute('height'));
    if (w && h) {
      el.setAttribute('viewBox', `0 0 ${w} ${h}`);
    } else {
      try {
        const b = el.getBBox();
        if (b.width && b.height) el.setAttribute('viewBox', `${b.x} ${b.y} ${b.width} ${b.height}`);
        else el.setAttribute('viewBox', '0 0 800 600');
      } catch {
        el.setAttribute('viewBox', '0 0 800 600');
      }
    }
  }
  el.removeAttribute('width');
  el.removeAttribute('height');
  el.removeAttribute('style');

  const v2 = el.viewBox.baseVal;
  origVB = { x: v2.x, y: v2.y, w: v2.width || 800, h: v2.height || 600 };

  // Inicializar leyenda a un costado del mapa y el borde de exportación abarcando mapa + leyenda
  const fs = baseFontSize();
  legPos = { x: origVB.x + origVB.w + fs * 1.2, y: origVB.y + fs * 2 };
  cropBox = {
    x: origVB.x - fs,
    y: origVB.y - fs,
    w: origVB.w + fs * 13,
    h: origVB.h + fs * 2
  };

  updateStrokeVars();
  stage.classList.toggle('auto', $('#auto').checked);

  analyze();
  updateCanvasViewBox();
  ['png', 'svgx', 'copy', 'dl-csv', 'level'].forEach(i => $('#' + i).disabled = false);
  $('#lvlrow').hidden = false;
  hist = [];
  histIdx = -1;
  pushHistory();
}

function baseFontSize() {
  return Math.max(origVB.w, origVB.h * 0.25) / 22;
}

// Ajusta el viewBox visible del lienzo para que siempre quepan tanto el mapa original como el marco de exportación
function updateCanvasViewBox() {
  if (!svg) return;
  const pad = Math.max(origVB.w, origVB.h) * 0.04;
  const minX = Math.min(origVB.x, cropBox.x, legPos.x) - pad;
  const minY = Math.min(origVB.y, cropBox.y, legPos.y) - pad;
  const maxX = Math.max(origVB.x + origVB.w, cropBox.x + cropBox.w, legPos.x + baseFontSize() * 10) + pad;
  const maxY = Math.max(origVB.y + origVB.h, cropBox.y + cropBox.h, legPos.y + baseFontSize() * 6) + pad;
  svg.setAttribute('viewBox', `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
  layout();
  renderCropOverlay(); // redibuja con el tamaño de tiradores acorde al nuevo viewBox
}

function updateStrokeVars() {
  if (!svg) return;
  const base = Math.max(origVB.w || 1000, origVB.h || 1000) / 2800;
  const mult = parseFloat($('#stroke-mult').value) || 0.5;
  $('#sw-lbl').textContent = mult.toFixed(2).replace(/\.?0+$/, '') + 'x';
  svg.style.setProperty('--sw', base * mult);
  svg.style.setProperty('--empty-fill', $('#empty-col').value);
  svg.style.setProperty('--stroke-col', $('#stroke-col').value);
}

function analyze() {
  SH = [];
  maxDepth = 0;
  const skip = 'defs,clipPath,mask,pattern,symbol,marker,#g-map-labels,#g-inmap-legend,#g-crop-overlay,#g-map-title';
  for (const s of svg.querySelectorAll(SHAPES)) {
    if (s.closest(skip)) continue;
    const cs = getComputedStyle(s);
    if (cs.fill === 'none' || cs.display === 'none' || cs.visibility === 'hidden' || cs.fillOpacity === '0' || cs.opacity === '0') {
      s.classList.add('nf');
      if (cs.stroke !== 'none' && cs.display !== 'none') s.classList.add('sk');
      continue;
    }
    s.classList.add('f');
    const chain = [];
    for (let a = s; a && a !== svg; a = a.parentElement) if (label(a)) chain.unshift(a);
    maxDepth = Math.max(maxDepth, chain.length - 1);
    SH.push({ s, chain });
  }
  const L = $('#level');
  L.innerHTML = '';
  L.add(new Option('Detección automática', 'auto'));
  for (let i = 0; i <= maxDepth; i++) L.add(new Option(`Nivel ${i + 1} · ${count(i)} unidades`, i));
  L.add(new Option(`Cada forma · ${SH.length}`, 'shape'));

  // Nivel 3 (índice 2) por defecto si existe esa jerarquía
  const defaultLevel = maxDepth >= 2 ? '2' : 'auto';
  L.value = defaultLevel;
  lastLevel = defaultLevel;
  group(defaultLevel);
}

const hostAt = (x, d) => x.chain.length ? x.chain[Math.min(d, x.chain.length - 1)] : null;
const count = d => new Set(SH.map(x => hostAt(x, d)).filter(Boolean)).size;

function group(level) {
  assign.clear();
  let d = maxDepth;
  if (level === 'auto') {
    for (let i = 0; i <= maxDepth; i++) if (count(i) >= 3) { d = i; break; }
  } else if (level !== 'shape') d = +level;

  const map = new Map();
  for (const x of SH) {
    x.s.classList.remove('c', 'hov');
    const host = level === 'shape' ? x.s : hostAt(x, d) || (x.s.parentElement !== svg ? x.s.parentElement : x.s);
    if (!map.has(host)) map.set(host, []);
    map.get(host).push(x.s);
  }
  units = [...map].map(([host, shapes], i) => {
    shapes.forEach(s => s.dataset.u = i);
    return { host, shapes, name: label(host) };
  });
  renderList();
}

const uname = i => units[i].name || ('Sin nombre ' + (i + 1));

function renderList() {
  const showAll = $('#unnamed').checked, q = $('#q').value.toLowerCase();
  const sortMode = $('#sort-list').value;
  list.innerHTML = '';
  $('#nun').textContent = units.filter(u => !u.name).length;
  $('#total').textContent = units.length;

  let indices = units.map((_, i) => i).filter(i => {
    const u = units[i];
    if (!u.name && !showAll) return false;
    const n = uname(i);
    return !q || n.toLowerCase().includes(q);
  });

  if (sortMode === 'az') indices.sort((a, b) => uname(a).localeCompare(uname(b), 'es'));
  else if (sortMode === 'val') indices.sort((a, b) => (assign.get(b)?.v ?? -Infinity) - (assign.get(a)?.v ?? -Infinity));
  else if (sortMode === 'sel') indices.sort((a, b) => (assign.has(b) ? 1 : 0) - (assign.has(a) ? 1 : 0));

  units.forEach(u => { u.btn = null; u.inp = null; });

  indices.forEach(i => {
    const u = units[i];
    const n = uname(i);
    const li = document.createElement('li');
    const b = document.createElement('button');
    const d = document.createElement('span');
    const t = document.createElement('span');
    d.className = 'dot';
    t.textContent = n;
    t.style.overflow = 'hidden';
    t.style.textOverflow = 'ellipsis';
    b.append(d, t);

    b.onclick = e => {
      if (e.altKey) assign.delete(i);
      else toggle(i);
      render();
      pushHistory();
    };
    b.ondblclick = e => {
      e.stopPropagation();
      const nn = prompt('Renombrar región:', u.name || n);
      if (nn !== null && nn.trim()) {
        u.name = nn.trim();
        renderList();
      }
    };
    b.onmouseenter = () => hover(i, true);
    b.onmouseleave = () => hover(i, false);

    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = '0.1';
    inp.placeholder = '%';
    inp.setAttribute('aria-label', 'Valor de ' + n);
    inp.oninput = () => {
      const v = parseFloat(inp.value);
      const prev = assign.get(i);
      assign.set(i, { lid: prev && 'lid' in prev ? prev.lid : activeL, v: isNaN(v) ? null : Math.abs(v) });
      render();
    };
    inp.onchange = () => pushHistory();

    li.append(b, inp);
    list.appendChild(li);
    u.btn = b;
    u.inp = inp;
  });
  render();
}

function hover(i, on) {
  if (!units[i]) return;
  units[i].shapes.forEach(s => s.classList.toggle('hov', on));
}

function render() {
  colors = new Map([...assign].map(([i, a]) => [i, colorOf(a)]));
  const counts = new Map();

  units.forEach((u, i) => {
    const col = colors.get(i), a = assign.get(i);
    if (a) counts.set(a.lid, (counts.get(a.lid) || 0) + 1);
    u.shapes.forEach(s => {
      s.classList.toggle('c', !!col);
      col ? s.style.setProperty('--c', col) : s.style.removeProperty('--c');
    });
    if (u.btn) {
      u.btn.setAttribute('aria-pressed', !!col);
      u.btn.firstChild.style.background = col || '';
    }
    if (u.inp && document.activeElement !== u.inp) {
      u.inp.value = a && a.v != null ? a.v : '';
    }
  });

  $$('.lg-cnt').forEach(el => {
    el.textContent = counts.get(+el.dataset.lid) || 0;
  });

  $('#count').textContent = assign.size;
  updateStats();
  renderMapLabels();
  renderMapTitle();
  renderInMapLegend();
  renderCropOverlay();
}

function updateStats() {
  const vals = [...assign.values()].map(a => a.v).filter(v => v != null && !isNaN(v));
  const bar = $('#stats-bar');
  if (!$('#vmode').checked || !vals.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const sum = vals.reduce((a, b) => a + b, 0);
  const fmt = n => n.toLocaleString('es-CL', { maximumFractionDigits: 1 });
  $('#st-avg').textContent = fmt(sum / vals.length);
  $('#st-min').textContent = fmt(Math.min(...vals));
  $('#st-max').textContent = fmt(Math.max(...vals));
  $('#st-sum').textContent = fmt(sum);
}

// Centro de un elemento expresado en coordenadas de usuario de la raíz <svg>
// (tiene en cuenta cualquier transform de los grupos ancestros)
function centerInRoot(el) {
  const bbox = el.getBBox();
  if (!bbox.width || !bbox.height) return null;
  const pt = svg.createSVGPoint();
  pt.x = bbox.x + bbox.width / 2;
  pt.y = bbox.y + bbox.height / 2;
  const eCTM = el.getScreenCTM(), rCTM = svg.getScreenCTM();
  if (!eCTM || !rCTM) return pt;
  return pt.matrixTransform(rCTM.inverse().multiply(eCTM));
}

function renderMapLabels() {
  if (!svg) return;
  const old = svg.querySelector('#g-map-labels');
  if (old) old.remove();

  const mode = $('#lbl-mode').value;
  if (mode === 'none') return;

  const selOnly = $('#lbl-sel-only').checked;
  const fs = Math.max(origVB.w || 800, origVB.h || 600) / 65;

  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('id', 'g-map-labels');

  units.forEach((u, i) => {
    const a = assign.get(i);
    if (selOnly && !a) return;
    if (!u.name && (!a || a.v == null)) return;

    let txt = '';
    if (mode === 'name') txt = u.name;
    else if (mode === 'val') txt = a && a.v != null ? `${a.v}%` : '';
    else if (mode === 'both') txt = [u.name, a && a.v != null ? `${a.v}%` : ''].filter(Boolean).join(' · ');

    if (!txt) return;
    try {
      const c = centerInRoot(u.host);
      if (!c) return;
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', c.x);
      t.setAttribute('y', c.y + fs * 0.35);
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('font-size', fs);
      t.setAttribute('class', 'map-lbl');
      t.textContent = txt;
      g.appendChild(t);
    } catch {}
  });
  svg.appendChild(g);
}

function renderMapTitle() {
  if (!svg) return;
  const old = svg.querySelector('#g-map-title');
  if (old) old.remove();

  const titleTxt = $('#map-title').value.trim();
  if (!titleTxt) return;

  const fs = baseFontSize();
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('id', 'g-map-title');

  const t1 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  t1.setAttribute('x', cropBox.x + cropBox.w / 2);
  t1.setAttribute('y', cropBox.y + fs * 1.5);
  t1.setAttribute('text-anchor', 'middle');
  t1.setAttribute('font-size', fs * 1.25);
  t1.setAttribute('font-weight', '700');
  t1.setAttribute('font-family', 'system-ui,Arial,sans-serif');
  t1.setAttribute('fill', '#111');
  t1.textContent = titleTxt;
  g.appendChild(t1);
  svg.appendChild(g);
}

// --- LEYENDA INTERACTIVA DENTRO DEL MAPA ---
function legendSVG(fs, ink, showAllFallback = false) {
  let L = legends.filter(l => [...assign.values()].some(a => a.lid === l.id));
  if (!L.length && showAllFallback) L = legends;
  if (!L.length) return null;

  const vm = $('#vmode').checked;
  const st = $('#vsteps').value;
  const K = st === 'c' ? 20 : +st;
  const mn = +$('#vmin').value || 0, mx = +$('#vmax').value || 0, bw = fs * 8, sw = fs / 20;
  const esc = t => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const T = (x, y, t, sz, an) => `<text x="${x}" y="${y}" font-size="${sz}" text-anchor="${an || 'start'}" fill="${ink}" font-family="system-ui,Arial,sans-serif">${esc(t)}</text>`;
  let y = 0, w = bw, s = '';
  L.forEach(l => {
    s += `<rect x="0" y="${y}" width="${fs}" height="${fs}" fill="${l.color}" stroke="${ink}" stroke-width="${sw}"/>` + T(fs * 1.4, y + fs * 0.82, l.name, fs);
    w = Math.max(w, fs * 1.4 + l.name.length * fs * 0.55);
    y += fs * 1.5;
    if (vm) {
      for (let i = 0; i < K; i++) {
        const t = st !== 'c' ? (i + 1) / K : (i + 0.5) / K;
        s += `<rect x="${i * bw / K}" y="${y}" width="${bw / K + 0.3}" height="${fs * 0.7}" fill="${mixW(l.color, 0.2 + 0.8 * t)}"/>`;
      }
      s += `<rect x="0" y="${y}" width="${bw}" height="${fs * 0.7}" fill="none" stroke="${ink}" stroke-width="${sw}"/>`;
      s += T(0, y + fs * 1.5, mn + '%', fs * 0.7) + T(bw, y + fs * 1.5, mx + '%+', fs * 0.7, 'end');
      y += fs * 2.1;
    }
    y += fs * 0.4;
  });
  return { s, w, h: y };
}

function renderInMapLegend() {
  if (!svg) return;
  const old = svg.querySelector('#g-inmap-legend');
  if (old) old.remove();

  if (!$('#show-leg').checked) return;
  const scale = parseFloat($('#leg-scale').value) || 1;
  $('#leg-sz-lbl').textContent = scale.toFixed(1).replace(/\.0$/, '') + 'x';

  const fs = baseFontSize() * scale;
  const G = legendSVG(fs, '#000', true);
  if (!G) return;

  const pad = fs * 0.6;
  const hasBg = $('#leg-bg').checked;
  const bgMarkup = hasBg
    ? `<rect class="leg-hover-outline" x="${-pad}" y="${-pad}" width="${G.w + pad * 2}" height="${G.h + pad * 2}" rx="${fs * 0.2}" fill="rgba(255,255,255,0.9)" stroke="#444" stroke-width="${fs / 18}"/>`
    : `<rect class="leg-hover-outline" x="${-pad}" y="${-pad}" width="${G.w + pad * 2}" height="${G.h + pad * 2}" fill="transparent" stroke="transparent" stroke-width="${fs / 14}"/>`;

  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg"><g id="g-inmap-legend" transform="translate(${legPos.x},${legPos.y})">${bgMarkup}${G.s}</g></svg>`,
    'image/svg+xml'
  );
  const node = document.importNode(doc.documentElement.firstChild, true);
  svg.appendChild(node);
}

// --- MARCO DISCONTINUO DE EXPORTACIÓN (CROP BOX INTERACTIVO) ---
function renderCropOverlay() {
  if (!svg) return;
  const old = svg.querySelector('#g-crop-overlay');
  if (old) old.remove();

  if (!$('#show-crop').checked) return;

  const { x, y, w, h } = cropBox;
  const vb = svg.viewBox.baseVal;
  const hs = Math.max(vb.width || 800, vb.height || 600) / (110 * Math.sqrt(z));

  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('id', 'g-crop-overlay');

  // Fondo blanco sutil + línea punteada negra para contraste en cualquier fondo
  const rBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rBg.setAttribute('x', x);
  rBg.setAttribute('y', y);
  rBg.setAttribute('width', w);
  rBg.setAttribute('height', h);
  rBg.setAttribute('class', 'crop-rect-bg');

  const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  r.setAttribute('x', x);
  r.setAttribute('y', y);
  r.setAttribute('width', w);
  r.setAttribute('height', h);
  r.setAttribute('class', 'crop-rect');

  g.append(rBg, r);

  // Bordes arrastrables
  const edges = [
    { d: 'n', x1: x, y1: y, x2: x + w, y2: y, cur: 'ns-resize' },
    { d: 's', x1: x, y1: y + h, x2: x + w, y2: y + h, cur: 'ns-resize' },
    { d: 'w', x1: x, y1: y, x2: x, y2: y + h, cur: 'ew-resize' },
    { d: 'e', x1: x + w, y1: y, x2: x + w, y2: y + h, cur: 'ew-resize' }
  ];
  edges.forEach(ed => {
    const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    ln.setAttribute('x1', ed.x1);
    ln.setAttribute('y1', ed.y1);
    ln.setAttribute('x2', ed.x2);
    ln.setAttribute('y2', ed.y2);
    ln.setAttribute('class', 'crop-edge');
    ln.style.cursor = ed.cur;
    ln.dataset.cropDir = ed.d;
    g.appendChild(ln);
  });

  // 8 Tiradores (Esquinas y centros de cada lado)
  const handles = [
    { d: 'nw', cx: x, cy: y, cur: 'nwse-resize' },
    { d: 'n', cx: x + w / 2, cy: y, cur: 'ns-resize' },
    { d: 'ne', cx: x + w, cy: y, cur: 'nesw-resize' },
    { d: 'e', cx: x + w, cy: y + h / 2, cur: 'ew-resize' },
    { d: 'se', cx: x + w, cy: y + h, cur: 'nwse-resize' },
    { d: 's', cx: x + w / 2, cy: y + h, cur: 'ns-resize' },
    { d: 'sw', cx: x, cy: y + h, cur: 'nesw-resize' },
    { d: 'w', cx: x, cy: y + h / 2, cur: 'ew-resize' }
  ];
  handles.forEach(hnd => {
    const hr = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    hr.setAttribute('x', hnd.cx - hs / 2);
    hr.setAttribute('y', hnd.cy - hs / 2);
    hr.setAttribute('width', hs);
    hr.setAttribute('height', hs);
    hr.setAttribute('class', 'crop-handle');
    hr.style.cursor = hnd.cur;
    hr.dataset.cropDir = hnd.d;
    g.appendChild(hr);
  });

  svg.appendChild(g);
}

function toggle(i) {
  const a = assign.get(i);
  a && a.lid === activeL ? assign.delete(i) : assign.set(i, { lid: activeL, v: a ? a.v : null });
  render();
}

function layout() {
  if (!svg) return;
  const vb = svg.viewBox.baseVal;
  const ar = (vb.width || 800) / (vb.height || 600);
  const w = Math.min(stage.clientWidth - 48, (stage.clientHeight - 48) * ar);
  svg.style.width = Math.max(w, 50) * z + 'px';
  svg.style.height = Math.max(w, 50) * z / ar + 'px';
}

// --- EVENTOS DEL LIENZO (ARRASTRAR BORDES, LEYENDA, PAN Y PINTAR) ---
const isPan = e => toolMode === 'pan' || spaceDown || e.button === 1 || e.button === 2;

stage.addEventListener('pointerdown', e => {
  if (!svg) return;

  // 1. Modo Mover Lienzo (Pan)
  if (isPan(e)) {
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('pan-mode', 'panning');
    tip.style.display = 'none';
    const x0 = e.clientX, y0 = e.clientY, sl = stage.scrollLeft, st = stage.scrollTop;
    stage.onpointermove = m => {
      stage.scrollLeft = sl - (m.clientX - x0);
      stage.scrollTop = st - (m.clientY - y0);
    };
    stage.onpointerup = stage.onpointercancel = () => {
      stage.classList.remove('panning');
      if (toolMode !== 'pan' && !spaceDown) stage.classList.remove('pan-mode');
      stage.onpointermove = stage.onpointerup = stage.onpointercancel = null;
    };
    return;
  }

  if (e.button !== 0) return;

  // 2. Redimensionar el borde discontinuo de exportación (Crop Box)
  const cropTarget = e.target.closest('[data-crop-dir]');
  if (cropTarget) {
    e.preventDefault();
    e.stopPropagation();
    const dir = cropTarget.dataset.cropDir;
    stage.setPointerCapture(e.pointerId);
    const startPt = clientToSVG(e.clientX, e.clientY);
    const startBox = { ...cropBox };
    const minSize = baseFontSize() * 2;

    stage.onpointermove = m => {
      const curPt = clientToSVG(m.clientX, m.clientY);
      const dx = curPt.x - startPt.x;
      const dy = curPt.y - startPt.y;
      let { x, y, w, h } = startBox;

      if (dir.includes('w')) {
        const nw = Math.max(minSize, w - dx);
        x += w - nw;
        w = nw;
      }
      if (dir.includes('e')) {
        w = Math.max(minSize, w + dx);
      }
      if (dir.includes('n')) {
        const nh = Math.max(minSize, h - dy);
        y += h - nh;
        h = nh;
      }
      if (dir.includes('s')) {
        h = Math.max(minSize, h + dy);
      }
      cropBox = { x, y, w, h };
      renderMapTitle();
      renderCropOverlay();
    };
    stage.onpointerup = stage.onpointercancel = () => {
      stage.onpointermove = stage.onpointerup = stage.onpointercancel = null;
      updateCanvasViewBox();
      pushHistory();
    };
    return;
  }

  // 3. Arrastrar la Leyenda dentro del mapa
  const legTarget = e.target.closest('#g-inmap-legend');
  if (legTarget) {
    e.preventDefault();
    e.stopPropagation();
    stage.setPointerCapture(e.pointerId);
    const startPt = clientToSVG(e.clientX, e.clientY);
    const startLeg = { ...legPos };

    stage.onpointermove = m => {
      const curPt = clientToSVG(m.clientX, m.clientY);
      legPos = {
        x: startLeg.x + (curPt.x - startPt.x),
        y: startLeg.y + (curPt.y - startPt.y)
      };
      const g = svg.querySelector('#g-inmap-legend');
      if (g) g.setAttribute('transform', `translate(${legPos.x},${legPos.y})`);
    };
    stage.onpointerup = stage.onpointercancel = () => {
      stage.onpointermove = stage.onpointerup = stage.onpointercancel = null;
      updateCanvasViewBox();
      pushHistory();
    };
    return;
  }

  // 4. Pintar regiones
  const s = e.target.closest('[data-u]');
  if (!s) return;
  const uIdx = +s.dataset.u;
  isPainting = true;

  if (e.altKey) {
    paintAction = 'erase';
    assign.delete(uIdx);
  } else {
    const a = assign.get(uIdx);
    paintAction = (a && a.lid === activeL) ? 'erase' : 'paint';
    if (paintAction === 'erase') assign.delete(uIdx);
    else assign.set(uIdx, { lid: activeL, v: a ? a.v : null });
  }
  renderSoon();
});

window.addEventListener('pointerup', () => {
  if (isPainting) {
    isPainting = false;
    paintAction = null;
    // Asegura que el último render pendiente ya se aplicó antes de guardar el snapshot
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; render(); }
    pushHistory();
  }
});

stage.addEventListener('mouseover', e => {
  const s = e.target.closest('[data-u]');
  if (!s) return;
  const uIdx = +s.dataset.u;
  hover(uIdx, true);

  if (isPainting && paintAction) {
    const a = assign.get(uIdx);
    if (paintAction === 'erase') assign.delete(uIdx);
    else assign.set(uIdx, { lid: activeL, v: a ? a.v : null });
    renderSoon();
  }

  tip.textContent = uname(uIdx);
  tip.style.display = 'block';
});

stage.addEventListener('mouseout', e => {
  const s = e.target.closest('[data-u]');
  if (s) {
    hover(+s.dataset.u, false);
    tip.style.display = 'none';
  }
});

stage.addEventListener('mousemove', e => {
  tip.style.left = (e.clientX + 14) + 'px';
  tip.style.top = (e.clientY + 14) + 'px';
});

$('#tool-paint').onclick = () => {
  toolMode = 'paint';
  $('#tool-paint').classList.add('active');
  $('#tool-pan').classList.remove('active');
  stage.classList.remove('pan-mode');
};
$('#tool-pan').onclick = () => {
  toolMode = 'pan';
  $('#tool-pan').classList.add('active');
  $('#tool-paint').classList.remove('active');
  stage.classList.add('pan-mode');
};

window.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if (e.code === 'Space' && !spaceDown) {
    spaceDown = true;
    stage.classList.add('pan-mode');
    e.preventDefault();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? $('#redo').click() : $('#undo').click();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    $('#redo').click();
  }
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space') {
    spaceDown = false;
    if (toolMode !== 'pan') stage.classList.remove('pan-mode');
  }
});

['dragover', 'dragenter'].forEach(t => stage.addEventListener(t, e => {
  e.preventDefault();
  stage.classList.add('drag');
}));
['dragleave', 'drop'].forEach(t => stage.addEventListener(t, () => stage.classList.remove('drag')));
stage.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) read(f);
});

async function read(f) {
  if (f.size > 30e6) return toast('Archivo demasiado grande (máx. 30 MB).');
  load(await f.text());
}

$('#up').onclick = () => $('#file').click();
if ($('#empty-drop')) $('#empty-drop').onclick = () => $('#file').click();
$('#file').onchange = e => {
  if (e.target.files[0]) read(e.target.files[0]);
  e.target.value = '';
};

// Cambiar de nivel reasigna los índices de las unidades: se reinicia el historial
// (si no, deshacer aplicaría selecciones a regiones equivocadas)
$('#level').onchange = e => {
  if (assign.size && !confirm('Cambiar el nivel borrará las selecciones actuales. ¿Continuar?')) {
    e.target.value = lastLevel;
    return;
  }
  lastLevel = e.target.value;
  group(e.target.value);
  hist = [];
  histIdx = -1;
  pushHistory();
};

// --- LEYENDAS Y COLOR ---
const hex2 = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mixW = (h, t) => '#' + hex2(h).map(v => Math.round(255 + (v - 255) * t).toString(16).padStart(2, '0')).join('');

function shade(col, v) {
  if (!$('#vmode').checked || v == null) return col;
  const mn = +$('#vmin').value || 0, mx = +$('#vmax').value || 0;
  let t = Math.min(1, Math.max(0, (Math.abs(v) - mn) / ((mx - mn) || 1)));
  const st = $('#vsteps').value;
  if (st !== 'c') {
    const k = +st;
    t = Math.max(1, Math.ceil(t * k)) / k;
  }
  return mixW(col, 0.2 + 0.8 * t);
}

function colorOf(a) {
  const L = legends.find(l => l.id === a.lid);
  return L ? shade(L.color, a.v) : '#999999';
}

function addLeg(name, color) {
  const pal = PALETTES.default;
  const L = {
    id: nextL,
    name: name || 'Leyenda ' + nextL,
    color: color || pal[legends.length % pal.length]
  };
  nextL++;
  legends.push(L);
  renderLegs();
  return L;
}

function renderLegs() {
  const box = $('#legs');
  box.innerHTML = '';
  legends.forEach(L => {
    const r = document.createElement('div');
    r.className = 'lg' + (L.id === activeL ? ' active' : '');

    const rd = document.createElement('input');
    rd.type = 'radio';
    rd.name = 'al';
    rd.checked = L.id === activeL;
    rd.title = 'Leyenda activa';
    rd.onchange = () => { activeL = L.id; renderLegs(); };

    const c = document.createElement('input');
    c.type = 'color';
    c.value = L.color;
    c.oninput = () => { L.color = c.value; render(); };
    c.onchange = () => pushHistory();

    const n = document.createElement('input');
    n.type = 'text';
    n.value = L.name;
    n.setAttribute('aria-label', 'Nombre de la leyenda');
    n.onfocus = () => {
      activeL = L.id;
      $$('.lg').forEach((el, idx) => el.classList.toggle('active', legends[idx]?.id === activeL));
      rd.checked = true;
    };
    n.oninput = () => { L.name = n.value; render(); };
    n.onchange = () => pushHistory();

    const cnt = document.createElement('span');
    cnt.className = 'lg-cnt';
    cnt.dataset.lid = L.id;
    cnt.textContent = '0';

    const x = document.createElement('button');
    x.textContent = '×';
    x.title = 'Quitar leyenda';
    x.style.padding = '0 6px';
    x.onclick = () => {
      if (legends.length < 2) return;
      legends = legends.filter(l => l !== L);
      [...assign].forEach(([i, a]) => { if (a.lid === L.id) assign.delete(i); });
      if (activeL === L.id) activeL = legends[0].id;
      renderLegs();
      render();
      pushHistory();
    };
    r.append(rd, c, n, cnt, x);
    box.appendChild(r);
  });
}

$('#pal-sel').onchange = e => {
  const pal = PALETTES[e.target.value];
  if (!pal) return;
  legends.forEach((l, i) => { l.color = pal[i % pal.length]; });
  e.target.value = '';
  renderLegs();
  render();
  pushHistory();
};

function setVM(on) {
  $('#vmode').checked = on;
  document.body.classList.toggle('vm', on);
  $('#vopts').hidden = !on;
  render();
}

$('#vmode').onchange = e => { setVM(e.target.checked); pushHistory(); };
['vmin', 'vmax', 'vsteps'].forEach(i => $('#' + i).addEventListener('input', render));

$('#autorange').onclick = () => {
  const vals = [...assign.values()].map(a => a.v).filter(v => v != null && !isNaN(v)).map(Math.abs);
  if (!vals.length) return toast('No hay valores numéricos ingresados.');
  $('#vmin').value = Math.floor(Math.min(...vals));
  $('#vmax').value = Math.ceil(Math.max(...vals));
  render();
};

$('#addleg').onclick = () => { activeL = addLeg().id; renderLegs(); render(); pushHistory(); };

// Controles de Leyenda en el mapa y Borde de Exportación
['show-leg', 'leg-bg', 'leg-scale', 'show-crop'].forEach(id => {
  $('#' + id).oninput = render;
});

$('#reset-crop').onclick = () => {
  if (!svg) return;
  const fs = baseFontSize();
  const legG = svg.querySelector('#g-inmap-legend');
  let maxX = origVB.x + origVB.w, maxY = origVB.y + origVB.h;
  let minX = origVB.x, minY = origVB.y;
  if (legG && $('#show-leg').checked) {
    try {
      const lb = legG.getBBox();
      minX = Math.min(minX, legPos.x + lb.x);
      minY = Math.min(minY, legPos.y + lb.y);
      maxX = Math.max(maxX, legPos.x + lb.x + lb.width);
      maxY = Math.max(maxY, legPos.y + lb.y + lb.height);
    } catch {}
  }
  cropBox = {
    x: minX - fs,
    y: minY - fs,
    w: (maxX - minX) + fs * 2,
    h: (maxY - minY) + fs * 2
  };
  updateCanvasViewBox();
  render();
  pushHistory();
};

$('#reset-leg').onclick = () => {
  if (!svg) return;
  const fs = baseFontSize();
  legPos = { x: origVB.x + origVB.w + fs * 1.2, y: origVB.y + fs * 2 };
  updateCanvasViewBox();
  render();
  pushHistory();
};

// --- IMPORTAR CSV ---
const norm = s => (s || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/^(comuna|region|provincia)\s+(de\s+|del\s+)?/i, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

$('#imp').onclick = () => {
  if (!units.length) return toast('Primero sube o espera a que cargue el archivo SVG.');

  // Agrupar todos los índices que compartan nombre normalizado (por si una comuna tiene varios polígonos/islas)
  const idxMap = new Map();
  units.forEach((u, i) => {
    const k = norm(u.name);
    if (!k) return;
    if (!idxMap.has(k)) idxMap.set(k, []);
    idxMap.get(k).push(i);
  });

  // Búsqueda inteligente: exacta -> por inclusión de palabras -> por similitud
  const findMatches = rawName => {
    const n = norm(rawName);
    if (!n) return [];
    if (idxMap.has(n)) return idxMap.get(n);

    const t = n.split(' ').filter(Boolean);
    let bestKey = null, bestScore = 0;

    for (const [k] of idxMap) {
      const ks = k.split(' ').filter(Boolean);
      const common = ks.filter(x => t.includes(x)).length;
      if (!common) continue;
      // Puntuación combinada (Jaccard + cobertura de la búsqueda)
      const score = (common / new Set([...t, ...ks]).size) * 0.6 + (common / t.length) * 0.4;
      if (score > bestScore) {
        bestScore = score;
        bestKey = k;
      }
    }
    return bestScore >= 0.45 && bestKey ? idxMap.get(bestKey) : [];
  };

  let ok = 0, anyV = false;
  const miss = [];

  $('#data').value.split(/\r?\n/).forEach(line => {
    line = line.trim();
    if (!line) return;

    // Detectar separador: priorizar punto y coma (;) o tabulador (\t), si no usar coma (,)
    const sep = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ',';
    const c = line.split(sep).map(x => x.trim()).filter(x => x !== '');
    if (c.length < 2 || !c[0]) return;

    const matchedIndices = findMatches(c[0]);
    if (!matchedIndices.length) {
      if (!/^(regi|comuna|nombre|unidad|id)/i.test(c[0])) miss.push(c[0]);
      return;
    }

    const pNum = x => {
      if (x == null || x === '') return NaN;
      const clean = String(x).replace(/%/g, '').replace(',', '.').trim();
      return /^-?\d+(\.\d+)?$/.test(clean) ? parseFloat(clean) : NaN;
    };

    const getL = n => legends.find(l => norm(l.name) === norm(n)) || addLeg(n);

    let lid, v;
    if (c.length >= 3) {
      // Si el usuario usó coma como separador y escribió un decimal con coma (ej: "Santiago, 12, 5")
      if (sep === ',' && !isNaN(pNum(c[1])) && !isNaN(pNum(c[2])) && c.length === 3) {
        v = parseFloat(`${c[1]}.${c[2]}`);
        lid = (v >= 0 ? legends[0] : legends[1] || legends[0]).id;
      } else {
        lid = getL(c[1]).id;
        v = pNum(c[2]);
      }
    } else {
      v = pNum(c[1]);
      if (isNaN(v)) {
        lid = getL(c[1]).id;
      } else {
        lid = (v >= 0 ? legends[0] : legends[1] || legends[0]).id;
      }
    }

    if (!isNaN(v)) {
      anyV = true;
      v = Math.abs(v);
    } else {
      v = null;
    }

    matchedIndices.forEach(idx => {
      assign.set(idx, { lid, v });
    });
    ok++;
  });
  renderLegs();
  if (anyV) {
    setVM(true);
    $('#autorange').click(); // ajusta mín/máx a los valores importados
  }
  renderList(); // Actualiza tanto la lista lateral como los colores del mapa (render)
  pushHistory();

  toast(
    `${ok} filas aplicadas` +
    (miss.length ? ` · No encontradas (${miss.length}): ${miss.slice(0, 4).join(', ')}${miss.length > 4 ? '…' : ''}` : '')
  );
};

addLeg('Opción A', '#2e86de');
addLeg('Opción B', '#e4572e');
activeL = legends[0].id;
renderLegs();

// --- APARIENCIA Y CONTROLES ---
$('#auto').onchange = e => stage.classList.toggle('auto', e.target.checked);
['empty-col', 'stroke-col', 'stroke-mult'].forEach(id => $('#' + id).oninput = updateStrokeVars);
$('#bg-trans').onchange = e => { $('#bg-col-row').hidden = e.target.checked; };
['lbl-mode', 'lbl-sel-only'].forEach(id => $('#' + id).onchange = renderMapLabels);
$('#map-title').oninput = renderMapTitle;

$('#all').onclick = () => {
  units.forEach((_, i) => assign.set(i, { lid: activeL, v: assign.get(i) ? assign.get(i).v : null }));
  render();
  pushHistory();
};
$('#invert').onclick = () => {
  units.forEach((_, i) => {
    if (assign.has(i)) assign.delete(i);
    else assign.set(i, { lid: activeL, v: null });
  });
  render();
  pushHistory();
};
$('#none').onclick = () => { assign.clear(); render(); pushHistory(); };
$('#q').oninput = renderList;
$('#unnamed').onchange = renderList;
$('#sort-list').onchange = renderList;

// --- ZOOM (15% A 4000%) ---
function zoomAt(k, cx, cy) {
  if (!svg) return;
  const nz = Math.min(40, Math.max(0.15, z * k));
  if (nz === z) return;
  const r = svg.getBoundingClientRect();
  const fx = Math.min(1, Math.max(0, (cx - r.left) / r.width));
  const fy = Math.min(1, Math.max(0, (cy - r.top) / r.height));
  z = nz;
  $('#zoom-lbl').textContent = Math.round(z * 100) + '%';
  layout();
  renderCropOverlay();
  const r2 = svg.getBoundingClientRect();
  stage.scrollLeft += r2.left + fx * r2.width - cx;
  stage.scrollTop += r2.top + fy * r2.height - cy;
}

const mid = () => {
  const b = stage.getBoundingClientRect();
  return [b.left + b.width / 2, b.top + b.height / 2];
};
$('#zi').onclick = () => zoomAt(1.4, ...mid());
$('#zo').onclick = () => zoomAt(1 / 1.4, ...mid());
$('#zfit').onclick = () => {
  z = 1;
  $('#zoom-lbl').textContent = '100%';
  layout();
  renderCropOverlay();
};

stage.addEventListener('wheel', e => {
  if (!svg) return;
  e.preventDefault();
  zoomAt(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0018)), e.clientX, e.clientY);
}, { passive: false });

stage.addEventListener('contextmenu', e => e.preventDefault());
addEventListener('resize', layout);

// --- EXPORTAR USANDO EXACTAMENTE EL MARCO DE RECORTE Y LA LEYENDA EN EL MAPA ---
function exportClone() {
  const c = svg.cloneNode(true), auto = $('#auto').checked;
  const sw = svg.style.getPropertyValue('--sw') || 0.5;
  const emptyCol = $('#empty-col').value;
  const strokeCol = $('#stroke-col').value;

  // 1. Remover el marco punteado y los tiradores del archivo exportado
  const cropOv = c.querySelector('#g-crop-overlay');
  if (cropOv) cropOv.remove();

  // 2. Si no hay fondo blanco en la leyenda, quitar el rectángulo invisible de hover
  if (!$('#leg-bg').checked) {
    const legOutline = c.querySelector('.leg-hover-outline');
    if (legOutline) legOutline.remove();
  }

  // 3. Aplicar estilos en línea (inline) a las regiones para que no dependan de style.css
  c.querySelectorAll('.f').forEach(e => {
    const col = colors.get(+e.dataset.u), st = e.style;
    if (col) st.setProperty('fill', col, 'important');
    else if (auto) st.setProperty('fill', emptyCol, 'important');
    if (auto) {
      st.setProperty('stroke', strokeCol, 'important');
      st.setProperty('stroke-width', sw, 'important');
      st.setProperty('stroke-linejoin', 'round', 'important');
      st.setProperty('stroke-linecap', 'round', 'important');
    }
  });
  if (auto) {
    c.querySelectorAll('.nf.sk').forEach(e => {
      e.style.setProperty('stroke', strokeCol, 'important');
      e.style.setProperty('stroke-width', sw, 'important');
    });
  }

  // 4. Aplicar estilos en línea a las etiquetas (.map-lbl) para que funcionen dentro del PNG
  c.querySelectorAll('.map-lbl').forEach(t => {
    t.setAttribute('font-family', 'system-ui, Arial, sans-serif');
    t.setAttribute('font-weight', '600');
    t.setAttribute('fill', '#111111');
    t.style.paintOrder = 'stroke';
    t.style.stroke = 'rgba(255, 255, 255, 0.85)';
    t.style.strokeWidth = '2px';
  });

  c.querySelectorAll('[style]').forEach(e => e.style.removeProperty('--c'));
  c.querySelectorAll('[class]').forEach(e => {
    e.classList.remove('f', 'nf', 'sk', 'c', 'hov', 'leg-hover-outline', 'map-lbl');
    if (!e.getAttribute('class')) e.removeAttribute('class');
  });
  c.querySelectorAll('[data-u]').forEach(e => e.removeAttribute('data-u'));

  // 5. Asegurar namespaces estándar requeridos por Image() y Canvas
  c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  c.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

  const vx = cropBox.x, vy = cropBox.y;
  const vw = Math.max(1, cropBox.w), vh = Math.max(1, cropBox.h);

  if (!$('#bg-trans').checked) {
    const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bgRect.setAttribute('x', vx);
    bgRect.setAttribute('y', vy);
    bgRect.setAttribute('width', vw);
    bgRect.setAttribute('height', vh);
    bgRect.setAttribute('fill', $('#bg-col').value);
    c.insertBefore(bgRect, c.firstChild);
  }

  c.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
  return c;
}

function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2500);
}

$('#svgx').onclick = () => {
  const c = exportClone();
  c.removeAttribute('style');
  const xml = new XMLSerializer().serializeToString(c);
  save(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }), 'mapa-seleccion.svg');
};

$('#png').onclick = async () => {
  const btn = $('#png');
  const origText = btn.textContent;
  try {
    btn.disabled = true;
    btn.textContent = 'Generando…';

    const c = exportClone();
    const vw = Math.max(1, cropBox.w);
    const vh = Math.max(1, cropBox.h);

    let W = Math.min(8000, Math.max(100, +$('#pxw').value || 2000));
    let H = Math.round(W * (vh / vw));

    // Limitar dimensiones máximas para no exceder la memoria del Canvas en mapas muy largos
    const MAX_DIM = 8192;
    if (H > MAX_DIM) {
      W = Math.max(1, Math.round(W * (MAX_DIM / H)));
      H = MAX_DIM;
    }

    c.setAttribute('width', W);
    c.setAttribute('height', H);
    c.removeAttribute('style');

    const svgStr = new XMLSerializer().serializeToString(c);
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Fallo al rasterizar el SVG en memoria'));
      img.src = url;
    });

    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, W, H);
    URL.revokeObjectURL(url);

    cv.toBlob(b => {
      if (b) save(b, 'mapa-seleccion.png');
      else toast('No se pudo generar el archivo PNG.');
    }, 'image/png');
  } catch (err) {
    console.error('Error exportando PNG:', err);
    toast('No se pudo exportar el PNG: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
};

function getCSVText() {
  return [...assign].sort((a, b) => a[0] - b[0]).map(([i, a]) => {
    const L = legends.find(l => l.id === a.lid);
    return uname(i) + '; ' + (L ? L.name : '') + '; ' + (a.v == null ? '' : a.v);
  }).join('\n');
}

$('#copy').onclick = async () => {
  const t = getCSVText();
  try {
    await navigator.clipboard.writeText(t);
    toast(assign.size ? 'Nombres copiados.' : 'No hay regiones seleccionadas.');
  } catch {
    toast('No se pudo copiar.');
  }
};

$('#dl-csv').onclick = () => {
  if (!assign.size) return toast('No hay regiones seleccionadas.');
  save(new Blob(['Región; Leyenda; Valor\n' + getCSVText()], { type: 'text/csv;charset=utf-8' }), 'regiones.csv');
};

// --- PANELES REDIMENSIONABLES ---
(function () {
  const app = document.querySelector('.app');
  const cfg = {
    rzl: { v: '--wl', min: 220, max: 520, dir: 1, def: 300 },
    rzr: { v: '--wr', min: 200, max: 480, dir: -1, def: 280 }
  };
  Object.entries(cfg).forEach(([id, c]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const cur = () => parseFloat(getComputedStyle(app).getPropertyValue(c.v)) || c.def;
    const set = w => {
      w = Math.max(c.min, Math.min(c.max, w));
      app.style.setProperty(c.v, w + 'px');
      layout();
      try { localStorage.setItem('w' + id, w); } catch {}
    };
    try { const s = +localStorage.getItem('w' + id); if (s) set(s); } catch {}
    el.onpointerdown = e => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('on');
      const x0 = e.clientX, w0 = cur();
      el.onpointermove = m => set(w0 + (m.clientX - x0) * c.dir);
      el.onpointerup = () => { el.classList.remove('on'); el.onpointermove = el.onpointerup = null; };
    };
    el.ondblclick = () => {
      app.style.removeProperty(c.v);
      try { localStorage.removeItem('w' + id); } catch {}
      layout();
    };
  });
})();

// --- CARGA AUTOMÁTICA DEL MAPA PREDETERMINADO ---
async function cargarMapaPorDefecto() {
  try {
    const res = await fetch('./chile-comunas.svg');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const svgText = await res.text();
    load(svgText);
  } catch (err) {
    console.warn('No se pudo precargar ./chile-comunas.svg:', err);
    // Con file:// el navegador bloquea fetch: avisar al usuario
    toast('No se pudo cargar el mapa por defecto. Usa un servidor local (p. ej. python -m http.server) o abre un SVG manualmente.');
  }
}

if ($('#btn-chile')) {
  $('#btn-chile').onclick = cargarMapaPorDefecto;
}

cargarMapaPorDefecto();
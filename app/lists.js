/* Listen, eigene Kategorien, Länder, Auswählen, Teilen als GPX und Import aus Google Maps.
 * Jeder Ort hat eine Liste (list) und eine Kategorie (cat). „Meine Orte“ sind die eigenen Einträge (runde Symbole),
 * alle anderen Listen sind Merklisten (eckige Symbole in der Listenfarbe). */
'use strict';

const LIST_COLORS = ['#7048E8', '#F2B705', '#2F9E44', '#1098AD', '#C2255C', '#E8590C', '#5C940D', '#1C7ED6', '#495057'];
const CAT_COLORS = ['#0C8599', '#2B8A3E', '#1C7ED6', '#7048E8', '#C2255C', '#E8590C', '#B35C00', '#F59F00', '#495057', '#868E96'];
const SYMBOLS = {
  pin: 'M12 21s6-5.4 6-10.5a6 6 0 0 0-12 0C6 15.6 12 21 12 21ZM12 10.5h.01',
  drone: 'M9 9h6v6H9ZM9 9 5 5M15 9l4-4M9 15l-4 4M15 15l4 4M3 5h4M17 5h4M3 19h4M17 19h4',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4ZM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  mountain: 'M3 20 9.5 8l3.5 6 2.5-4L21 20ZM9.5 8l1.6 2.9',
  waves: 'M3 16c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 10.5c2-2 4-2 6 0s4 2 6 0 4-2 6 0',
  beach: 'M12 3v2M5.2 8.2l1.4 1.4M18.8 8.2l-1.4 1.4M7.5 13a4.5 4.5 0 0 1 9 0M3 18c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0',
  columns: 'M3 9h18L12 4ZM5.5 9v9M10 9v9M14 9v9M18.5 9v9M3 20.5h18',
  city: 'M3 21V10l6-3v14M9 21V4l9 4.5V21M3 21h18M12.5 11h2M12.5 15h2',
  food: 'M7 3v8M5 3v4a2 2 0 0 0 4 0V3M7 11v10M17 3c-2.2 2-2.2 6.5 0 8.5V21',
  bed: 'M3 19V6M3 15h18v4M3 11h7v4M10 11h8a3 3 0 0 1 3 3v1',
  cart: 'M3 4h2l2.4 11h11L21 7H6.2M9 20h.01M17 20h.01',
  star: 'm12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z',
  tent: 'M2 20h20M4 20 12 5l8 15M12 20l-3-5M12 20l3-5',
  fire: 'M12 21a6 6 0 0 0 6-6c0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-2 2-3 5-3 8a6 6 0 0 0 6 6Z',
  tree: 'M12 21v-5M7 16h10L12 3Z',
  fish: 'M3 12c3-4 8-5 12-3l5-3v12l-5-3c-4 2-9 1-12-3ZM16 11h.01',
  bike: 'M6 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 15l4-7h5l3 7M10 8 8 5H6',
  car: 'M4 16v-4l2-5h12l2 5v4ZM4 16v2h3v-2M17 16v2h3v-2M7 12h.01M17 12h.01',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  warn: 'M12 4 2.5 20h19ZM12 10v4M12 17h.01',
  drop: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z',
  wrench: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4Z',
  bookmark: 'M7 3h10v18l-5-4-5 4Z'
};
const GPX_NS = 'https://pokaxhontas.github.io/overland-navi/gpx/1';
const svgPath = (d, cls = '') => `<svg viewBox="0 0 24 24" aria-hidden="true"${cls ? ` class="${cls}"` : ''}><path d="${d}"/></svg>`;

const Lists = {
  all: [],
  open: null,            // geöffnete Liste im Menü
  openCC: null,          // aufgeklapptes Land
  sel: { active: false, ids: new Set(), from: null },
  card: null,

  init() {
    const saved = store.get('lists', null);
    this.all = Array.isArray(saved) && saved.length ? saved : [];
    if (!this.all.some((l) => l.id === 'mine')) this.all.unshift({ id: 'mine', name: 'Meine Orte', color: '#5B6670', on: true, hidden: [] });
    for (const l of this.all) { if (!Array.isArray(l.hidden)) l.hidden = []; if (l.on === undefined) l.on = true; }
  },
  saveMeta() { store.set('lists', this.all); },
  get(id) { return this.all.find((l) => l.id === id) || this.all[0]; },
  isOwn(p) { return !p.list || p.list === 'mine'; },
  ensure(name, color) {
    const n = norm(name).trim();
    let l = this.all.find((x) => norm(x.name).trim() === n);
    if (!l) {
      l = { id: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, color: color || LIST_COLORS[(this.all.length - 1) % LIST_COLORS.length], on: true, hidden: [] };
      this.all.push(l);
      this.saveMeta();
    }
    return l.id;
  },

  /* ---------- sichtbar und Symbol ---------- */
  visible(p) {
    const l = this.get(p.list || 'mine');
    if (!l.on || settings.hidden.includes(p.cat)) return false;
    return !(l.hidden.length && l.hidden.includes(p.cc || '-'));
  },
  hiddenWhy(p) {
    const l = this.get(p.list || 'mine');
    if (p.lat === null || p.lat === undefined) return 'keine Position';
    if (!l.on) return `Liste „${l.name}“ ist ausgeblendet`;
    if (settings.hidden.includes(p.cat)) return `Kategorie „${(CAT[p.cat] || CAT.other).label}“ ist ausgeblendet`;
    if (l.hidden.length && l.hidden.includes(p.cc || '-')) return 'dieses Land ist in der Liste ausgeblendet';
    return '';
  },
  icon(p) { return this.isOwn(p) ? 'cat-' + p.cat : `sq-${p.list}-${p.cat}`; },
  sqImage(id) {
    const m = id.match(/^sq-(.+)-([^-]+)$/);
    const l = m ? this.get(m[1]) : null, c = CAT[m ? m[2] : 'other'] || CAT.other;
    const ratio = 2, size = 40;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size * ratio;
    const g = cv.getContext('2d');
    g.scale(ratio, ratio);
    const r = 9, a = 4, b = size - 4;
    g.beginPath();
    g.moveTo(a + r, a); g.arcTo(b, a, b, b, r); g.arcTo(b, b, a, b, r); g.arcTo(a, b, a, a, r); g.arcTo(a, a, b, a, r); g.closePath();
    g.fillStyle = l ? l.color : '#7048E8';
    g.fill();
    g.lineWidth = 2.5;
    g.strokeStyle = isDark() ? '#0B0F12' : '#FFFFFF';
    g.stroke();
    g.translate(size / 2 - 9.6, size / 2 - 9.6);
    g.scale(0.8, 0.8);
    g.strokeStyle = l && this.inkFor(l.color) === '#2A1E00' ? '#2A1E00' : '#FFFFFF';
    g.lineWidth = 2.6; g.lineCap = 'round'; g.lineJoin = 'round';
    g.stroke(new Path2D(c.d));
    return { image: g.getImageData(0, 0, size * ratio, size * ratio), ratio };
  },
  inkFor(hex) {
    const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return 0.299 * r + 0.587 * g + 0.114 * b > 165 ? '#2A1E00' : '#FFFFFF';
  },
  dropImages(match) {
    if (!map) return;
    try { for (const id of map.listImages()) if (match(id)) map.removeImage(id); } catch (e) { /* Karte noch nicht fertig */ }
  },
  refresh() {
    savePlaces();
    this.renderChips();
    if (this.open) this.renderListPage();
  },

  /* ---------- Länder ---------- */
  countryName(cc) {
    if (!cc || cc === '-') return 'Ohne Land';
    try { return new Intl.DisplayNames(['de'], { type: 'region' }).of(cc.toUpperCase()); } catch (e) { return cc.toUpperCase(); }
  },

  /* ---------- Schnellschalter: Knopf in der rechten Leiste, daneben ein kleines Fenster ----------
   * Nur zum schnellen Ein- und Ausblenden unterwegs; verwaltet werden Listen im Menü → Listen. */
  usedLists() { return this.all.filter((l) => places.some((p) => (p.list || 'mine') === l.id)); },
  renderChips() {
    const btn = $('#btn-lists');
    if (!btn) return;
    const used = this.usedLists();
    btn.hidden = used.length < 2;
    if (btn.hidden) { this.closeQuick(); return; }
    const g = $('#lq-grid');
    g.innerHTML = '';
    const show = used.length > 4 ? used.slice(0, 3) : used;
    for (const l of show) {
      const d = document.createElement('span');
      d.style.background = l.color;
      if (!l.on) d.className = 'off';
      g.appendChild(d);
    }
    if (used.length > 4) { const m = document.createElement('span'); m.className = 'more'; m.textContent = '+'; g.appendChild(m); }
    const n = used.filter((l) => l.on).length;
    btn.setAttribute('aria-label', `Listen auf der Karte: ${n} von ${used.length} sichtbar`);
    btn.classList.toggle('some-off', n < used.length);
    if (!$('#list-pop').hidden) this.renderQuick();
  },
  renderQuick() {
    const box = $('#lp-rows');
    box.innerHTML = '';
    for (const l of this.usedLists()) {
      const row = document.createElement('label');
      row.className = 'row lp-row';
      row.innerHTML = '<span class="lp-dot"></span><span><b></b></span><input type="checkbox" class="switch">';
      row.querySelector('.lp-dot').style.background = l.color;
      row.querySelector('b').textContent = l.name;
      const sw = row.querySelector('.switch');
      sw.checked = !!l.on;
      sw.onchange = () => { l.on = sw.checked; this.saveMeta(); this.refresh(); };
      box.appendChild(row);
    }
    $('#lp-all').hidden = this.usedLists().every((l) => l.on);
    this.placeQuick();
  },
  placeQuick() {
    const pop = $('#list-pop'), r = $('#btn-lists').getBoundingClientRect();
    const w = Math.min(270, r.left - 20);
    pop.style.width = w + 'px';
    pop.style.right = Math.round(innerWidth - r.left + 10) + 'px';
    const h = pop.offsetHeight;
    pop.style.top = Math.round(Math.max(12, Math.min(r.top, innerHeight - h - 16))) + 'px';
  },
  openQuick() {
    const pop = $('#list-pop');
    pop.hidden = false;
    $('#btn-lists').setAttribute('aria-expanded', 'true');
    this.renderQuick();
  },
  closeQuick() {
    const pop = $('#list-pop');
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    $('#btn-lists').setAttribute('aria-expanded', 'false');
  },
  setupQuick() {
    $('#list-chips').hidden = true;
    $('#btn-lists').onclick = () => ($('#list-pop').hidden ? this.openQuick() : this.closeQuick());
    $('#lp-close').onclick = () => this.closeQuick();
    $('#lp-all').onclick = () => { for (const l of this.usedLists()) l.on = true; this.saveMeta(); this.refresh(); };
    $('#lp-manage').onclick = () => { this.closeQuick(); $('#btn-layers').click(); Menu.open('listen'); };
    // woanders hintippen schließt das Fenster
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#list-pop, #btn-lists')) this.closeQuick(); }, true);
    addEventListener('resize', () => { if (!$('#list-pop').hidden) this.placeQuick(); });
  },

  /* ---------- Kärtchen beim Antippen eines Merklisten-Orts ---------- */
  showCard(p) {
    this.closeCard();
    const l = this.get(p.list), c = CAT[p.cat] || CAT.other;
    const el = document.createElement('div');
    el.className = 'pin-card panel';
    el.innerHTML = `<div class="pc-top"><span class="pi-icon sq" style="background:${l.color};color:${this.inkFor(l.color)}">${svgPath(c.d)}</span><span class="pc-txt"><b></b><small></small><p></p></span><button class="round pc-x" aria-label="Schließen">${svgPath('M6 6l12 12M18 6 6 18')}</button></div>
      <div class="pc-btns"><button class="btn primary pc-route">Route</button><button class="btn pc-edit">Bearbeiten</button><button class="btn pc-share">Teilen</button><a class="btn pc-google" target="_blank" rel="noopener">Google Maps</a></div>`;
    el.querySelector('b').textContent = p.name;
    el.querySelector('small').textContent = [c.label, l.name, p.cc ? this.countryName(p.cc) : ''].filter(Boolean).join(' · ');
    const note = el.querySelector('p');
    if (p.note) note.textContent = p.note.length > 160 ? p.note.slice(0, 160) + ' …' : p.note; else note.remove();
    el.querySelector('.pc-x').onclick = () => this.closeCard();
    el.querySelector('.pc-route').onclick = () => { this.closeCard(); closeSheet(); Nav.choose({ name: p.name, lat: p.lat, lon: p.lon }); };
    el.querySelector('.pc-edit').onclick = () => { this.closeCard(); openEditor(p); };
    el.querySelector('.pc-share').onclick = () => Sync.shareMenu([p], p.name, { type: 'items', ids: [p.id] });
    const g = el.querySelector('.pc-google');
    if (p.url) g.href = p.url; else g.href = `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`;
    document.body.appendChild(el);
    this.card = el;
    document.body.classList.add('card-open');
    if (typeof Swipe !== 'undefined' && Swipe.attach) { try { Swipe.attach(el, { dir: () => 'down', onDismiss: () => this.closeCard() }); } catch (e) { /* ohne Wischen */ } }
  },
  closeCard() { document.body.classList.toggle('card-open', !!(typeof Live !== 'undefined' && Live.card)); if (this.card) { this.card.remove(); this.card = null; } },

  /* ---------- Menü: Listen ---------- */
  stats(id) {
    const items = places.filter((p) => (p.list || 'mine') === id);
    const by = new Map();
    for (const p of items) by.set(p.cc || '-', (by.get(p.cc || '-') || 0) + 1);
    return { items, by };
  },
  renderLists() {
    const box = $('#list-list');
    if (!box) return;
    box.innerHTML = '';
    for (const l of this.all) {
      const { items, by } = this.stats(l.id);
      if (!items.length && l.id !== 'mine') { /* leere eigene Listen trotzdem zeigen */ }
      const row = document.createElement('div');
      row.className = 'cat-row' + (items.length ? '' : ' empty');
      const own = l.id === 'mine';
      row.innerHTML = `<button type="button" class="cat-open"><span class="pi-icon${own ? ' own' : ' sq'}" style="background:${l.color};color:${this.inkFor(l.color)}">${svgPath(own ? SYMBOLS.pin : SYMBOLS.bookmark)}</span><span class="pi-txt"><b></b><small></small></span>${svgPath('m9 5 7 7-7 7', 'chev')}</button><input type="checkbox" class="switch">`;
      row.querySelector('b').textContent = l.name;
      const hid = l.hidden.length;
      row.querySelector('small').textContent = (items.length ? `${items.length} ${items.length === 1 ? 'Ort' : 'Orte'} · ${by.size} ${by.size === 1 ? 'Land' : 'Länder'}` : 'leer') + (!l.on ? ' · ausgeblendet' : hid ? ` · ${hid} ${hid === 1 ? 'Land' : 'Länder'} aus` : '');
      row.querySelector('.cat-open').onclick = () => this.openList(l.id);
      const sw = row.querySelector('.switch');
      sw.checked = !!l.on;
      sw.setAttribute('aria-label', l.name + ' auf der Karte zeigen');
      sw.onchange = () => { l.on = sw.checked; this.saveMeta(); this.refresh(); };
      box.appendChild(own ? row : Swipe.row(row, { onDelete: () => Trash.listDel(l.id) }));
    }
  },
  openList(id) {
    this.open = id;
    this.openCC = null;
    this.endSel(true);
    const page = $('#list-page');
    page.hidden = false;
    page.querySelector('.sheet-body').scrollTop = 0;
    this.renderListPage();
  },
  closeList() { this.open = null; this.endSel(true); $('#list-page').hidden = true; },
  renderListPage() {
    const l = this.all.find((x) => x.id === this.open);
    if (!l) { this.closeList(); return; }
    const own = l.id === 'mine';
    const { items, by } = this.stats(l.id);
    const icon = $('#list-icon');
    icon.className = 'pi-icon' + (own ? ' own' : ' sq');
    icon.style.background = l.color;
    icon.style.color = this.inkFor(l.color);
    icon.innerHTML = svgPath(own ? SYMBOLS.pin : SYMBOLS.bookmark);
    $('#list-name').textContent = l.name;
    $('#list-count').textContent = items.length ? `${items.length} ${items.length === 1 ? 'Ort' : 'Orte'} in ${by.size} ${by.size === 1 ? 'Land' : 'Ländern'}` : 'Noch nichts in dieser Liste';
    const tg = $('#list-toggle');
    tg.checked = !!l.on;
    tg.onchange = () => { l.on = tg.checked; this.saveMeta(); this.refresh(); };
    $('#list-share').onclick = () => Sync.shareMenu(items, l.name, { type: 'lists', lists: [l.id] });
    $('#list-share').disabled = !items.length;
    $('#list-sel').textContent = this.sel.active ? 'Fertig' : 'Auswählen';
    $('#list-sel').onclick = () => (this.sel.active ? this.endSel() : this.startSel('list'));
    $('#list-edit').onclick = () => this.editList(l.id);
    const pend = items.filter((p) => !p.cc).length;
    $('#list-pend').hidden = !pend;
    $('#list-pend').textContent = pend ? `${pend} ${pend === 1 ? 'Ort hat' : 'Orte haben'} noch kein Land – das ordnet die App mit Internet von selbst zu.` : '';
    const box = $('#list-countries');
    box.innerHTML = '';
    const ccs = [...by.entries()].sort((a, b) => (a[0] === '-') - (b[0] === '-') || this.countryName(a[0]).localeCompare(this.countryName(b[0]), 'de'));
    for (const [cc, n] of ccs) {
      const row = document.createElement('div');
      row.className = 'cat-row';
      const open = this.openCC === cc;
      row.innerHTML = `<button type="button" class="cat-open"><span class="cc-badge"></span><span class="pi-txt"><b></b><small></small></span>${svgPath('m9 5 7 7-7 7', 'chev' + (open ? ' down' : ''))}</button><input type="checkbox" class="switch">`;
      row.querySelector('.cc-badge').textContent = cc === '-' ? '?' : cc.toUpperCase();
      row.querySelector('b').textContent = this.countryName(cc);
      row.querySelector('small').textContent = n + (n === 1 ? ' Ort' : ' Orte') + (l.hidden.includes(cc) ? ' · ausgeblendet' : '');
      const sw = row.querySelector('.switch');
      sw.checked = !l.hidden.includes(cc);
      sw.setAttribute('aria-label', this.countryName(cc) + ' auf der Karte zeigen');
      sw.onchange = () => {
        const h = new Set(l.hidden);
        if (sw.checked) h.delete(cc); else h.add(cc);
        l.hidden = [...h];
        this.saveMeta();
        this.refresh();
      };
      row.querySelector('.cat-open').onclick = () => { this.openCC = open ? null : cc; this.renderListPage(); };
      box.appendChild(row);
      if (open) {
        const inCC = items.filter((p) => (p.cc || '-') === cc).sort((a, b) => a.name.localeCompare(b.name, 'de'));
        const bar = document.createElement('div');
        bar.className = 'cc-tools';
        bar.innerHTML = '<button type="button" class="link-btn cc-share"></button><button type="button" class="link-btn cc-all"></button>';
        bar.querySelector('.cc-share').textContent = this.countryName(cc) + ' teilen';
        bar.querySelector('.cc-share').onclick = () => Sync.shareMenu(inCC, `${l.name} – ${this.countryName(cc)}`, { type: 'countries', countries: [[l.id, cc]] });
        const allBtn = bar.querySelector('.cc-all');
        if (this.sel.active) {
          allBtn.textContent = 'Alle hier auswählen';
          allBtn.onclick = () => { for (const p of inCC) this.sel.ids.add(p.id); this.renderListPage(); this.renderSelBar(); };
        } else allBtn.remove();
        box.appendChild(bar);
        const list = document.createElement('div');
        list.className = 'place-list sub';
        for (const p of inCC) list.appendChild(this.swipeItem(p));
        box.appendChild(list);
      }
    }
  },
  /* eine Zeile für einen Ort (in Listen- und Kategorieseite), mit Haken im Auswahlmodus */
  itemRow(p) {
    const l = this.get(p.list || 'mine'), c = CAT[p.cat] || CAT.other, own = this.isOwn(p);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'place-item' + (this.sel.active ? ' selectable' : '') + (this.sel.ids.has(p.id) ? ' selected' : '');
    const ic = own ? `<span class="pi-icon own" style="background:${c.color};color:${c.ink}">${svgPath(c.d)}</span>` : `<span class="pi-icon sq" style="background:${l.color};color:${this.inkFor(l.color)}">${svgPath(c.d)}</span>`;
    b.innerHTML = (this.sel.active ? `<span class="sel-box" aria-hidden="true">${svgPath('m5 12 5 5 9-10')}</span>` : '') + ic + '<span class="pi-txt"><b></b><small></small></span>';
    b.querySelector('b').textContent = p.name;
    b.querySelector('small').textContent = [c.label, own ? '' : l.name, p.note ? p.note.slice(0, 50) : ''].filter(Boolean).join(' · ') || ' ';
    // in der Liste, aber nicht auf der Karte: sagen, warum
    const why = this.hiddenWhy(p);
    if (why) {
      b.classList.add('off-map');
      const w = document.createElement('em');
      w.className = 'pi-why';
      w.textContent = 'Nicht auf der Karte: ' + why;
      b.querySelector('.pi-txt').appendChild(w);
    }
    b.setAttribute('aria-pressed', this.sel.active ? String(this.sel.ids.has(p.id)) : 'false');
    b.onclick = () => {
      if (this.sel.active) { this.toggleSel(p.id); b.classList.toggle('selected', this.sel.ids.has(p.id)); b.setAttribute('aria-pressed', String(this.sel.ids.has(p.id))); return; }
      closeSheet();
      gps.follow = false;
      $('#btn-locate').classList.remove('active');
      map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 13) });
      if (own) openEditor(p); else this.showCard(p);
    };
    return b;
  },

  /* Ort-Zeile mit Wischen nach links zum Löschen (nicht im Auswahlmodus) */
  swipeItem(p, row) {
    return Swipe.row(row || this.itemRow(p), { onDelete: () => Trash.places([p]), enabled: () => !this.sel.active });
  },

  /* ---------- Auswählen und Sammelaktionen ---------- */
  startSel(from) {
    document.body.classList.add('selecting');
    this.sel = { active: true, ids: new Set(), from };
    this.rerenderPages();
    this.renderSelBar();
  },
  endSel(quiet) {
    document.body.classList.remove('selecting');
    const was = this.sel.active;
    this.sel = { active: false, ids: new Set(), from: null };
    $('#sel-bar').hidden = true;
    if (was && !quiet) this.rerenderPages();
  },
  toggleSel(id) {
    if (this.sel.ids.has(id)) this.sel.ids.delete(id); else this.sel.ids.add(id);
    this.renderSelBar();
  },
  rerenderPages() {
    if (this.open) this.renderListPage();
    if (typeof refreshCatPage === 'function') refreshCatPage();
  },
  selected() { return places.filter((p) => this.sel.ids.has(p.id)); },
  renderSelBar() {
    const bar = $('#sel-bar');
    bar.hidden = !this.sel.active;
    const n = this.sel.ids.size;
    $('#sel-count').textContent = n ? `${n} ausgewählt` : 'Orte antippen zum Auswählen';
    for (const b of bar.querySelectorAll('button[data-act]')) b.disabled = !n;
  },
  async selAction(act) {
    const items = this.selected();
    if (!items.length) return;
    if (act === 'share') { Sync.shareMenu(items, `${items.length} Orte`, { type: 'items', ids: items.map((p) => p.id) }); return; }
    if (act === 'cat') {
      const id = await this.choose('Kategorie ändern', [...CATS.map((c) => ({ id: c.id, label: c.label, color: c.color, ink: c.ink, d: c.d })), { id: '+', label: 'Neue Kategorie …', d: 'M12 5v14M5 12h14' }]);
      if (!id) return;
      const cat = id === '+' ? await this.editCat(null) : id;
      if (!cat) return;
      for (const p of items) { p.cat = cat; p.auto = false; p.updated = new Date().toISOString(); }
      toast(`${items.length} Orte jetzt in „${CAT[cat].label}“`);
    }
    if (act === 'list') {
      const id = await this.choose('In Liste verschieben', [...this.all.map((l) => ({ id: l.id, label: l.name, color: l.color, ink: this.inkFor(l.color), d: l.id === 'mine' ? SYMBOLS.pin : SYMBOLS.bookmark, sq: l.id !== 'mine' })), { id: '+', label: 'Neue Liste …', d: 'M12 5v14M5 12h14' }]);
      if (!id) return;
      const list = id === '+' ? await this.editList(null) : id;
      if (!list) return;
      for (const p of items) { p.list = list; p.updated = new Date().toISOString(); }
      toast(`${items.length} Orte jetzt in „${this.get(list).name}“`);
    }
    if (act === 'del') {
      const b = $('#sel-del');
      if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = `${items.length} wirklich löschen?`; setTimeout(() => { delete b.dataset.sure; b.textContent = 'Löschen'; }, 4000); return; }
      delete b.dataset.sure; b.textContent = 'Löschen';
      this.endSel(true);
      Trash.places(items);
      return;
    }
    this.endSel(true);
    this.refresh();
    this.rerenderPages();
  },

  /* ---------- Auswahl-Fenster (Liste oder Kategorie wählen) ---------- */
  choose(title, options) {
    return new Promise((resolve) => {
      const page = $('#choose-page');
      $('#choose-title').textContent = title;
      const box = $('#choose-items');
      box.innerHTML = '';
      const done = (v) => { page.hidden = true; $('#dlg').hidden = true; resolve(v); };
      for (const o of options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'place-item';
        b.innerHTML = `<span class="pi-icon${o.sq ? ' sq' : ''}" style="background:${o.color || 'var(--faint)'};color:${o.ink || 'var(--text)'}">${svgPath(o.d)}</span><span class="pi-txt"><b></b></span>`;
        b.querySelector('b').textContent = o.label;
        b.onclick = () => done(o.id);
        box.appendChild(b);
      }
      $('#choose-back').onclick = () => done(null);
      $('#dlg').hidden = false;
      page.hidden = false;
      page.querySelector('.sheet-body').scrollTop = 0;
    });
  },

  /* ---------- Kategorie oder Liste anlegen/bearbeiten ---------- */
  editCat(id) { return this.editThing('cat', id); },
  editList(id) { return this.editThing('list', id); },
  editThing(kind, id) {
    return new Promise((resolve) => {
      const page = $('#thing-page');
      const isCat = kind === 'cat';
      const cur = isCat ? (id ? CAT[id] : null) : (id ? this.get(id) : null);
      const builtin = isCat ? cur && !cur.custom : id === 'mine';
      const st = { name: cur ? (isCat ? cur.label : cur.name) : '', color: cur ? cur.color : (isCat ? CAT_COLORS[0] : LIST_COLORS[(this.all.length - 1) % LIST_COLORS.length]), d: cur && isCat ? cur.d : SYMBOLS.pin };
      $('#thing-title').textContent = isCat ? (id ? 'Kategorie bearbeiten' : 'Neue Kategorie') : (id ? 'Liste bearbeiten' : 'Neue Liste');
      const name = $('#thing-name');
      name.value = st.name;
      name.disabled = isCat && builtin;
      $('#thing-sym-h').hidden = !isCat || builtin;
      $('#thing-syms').hidden = !isCat || builtin;
      const colors = $('#thing-colors');
      const paint = () => {
        colors.innerHTML = '';
        for (const c of isCat ? CAT_COLORS : LIST_COLORS) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'swatch' + (c === st.color ? ' on' : '');
          b.style.background = c;
          b.setAttribute('aria-label', 'Farbe ' + c);
          b.setAttribute('aria-pressed', String(c === st.color));
          b.onclick = () => { st.color = c; paint(); };
          colors.appendChild(b);
        }
        const syms = $('#thing-syms');
        syms.innerHTML = '';
        if (isCat && !builtin) {
          for (const [k, d] of Object.entries(SYMBOLS)) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'sym' + (d === st.d ? ' on' : '');
            b.setAttribute('aria-label', 'Symbol ' + k);
            b.setAttribute('aria-pressed', String(d === st.d));
            b.innerHTML = svgPath(d);
            if (d === st.d) { b.style.borderColor = st.color; b.style.color = st.color; }
            b.onclick = () => { st.d = d; paint(); };
            syms.appendChild(b);
          }
        }
        const prev = $('#thing-preview');
        const ink = isCat ? this.inkFor(st.color) : this.inkFor(st.color);
        prev.innerHTML = isCat
          ? `<span class="pi-icon own" style="background:${st.color};color:${ink}">${svgPath(st.d)}</span><small>als eigener Ort</small><span class="pi-icon sq" style="background:#7048E8;color:#fff">${svgPath(st.d)}</span><small>in einer Merkliste</small>`
          : `<span class="pi-icon sq" style="background:${st.color};color:${ink}">${svgPath(SYMBOLS.bookmark)}</span><small>so erscheinen die Orte dieser Liste</small>`;
      };
      paint();
      const del = $('#thing-del');
      del.hidden = !id || builtin;
      del.textContent = isCat ? 'Kategorie löschen' : 'Liste löschen';
      delete del.dataset.sure;
      const done = (v) => { page.hidden = true; $('#dlg').hidden = true; resolve(v); };
      del.onclick = () => {
        const n = isCat ? places.filter((p) => p.cat === id).length : places.filter((p) => p.list === id).length;
        if (!del.dataset.sure) {
          del.dataset.sure = '1';
          del.textContent = isCat ? `Löschen? ${n} Orte kommen nach „Sonstiges“` : `Löschen? Die ${n} Orte darin kommen mit in den Papierkorb`;
          return;
        }
        // in den Papierkorb, lässt sich zurückholen
        if (isCat) Trash.catDel(id); else Trash.listDel(id);
        this.refresh();
        renderDataCats();
        if (isCat && openCat === id) closeCatPage();
        done(null);
      };
      $('#thing-back').onclick = () => done(null);
      $('#thing-save').onclick = () => {
        const nm = name.value.trim();
        if (!nm && !builtin) { name.focus(); toast('Bitte einen Namen eingeben.'); return; }
        let out = id;
        if (isCat) {
          const list = customCats();
          if (builtin) {
            const over = store.get('catColors', {});
            over[id] = st.color;
            store.set('catColors', over);
            applyCatColors();
          } else if (id) {
            const c = list.find((x) => x.id === id);
            Object.assign(c, { label: nm, color: st.color, d: st.d, ink: this.inkFor(st.color) });
            setCustomCats(list);
          } else {
            out = 'c' + Date.now().toString(36);
            list.push({ id: out, label: nm, color: st.color, ink: this.inkFor(st.color), d: st.d, custom: true });
            setCustomCats(list);
          }
          this.dropImages((x) => x === 'cat-' + out || x.endsWith('-' + out));
        } else if (id) {
          const l = this.get(id);
          if (!builtin) l.name = nm;
          l.color = st.color;
          this.saveMeta();
          this.dropImages((x) => x.startsWith('sq-' + id + '-'));
        } else {
          out = this.ensure(nm, st.color);
        }
        this.refresh();
        renderDataCats();
        if (this.open) this.renderListPage();
        if (typeof refreshCatPage === 'function') refreshCatPage();
        done(out);
      };
      $('#dlg').hidden = false;
      page.hidden = false;
      page.querySelector('.sheet-body').scrollTop = 0;
    });
  },

  /* ---------- Teilen als GPX ---------- */
  gpx(items, trks) {
    const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const wpts = items.map((p) => {
      const c = CAT[p.cat] || CAT.other, l = this.get(p.list || 'mine');
      const feats = (p.feats || []).map((f) => (FEATS.find((x) => x[0] === f) || [f, f])[1]);
      const desc = [p.rating ? p.rating + '/5 Sterne' : '', feats.join(', '), p.note].filter(Boolean).join('\n');
      const ext = `<extensions><ovl:list>${esc(l.name)}</ovl:list><ovl:listColor>${l.color}</ovl:listColor><ovl:cat>${esc(c.id)}</ovl:cat><ovl:catLabel>${esc(c.label)}</ovl:catLabel>` +
        (c.custom ? `<ovl:catColor>${c.color}</ovl:catColor><ovl:catIcon>${esc(c.d)}</ovl:catIcon>` : '') +
        (p.cc ? `<ovl:cc>${p.cc}</ovl:cc>` : '') + (p.url ? `<ovl:url>${esc(p.url)}</ovl:url>` : '') +
        (p.rating ? `<ovl:rating>${p.rating}</ovl:rating>` : '') + ((p.feats || []).length ? `<ovl:feats>${esc(p.feats.join(','))}</ovl:feats>` : '') +
        (p.auto ? '<ovl:auto>1</ovl:auto>' : '') + (p.note ? `<ovl:note>${esc(p.note)}</ovl:note>` : '') + '</extensions>';
      return `  <wpt lat="${p.lat}" lon="${p.lon}">${p.ele ? `<ele>${p.ele}</ele>` : ''}${p.time ? `<time>${p.time}</time>` : ''}<name>${esc(p.name)}</name>${desc ? `<desc>${esc(desc)}</desc>` : ''}${p.url ? `<link href="${esc(p.url)}"/>` : ''}<type>${esc(c.label)}</type>${ext}</wpt>`;
    }).join('\n');
    const tr = (trks || []).map((t) => `  <trk><name>${esc(t.name)}</name>${t.note ? `<desc>${esc(t.note)}</desc>` : ''}${t.segments.map((seg) => '<trkseg>' + seg.map((c) => `<trkpt lat="${c[1]}" lon="${c[0]}">${typeof c[2] === 'number' ? `<ele>${Math.round(c[2])}</ele>` : ''}</trkpt>`).join('') + '</trkseg>').join('')}</trk>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Overland-Navi" xmlns="http://www.topografix.com/GPX/1/1" xmlns:ovl="${GPX_NS}">\n${wpts}\n${tr}\n</gpx>\n`;
  },
  fileName(title) {
    const s = String(title || 'orte').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    return (s || 'orte') + '.gpx';
  },
  share(items, title, trks) {
    if (!items.length && !(trks || []).length) { toast('Da ist nichts zum Teilen.'); return; }
    const file = new File([this.gpx(items, trks)], this.fileName(title), { type: 'application/gpx+xml' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: title || 'Orte' }).catch(() => {});
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  },
  /* Zusatzangaben aus einer GPX-Datei dieser App (Liste, Kategorie, Land …) */
  readExt(w) {
    const get = (tag) => { const n = w.getElementsByTagNameNS(GPX_NS, tag)[0] || w.getElementsByTagName('ovl:' + tag)[0]; return n ? n.textContent.trim() : ''; };
    const list = get('list');
    if (!list && !get('cat')) return null;
    return { list, listColor: get('listColor'), cat: get('cat'), catLabel: get('catLabel'), catColor: get('catColor'), catIcon: get('catIcon'), cc: get('cc'), url: get('url'), rating: +get('rating') || 0, feats: get('feats') ? get('feats').split(',') : [], auto: get('auto') === '1', note: get('note') };
  },
  /* Kategorie aus einer fremden Datei: bekannte nehmen, sonst eigene Kategorie anlegen */
  catFromExt(x) {
    if (x.cat && CAT[x.cat] && (!CAT[x.cat].custom || norm(CAT[x.cat].label) === norm(x.catLabel || CAT[x.cat].label))) return x.cat;
    const byLabel = CATS.find((c) => norm(c.label) === norm(x.catLabel || ''));
    if (byLabel) return byLabel.id;
    if (!x.catLabel) return null;
    const list = customCats();
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
    const color = /^#[0-9a-f]{6}$/i.test(x.catColor) ? x.catColor : CAT_COLORS[list.length % CAT_COLORS.length];
    list.push({ id, label: x.catLabel, color, ink: this.inkFor(color), d: /^[MmLlHhVvCcSsQqTtAaZz0-9 .,\-]+$/.test(x.catIcon || '') ? x.catIcon : SYMBOLS.pin, custom: true });
    setCustomCats(list);
    return id;
  },

  /* ---------- Google Maps (Takeout) ---------- */
  s2(hex) {
    if (!Lists._lut) {
      const L = new Array(1024), SW = 1, INV = 2;
      const P2IJ = [[0, 1, 3, 2], [0, 2, 3, 1], [3, 2, 0, 1], [3, 1, 0, 2]], P2O = [SW, 0, 0, INV | SW];
      const init = (lv, i, j, orig, pos, or) => {
        if (lv === 4) { L[(pos << 2) + orig] = (((i << 4) + j) << 2) + or; return; }
        lv++; i <<= 1; j <<= 1; pos <<= 2;
        const r = P2IJ[or];
        for (let k = 0; k < 4; k++) init(lv, i + (r[k] >> 1), j + (r[k] & 1), orig, pos + k, or ^ P2O[k]);
      };
      for (let o = 0; o < 4; o++) init(0, 0, 0, o, 0, o);
      Lists._lut = L;
    }
    const id = BigInt('0x' + hex);
    const face = Number(id >> 61n);
    let bits = face & 1, i = 0, j = 0;
    for (let k = 7; k >= 0; k--) {
      const nb = k === 7 ? 2 : 4;
      bits += Number((id >> BigInt(k * 8 + 1)) & ((1n << BigInt(2 * nb)) - 1n)) << 2;
      bits = Lists._lut[bits];
      i += (bits >> 6) * 2 ** (k * 4);
      j += ((bits >> 2) & 15) * 2 ** (k * 4);
      bits &= 3;
    }
    const st = (v) => (v >= 0.5 ? (4 * v * v - 1) / 3 : (1 - 4 * (1 - v) * (1 - v)) / 3);
    const u = st((2 * i + 1) / 2 ** 31), v = st((2 * j + 1) / 2 ** 31);
    const [x, y, z] = [[1, u, v], [-u, 1, v], [-u, -v, 1], [-1, -v, -u], [v, -1, -u], [v, u, -1]][face];
    return { lat: Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI, lon: Math.atan2(y, x) * 180 / Math.PI };
  },
  coordsFromUrl(url) {
    if (!url) return null;
    let dec = url;
    try { dec = decodeURIComponent(url); } catch (e) { /* so lassen */ }
    let m = dec.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || dec.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ||
      dec.match(/\/maps\/search\/(-?\d+\.\d+),\s*(-?\d+\.\d+)/) || dec.match(/[?&]q=(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
    if (m) return { lat: +m[1], lon: +m[2] };
    m = dec.match(/!1s0x([0-9a-f]{6,16}):0x[0-9a-f]+/i);
    if (m && !/^0+$/.test(m[1])) { try { return this.s2(m[1].padStart(16, '0')); } catch (e) { return null; } }
    return null;
  },
  googleId(url) { const m = (url || '').match(/0x[0-9a-f]+:0x[0-9a-f]+/i) || (url || '').match(/cid=(\d+)/); return m ? m[0] : ''; },
  parseCsv(text) {
    const rows = [];
    let row = [], f = '', q = false;
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      if (q) { if (ch === '"') { if (text[k + 1] === '"') { f += '"'; k++; } else q = false; } else f += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[k + 1] === '\n') k++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += ch;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    return rows;
  },
  takeoutName(file) {
    const base = file.split('/').pop().replace(/\.(csv|json)$/i, '').replace(/#U([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    const ren = { 'wunschziele': 'Reiseplanung', 'möchte ich hin': 'Reiseplanung', 'want to go': 'Reiseplanung', 'gespeicherte orte': 'Favoriten', 'favorites': 'Favoriten', 'favoriten': 'Favoriten', 'starred places': 'Markierte Orte' };
    return ren[base.toLowerCase()] || base;
  },
  /* liest Google-Listen (CSV aus „Gespeichert“, JSON aus „Maps (Meine Orte)“) → { Liste: [Orte] } */
  async readTakeout(files) {
    const out = {};
    for (const f of files) {
      const n = f.name.toLowerCase();
      if (!/\.(csv|json)$/.test(n)) continue;
      const text = (await f.text()).replace(/^﻿/, '');
      const items = [];
      if (n.endsWith('.csv')) {
        const rows = this.parseCsv(text);
        const head = (rows[0] || []).map((h) => h.trim().toLowerCase());
        const iT = head.findIndex((h) => h === 'titel' || h === 'title'), iN = head.findIndex((h) => h === 'notiz' || h === 'note'), iU = head.indexOf('url');
        if (iT < 0 || iU < 0) continue;
        for (const r of rows.slice(1)) {
          const url = (r[iU] || '').trim();
          if (!/google\.[a-z.]+\/maps|maps\.google|goo\.gl\/maps|maps\.app\.goo/.test(url)) continue;
          let name = (r[iT] || '').trim();
          if (/^gesetzte markierung$|^dropped pin$|^\d+°/i.test(name)) name = '';
          const c = this.coordsFromUrl(url);
          if (!c && !name) continue;
          items.push({ name, note: ((iN >= 0 ? r[iN] : '') || '').trim(), lat: c ? +c.lat.toFixed(6) : null, lon: c ? +c.lon.toFixed(6) : null, url });
        }
      } else if (/gespeicherte orte|saved places/.test(n)) {
        let j;
        try { j = JSON.parse(text); } catch (e) { continue; }
        for (const ft of j.features || []) {
          const p = ft.properties || {}, loc = p.location || p.Location || {};
          const g = ft.geometry && ft.geometry.coordinates;
          let c = g && (g[0] || g[1]) ? { lon: g[0], lat: g[1] } : null;
          const url = p.google_maps_url || p['Google Maps URL'] || '';
          if (!c) c = this.coordsFromUrl(url);
          if (!c) continue;
          items.push({ name: loc.name || loc['Business Name'] || p.Title || '', note: '', lat: +(+c.lat).toFixed(6), lon: +(+c.lon).toFixed(6), url, cc: (loc.country_code || '').toLowerCase() });
        }
      } else continue;
      if (items.length) {
        const name = /gespeicherte orte|saved places/.test(n) && n.endsWith('.json') ? 'Markierte Orte' : this.takeoutName(f.name);
        out[name] = (out[name] || []).concat(items);
      }
    }
    return out;
  },
  async offerTakeout(files) {
    const lists = await this.readTakeout(files);
    const names = Object.keys(lists);
    if (!names.length) return false;
    this.pendingImport = lists;
    const box = $('#imp-lists');
    box.innerHTML = '';
    const on = /^(reiseplanung|favoriten|reiseziele|reisepläne)$/i;
    for (const name of names.sort((a, b) => lists[b].length - lists[a].length)) {
      const row = document.createElement('div');
      row.className = 'imp-row';
      row.innerHTML = '<input type="checkbox" class="switch"><span class="imp-txt"><input type="text" class="imp-name" aria-label="Name der Liste in der App"><small></small></span>';
      row.querySelector('.imp-name').value = name;
      row.querySelector('.imp-name').dataset.orig = name;
      row.querySelector('small').textContent = `${lists[name].length} ${lists[name].length === 1 ? 'Ort' : 'Orte'} · landet in der Liste oben (Name änderbar, gleicher Name = zusammengelegt)`;
      row.querySelector('.switch').checked = on.test(name);
      row.querySelector('.switch').setAttribute('aria-label', name + ' übernehmen');
      box.appendChild(row);
    }
    $('#sheet').hidden = false;
    $('#imp-page').hidden = false;
    $('#imp-page .sheet-body').scrollTop = 0;
    return true;
  },
  confirmTakeout() {
    const lists = this.pendingImport;
    if (!lists) return;
    const rows = [...$('#imp-lists').children].filter((r) => r.querySelector('.switch').checked);
    const res = { added: 0, dupes: 0 };
    const bounds = new maplibregl.LngLatBounds();
    for (const row of rows) {
      const orig = row.querySelector('.imp-name').dataset.orig;
      const name = row.querySelector('.imp-name').value.trim() || orig;
      const listId = this.ensure(name);
      for (const it of lists[orig]) {
        if (this.addPlace({ ...it, list: listId, cat: guessFromName(it.name) || 'other', auto: true, pend: true }, res)) if (it.lat !== null) bounds.extend([it.lon, it.lat]);
      }
    }
    this.pendingImport = null;
    $('#imp-page').hidden = true;
    this.refresh();
    renderDataCats();
    toast(`${res.added} Orte übernommen${res.dupes ? ` · ${res.dupes} schon vorhanden` : ''}. Kategorie und Land werden jetzt zugeordnet …`, 6000);
    if (!bounds.isEmpty()) { closeSheet(); gps.follow = false; $('#btn-locate').classList.remove('active'); map.fitBounds(bounds, { padding: 60, maxZoom: 7 }); }
    this.enrich();
  },
  /* fügt einen Ort hinzu, wenn er nicht schon in derselben Liste ist */
  addPlace(it, res) {
    const gid = this.googleId(it.url);
    const same = places.find((p) => (p.list || 'mine') === it.list && ((gid && this.googleId(p.url) === gid) ||
      (it.lat !== null && p.lat !== null && distance(p, it) < 25 && (!it.name || norm(p.name) === norm(it.name))) ||
      (it.lat === null && p.lat === null && it.name && norm(p.name) === norm(it.name))));
    if (same) { res.dupes++; return false; }
    const now = new Date().toISOString();
    const cat = CAT[it.cat] ? it.cat : 'other';
    places.push({
      id: Date.now() * 1000 + Math.floor(Math.random() * 1000), name: it.name || `${CAT[cat].label} ${places.length + 1}`, cat, list: it.list,
      rating: it.rating || 0, feats: it.feats || [], note: it.note || '', photos: [], lat: it.lat, lon: it.lon, ele: it.ele || null,
      time: it.time || now, updated: now, url: it.url || '', cc: (it.cc || '').toLowerCase(), auto: !!it.auto, pend: it.pend !== undefined ? !!it.pend : (it.lat === null || !it.cc), source: it.source || ''
    });
    res.added++;
    return true;
  },

  /* ---------- Land und (bei Importen) Kategorie zuordnen, einmalig mit Internet ---------- */
  osmCat(key, v) {
    v = v || '';
    if (key === 'place') return 'ort';
    if (key === 'boundary') return /national_park|protected_area/.test(v) ? 'natur' : 'ort';
    if (key === 'natural') {
      if (/beach|coastline|cape|bay|sand/.test(v)) return 'strand';
      if (/spring/.test(v)) return 'water';
      if (/water|lake|wetland/.test(v)) return 'gewaesser';
      return 'natur';
    }
    if (key === 'waterway' || key === 'water') return 'gewaesser';
    if (key === 'mountain_pass' || (key === 'highway' && v === 'mountain_pass')) return 'natur';
    if (key === 'leisure') return /nature_reserve|park|garden/.test(v) ? 'natur' : /beach_resort|marina/.test(v) ? 'strand' : '';
    if (key === 'tourism') {
      if (/viewpoint/.test(v)) return 'natur';
      if (/camp_site|caravan_site/.test(v)) return 'camp';
      if (/hotel|hostel|guest_house|motel|chalet|alpine_hut|wilderness_hut|apartment/.test(v)) return 'unterkunft';
      return 'kultur';
    }
    if (key === 'historic' || key === 'heritage') return 'kultur';
    if (key === 'man_made' && /tower|lighthouse|bridge|observatory/.test(v)) return 'kultur';
    if (key === 'amenity') {
      if (/restaurant|cafe|bar|pub|fast_food|biergarten|food_court|ice_cream/.test(v)) return 'essen';
      if (/place_of_worship|monastery|theatre|arts_centre/.test(v)) return 'kultur';
      if (/fuel/.test(v)) return 'fuel';
      if (/car_repair/.test(v)) return 'mech';
      if (/drinking_water|water_point/.test(v)) return 'water';
      if (/marketplace|bank|atm|pharmacy|doctors|dentist|hospital|post_office|car_wash/.test(v)) return 'einkauf';
      if (/shelter/.test(v)) return 'unterkunft';
      return '';
    }
    if (key === 'shop' && /car_repair|tyres|car_parts/.test(v)) return 'mech';
    if (key === 'shop' || key === 'craft' || key === 'office') return 'einkauf';
    return '';
  },
  /* Land aus der Position bestimmen – sofort und ohne Internet (Ländergrenzen sind in der App) */
  async countryCoder() {
    if (typeof countryCoder === 'undefined') { try { await loadScript('vendor/country-coder.js'); } catch (e) { return null; } }
    return typeof countryCoder !== 'undefined' ? countryCoder : null;
  },
  async localCountries() {
    const need = places.filter((p) => !p.cc && p.lat !== null && p.lat !== undefined);
    if (!need.length) return 0;
    const cc = await this.countryCoder();
    if (!cc) return 0;
    const now = new Date().toISOString();
    let k = 0;
    for (const p of need) {
      let c = null;
      try { c = cc.iso1A2Code([p.lon, p.lat]); } catch (e) { /* egal */ }
      if (c) { p.cc = c.toLowerCase(); p.updated = now; k++; }   // „updated“: damit die Zuordnung auch zu den anderen Geräten geht
    }
    if (k) { savePlaces(); this.refresh(); renderDataCats(); }
    return k;
  },
  async enrich() {
    if (this.running) return;
    this.running = true;
    try { await this.localCountries(); } catch (e) { /* weiter online */ }
    this.running = false;
    if (!navigator.onLine) return;
    const todo = places.filter((p) => p.pend || (!p.cc && p.lat !== null && p.lat !== undefined));
    if (!todo.length) return;
    this.running = true;
    const get = typeof originalFetch === 'function' ? originalFetch : fetch;
    const json = async (url) => { const r = await get(url); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
    let n = 0, fails = 0;
    const work = async (p) => {
      try {
        let key = '', val = '', cc = p.cc || '';
        const wantCat = p.auto && p.pend;
        if ((wantCat || p.lat === null) && p.name) {
          const bias = p.lat !== null ? `&lat=${p.lat}&lon=${p.lon}` : '';
          const j = await json(`https://photon.komoot.io/api/?q=${encodeURIComponent(p.name)}${bias}&limit=4&lang=de`);
          let best = null, bd = Infinity;
          for (const f of j.features || []) {
            const [lon, lat] = f.geometry.coordinates;
            const d = p.lat !== null ? distance(p, { lat, lon }) : 0;
            const big = /place|boundary|natural|waterway|leisure/.test(f.properties.osm_key);
            if ((p.lat === null || d < (big ? 25000 : 2500)) && d < bd) { bd = d; best = f; }
            if (p.lat === null) break;
          }
          if (best) {
            key = best.properties.osm_key; val = best.properties.osm_value;
            cc = cc || (best.properties.countrycode || '').toLowerCase();
            if (p.lat === null) { p.lon = +best.geometry.coordinates[0].toFixed(6); p.lat = +best.geometry.coordinates[1].toFixed(6); }
          }
        }
        if (!cc && p.lat !== null) {
          const j = await json(`https://photon.komoot.io/reverse?lat=${p.lat}&lon=${p.lon}&lang=de&limit=1`);
          const f = (j.features || [])[0];
          cc = f ? (f.properties.countrycode || '').toLowerCase() : '';
        }
        if (p.lat === null) { fails++; p.pend = false; n++; return; }
        p.cc = cc;
        if (wantCat) { const c = this.osmCat(key, val); if (c && CAT[c]) p.cat = c; }
        p.pend = false;
        p.updated = new Date().toISOString();
        streak = 0;
      } catch (e) {
        fails++;
        // Server bremst oder Netz weg: kurz warten, den Ort später nochmal versuchen
        if (++streak >= 4) { pause = Date.now() + 30000; streak = 0; }
      }
      n++;
      show();
      if (n % 10 === 0) savePlaces();
    };
    let streak = 0, pause = 0;
    const pill = $('#enrich-pill');
    const show = () => {
      if (!pill || todo.length <= 10) return;
      pill.hidden = false;
      pill.querySelector('span').textContent = `Orte zuordnen · noch ${(todo.length - n).toLocaleString('de-DE')}` + (pause > Date.now() ? ' · Pause' : '');
      pill.querySelector('i').style.width = Math.round(n / todo.length * 100) + '%';
    };
    if (pill) pill.onclick = () => toast('Das Land kennt die App sofort. Online fragt sie noch nach der Art (Campingplatz, See …) bei importierten Google-Orten. Das läuft, solange die App offen ist und Internet hat, und macht beim nächsten Öffnen dort weiter.', 8000);
    show();
    let k = 0;
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (k < todo.length && navigator.onLine) {
        if (pause > Date.now()) { show(); await new Promise((r) => setTimeout(r, 2000)); continue; }
        if (document.hidden) { await new Promise((r) => setTimeout(r, 1500)); continue; }
        const p = todo[k++];
        await work(p);
        await new Promise((r) => setTimeout(r, 110));
      }
    }));
    if (pill) pill.hidden = true;
    const lost = places.filter((p) => (p.lat === null || p.lat === undefined) && !p.pend);
    if (lost.length) { places = places.filter((p) => !lost.includes(p)); toast(`${lost.length} Orte ohne Position waren nicht zu finden und wurden weggelassen: ${lost.slice(0, 3).map((p) => p.name).join(', ')}${lost.length > 3 ? ' …' : ''}`, 7000); }
    this.running = false;
    this.refresh();
    renderDataCats();
    const left = places.filter((p) => p.pend).length;
    if (todo.length > 10) toast(left ? `${left} Orte noch nicht fertig zugeordnet – geht beim nächsten Start mit Internet weiter.` : `Fertig: ${todo.length} Orte zugeordnet ✓`, 5000);
  },

  setup() {
    this.setupQuick();
    map.on('styleimagemissing', (e) => {
      if (!e.id || !e.id.startsWith('sq-') || map.hasImage(e.id)) return;
      const { image, ratio } = this.sqImage(e.id);
      map.addImage(e.id, image, { pixelRatio: ratio });
    });
    $('#list-back').onclick = () => this.closeList();
    $('#list-close').onclick = () => { this.closeList(); closeSheet(); };
    $('#btn-new-list').onclick = () => this.editList(null);
    $('#btn-new-cat').onclick = () => this.editCat(null);
    $('#imp-ok').onclick = () => this.confirmTakeout();
    $('#imp-back').onclick = () => { this.pendingImport = null; $('#imp-page').hidden = true; };
    $('#sel-cancel').onclick = () => this.endSel();
    for (const b of $('#sel-bar').querySelectorAll('button[data-act]')) b.onclick = () => this.selAction(b.dataset.act);
    this.renderChips();
    setTimeout(() => this.enrich(), 6000);
    window.addEventListener('online', () => setTimeout(() => this.enrich(), 3000));
  }
};

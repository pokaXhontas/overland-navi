/* Menü: Übersicht mit Bereichen (Unterseiten), Suche über alle Einstellungen und Orte.
 * Die Inhalte der Bereiche sind die bisherigen Elemente mit ihren Kennungen, nur auf eigene Seiten verteilt. */
'use strict';

const Menu = {
  secs() { return [...document.querySelectorAll('#sheet > .sec-page')]; },

  open(sec) {
    const page = $('#sec-' + sec);
    if (!page) return;
    for (const p of this.secs()) if (p !== page) p.hidden = true;
    $('#sheet').hidden = false;
    page.hidden = false;
    page.querySelector('.sheet-body').scrollTop = 0;
    if (sec === 'trash') Trash.render();
    if (sec === 'zug') Access.renderList();
    if (sec === 'offline') { renderRegions(); updateStorage(); }
    if (sec === 'listen' || sec === 'kat' || sec === 'tracks') renderDataCats();
  },
  back(page) { page.hidden = true; this.refresh(); },
  /* beim Öffnen über den Menü-Knopf: immer die Übersicht */
  reset() {
    for (const p of this.secs()) p.hidden = true;
    const q = $('#menu-q');
    if (q.value) { q.value = ''; this.search(); }
    $('#menu-home').scrollTop = 0;
    this.refresh();
  },

  /* ---------- Kurzinfos unter den Bereichen ---------- */
  refresh() {
    const set = (id, txt, badge) => {
      const s = $('#ms-' + id);
      if (s) s.textContent = txt || '';
      const b = $('#mb-' + id);
      if (b) { b.hidden = !badge; b.textContent = badge || ''; }
    };
    const n = (x, one, many) => `${x.toLocaleString('de-DE')} ${x === 1 ? one : many}`;
    const try_ = (f) => { try { return f(); } catch (e) { return ''; } };
    set('listen', try_(() => n(Lists.all.length, 'Liste', 'Listen') + ' · ' + n(places.length, 'Ort', 'Orte')));
    set('kat', try_(() => {
      const h = settings.hidden.filter((id) => id !== 'tracks' && CAT[id]).length;
      return n(CATS.length, 'Kategorie', 'Kategorien') + (h ? ` · ${h} ausgeblendet` : ' · alle sichtbar');
    }));
    set('tracks', try_(() => {
      const off = settings.hidden.includes('tracks') ? ' · ausgeblendet' : '';
      return tracks.length ? n(tracks.length, 'Track', 'Tracks') + off : 'Noch keine';
    }));
    set('trash', try_(() => Trash.summary()));
    set('standort', try_(() => {
      const on = Live.sharing();
      if (on.length) return 'Wird geteilt' + (on.length === 1 && on[0].me.until ? ' · ' + Live.untilText(on[0].me.until) : '');
      return Live.groups.length ? 'Aus · ' + n(Live.groups.length, 'Gruppe', 'Gruppen') : 'Aus';
    }));
    set('verb', try_(() => (Sync.conns.length ? n(Sync.conns.length, 'Verbindung', 'Verbindungen') : 'Keine')));
    set('zug', try_(() => {
      const p = (Access.state && Access.state.pending) || 0;
      return p ? n(p, 'neue Anfrage', 'neue Anfragen') : 'Keine offenen Anfragen';
    }), try_(() => (Access.state && Access.state.pending ? String(Access.state.pending) : '')));
    set('karte', try_(() => {
      const t = $('#sec-karte [data-maptype][aria-checked="true"]');
      const on = [...document.querySelectorAll('#sec-karte label.row')].filter((r) => r.querySelector('input:checked')).map((r) => r.querySelector('b').textContent);
      return [t ? t.textContent : '', ...on.slice(0, 3)].filter(Boolean).join(' · ');
    }));
    set('offline', try_(() => (Tiles.local.size ? n(Tiles.local.size, 'Gebiet', 'Gebiete') + ' gespeichert' : 'Noch nichts gespeichert')));
    set('navi', try_(() => [$('#voice-on').checked ? 'Ansagen an' : 'Ansagen aus', $('#t-navcam').checked ? 'Navi-Kamera' : '', $('#t-navpitch').checked ? '3D' : ''].filter(Boolean).join(' · ')));
    set('look', try_(() => {
      const t = $('#sec-look [data-theme][aria-checked="true"]');
      const v = $('#veh-grid [aria-checked="true"]');
      return [t ? t.textContent : '', v ? v.textContent.trim() : ''].filter(Boolean).join(' · ');
    }));
    set('import', 'GPX, KML, ZIP und Google-Maps-Listen');
    set('hilfe', 'Handbuch mit Bildern');
  },

  /* ---------- Suche ---------- */
  search() {
    const q = $('#menu-q').value.trim().toLowerCase();
    $('#menu-q-clear').hidden = !q;
    const box = $('#menu-results');
    $('#menu-groups').hidden = !!q;
    box.hidden = !q;
    box.innerHTML = '';
    if (!q) return;
    const has = (t) => String(t || '').toLowerCase().includes(q);
    let found = 0;
    const head = (t) => { const h = document.createElement('h2'); h.textContent = t; box.appendChild(h); };
    for (const page of this.secs()) {
      const sec = page.id.slice(4);
      const row = document.querySelector(`.menu-row[data-sec="${sec}"]`);
      if (!row || row.hidden) continue;
      const title = page.querySelector('.sec-title').textContent;
      const hits = [];
      if (has(title)) hits.push({ go: true });
      const seen = new Set();
      for (const el of page.querySelectorAll('.sheet-body label.row, .sheet-body .row.static, .sheet-body .cat-row, .sheet-body .track-item, .sheet-body .sub-head, .sheet-body .field, .sheet-body .add-region, .sheet-body .import-btn, .sheet-body .add-line, .sheet-body .btn')) {
        if ([...seen].some((s) => s.contains(el))) continue;
        const b = el.querySelector('b');
        const txt = (b ? b.textContent : el.querySelector('span') ? el.querySelector('span').textContent : el.textContent).trim();
        const sub = el.querySelector('small') ? el.querySelector('small').textContent : '';
        if (!txt || !(has(txt) || has(sub))) continue;
        seen.add(el);
        hits.push({ el, txt, sub });
      }
      if (!hits.length) continue;
      head(title);
      for (const h of hits) { box.appendChild(this.result(sec, title, h)); found++; }
    }
    // Orte nach Namen
    const ps = places.filter((p) => has(p.name)).slice(0, 30);
    if (ps.length) { head('Orte'); for (const p of ps) { box.appendChild(Lists.itemRow(p)); found++; } }
    if (!found) box.innerHTML = '<p class="muted small menu-none">Nichts gefunden. Versuch es mit einem anderen Wort, z. B. „Stimme“, „Luftbild“ oder einem Ortsnamen.</p>';
  },
  result(sec, title, h) {
    const wrap = document.createElement('div');
    wrap.className = 'menu-hit';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mh-main';
    b.innerHTML = '<span class="pi-txt"><b></b><small></small></span>';
    b.querySelector('b').textContent = h.go ? title : h.txt;
    b.querySelector('small').textContent = h.go ? 'Bereich öffnen' : 'in ' + title + (h.sub ? ' · ' + h.sub : '');
    b.onclick = () => {
      this.open(sec);
      if (h.go) return;
      if (h.el.classList.contains('cat-row') && h.el.querySelector('.cat-open')) { h.el.querySelector('.cat-open').click(); return; }
      if (h.el.classList.contains('track-item')) { h.el.querySelector('.ti-main').click(); return; }
      requestAnimationFrame(() => {
        h.el.scrollIntoView({ block: 'center' });
        h.el.classList.remove('flash');
        void h.el.offsetWidth;
        h.el.classList.add('flash');
      });
    };
    wrap.appendChild(b);
    // Schalter gleich hier umlegen können
    const sw = !h.go && h.el.matches('label.row') && h.el.querySelector('input.switch');
    if (sw) {
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.className = 'switch';
      c.checked = sw.checked;
      c.setAttribute('aria-label', h.txt);
      c.onchange = () => { sw.click(); c.checked = sw.checked; this.refresh(); };
      wrap.appendChild(c);
    }
    return wrap;
  },

  setup() {
    for (const b of document.querySelectorAll('.menu-row')) b.onclick = () => this.open(b.dataset.sec);
    for (const b of document.querySelectorAll('[data-menu-back]')) b.onclick = () => this.back(b.closest('.sec-page'));
    for (const b of document.querySelectorAll('[data-menu-close]')) b.onclick = () => closeSheet();
    const q = $('#menu-q');
    q.addEventListener('input', () => this.search());
    $('#menu-q-clear').onclick = () => { q.value = ''; this.search(); q.focus(); };
    // Kurzinfos aktuell halten, wenn sich in einem Bereich etwas ändert
    $('#sheet').addEventListener('change', () => setTimeout(() => this.refresh(), 0));
    $('#sheet').addEventListener('click', (e) => { if (e.target.closest('.seg button, #veh-grid button')) setTimeout(() => this.refresh(), 0); });
    this.refresh();
  }
};

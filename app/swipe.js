/* Wischgesten: Fenster mit dem Finger wegschieben.
 * Je nach Fenster schließt das Wischen es oder klappt es klein zusammen (Inhalt bleibt erhalten). */
'use strict';

const Swipe = {
  phone() { return window.matchMedia('(max-width: 600px)').matches; },

  /* el: Fenster; opts.dir(): 'down' | 'up' | 'left' | 'right'; opts.onDismiss(); opts.zone: Bereich, an dem man ziehen kann */
  attach(el, opts) {
    if (!el) return;
    const zone = opts.zone ? el.querySelector(opts.zone) || el : el;
    let st = null;
    const axis = (d) => (d === 'up' || d === 'down' ? 'y' : 'x');
    const sign = (d) => (d === 'down' || d === 'right' ? 1 : -1);

    const scrollBlocks = (target, dir) => {
      // innerhalb von scrollbaren Listen zuerst scrollen lassen
      for (let n = target; n && n !== el.parentNode; n = n.parentNode) {
        if (!(n instanceof HTMLElement)) continue;
        const cs = getComputedStyle(n);
        if (axis(dir) === 'y' && /(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 2) {
          if (dir === 'down' && n.scrollTop > 0) return true;
          if (dir === 'up' && n.scrollTop + n.clientHeight < n.scrollHeight - 2) return true;
        }
        if (axis(dir) === 'x' && /(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 2) return true;
        if (n === el) break;
      }
      return false;
    };

    zone.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const handle = opts.handle && opts.handle();
      if (handle && !e.target.closest(handle)) return;
      if (opts.exclude && e.target.closest(opts.exclude)) return;
      if (e.target.closest('input, textarea, select, .switch, .maplibregl-canvas')) return;
      if (opts.enabled && !opts.enabled()) return;
      const dir = opts.dir();
      if (scrollBlocks(e.target, dir)) return;
      // markierter Text würde sonst als „Text ziehen“ die Geste abbrechen
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.rangeCount && !e.target.closest('[contenteditable]')) sel.removeAllRanges();
      st = { dir, x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, on: false, off: 0, lastOff: 0, lastT: performance.now(), v: 0 };
    });

    zone.addEventListener('pointermove', (e) => {
      if (!st || e.pointerId !== st.id) return;
      const dx = e.clientX - st.x, dy = e.clientY - st.y;
      const main = axis(st.dir) === 'y' ? dy : dx, cross = axis(st.dir) === 'y' ? dx : dy;
      if (!st.on) {
        if (Math.abs(cross) > 12 && Math.abs(cross) > Math.abs(main)) { st = null; return; }
        if (Math.abs(main) < 8) return;
        if (el.classList.contains('swiping')) { st = null; return; }   // eine andere Wischrichtung ist schon dran
        st.on = true;
        try { zone.setPointerCapture(e.pointerId); } catch (err) { /* egal */ }
        el.style.transition = 'none';
        el.classList.add('swiping');
      }
      e.preventDefault();
      let off = main * sign(st.dir);
      if (off < 0) off = off / 4; // gegen die Richtung nur ein bisschen nachgeben
      const now = performance.now();
      st.v = (off - st.lastOff) / Math.max(1, now - st.lastT);
      st.lastOff = off; st.lastT = now; st.off = off;
      const px = off * sign(st.dir);
      el.style.translate = axis(st.dir) === 'y' ? `0 ${px}px` : `${px}px 0`;
    });

    const end = (e) => {
      if (!st || e.pointerId !== st.id) return;
      const s = st;
      st = null;
      if (!s.on) return;
      el.classList.remove('swiping');
      // kein Klick nach dem Wischen
      const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener('click', stop, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 350);
      const size = axis(s.dir) === 'y' ? el.offsetHeight : el.offsetWidth;
      const go = s.off > Math.min(140, size * 0.3) || (s.v > 0.5 && s.off > 25);
      if (go && opts.fold) {
        // in einem Zug zusammen- bzw. aufklappen statt hinauszuschieben
        const from = el.style.translate;
        el.style.transition = 'none';
        el.style.translate = '';
        opts.onDismiss(s.dir, from);
        requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transition = ''; }));
        return;
      }
      el.style.transition = 'translate .2s ease';
      if (!go) { el.style.translate = ''; setTimeout(() => { el.style.transition = ''; }, 220); return; }
      const out = (size + 60) * sign(s.dir);
      el.style.translate = axis(s.dir) === 'y' ? `0 ${out}px` : `${out}px 0`;
      setTimeout(() => {
        el.style.transition = 'none';
        el.dataset.swiped = '1';
        opts.onDismiss(s.dir);
        delete el.dataset.swiped;
        el.style.translate = '';
        requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transition = ''; }));
      }, 200);
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  },

  /* Zusammenklappen: Fenster wird klein, Antippen klappt wieder auf */
  foldable(el, cls, expandZone) {
    el.addEventListener('click', (e) => {
      if (!el.classList.contains(cls)) return;
      if (expandZone && !e.target.closest(expandZone)) return;
      e.stopPropagation();
      this.fold(el, cls, false);
    }, true);
  },

  /* weiche Übergänge beim Öffnen, Schließen und Zusammenklappen */
  calm() { return !Element.prototype.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches; },
  away(r, dir) {
    if (dir === 'up') return `0 ${-(r.bottom + 12)}px`;
    if (dir === 'left') return `${-(r.right + 12)}px 0`;
    if (dir === 'right') return `${innerWidth - r.left + 12}px 0`;
    return `0 ${innerHeight - r.top + 12}px`;
  },
  show(el, dir) {
    if (!el) return;
    const was = el.hidden;
    el.hidden = false;
    if (!was || this.calm()) return;
    const r = el.getBoundingClientRect();
    if (!r.height) return;
    el.animate([{ translate: this.away(r, typeof dir === 'function' ? dir() : dir), opacity: 0.6 }, { translate: '0 0', opacity: 1 }],
      { duration: 340, easing: 'cubic-bezier(.2,.85,.25,1)' });
  },
  hide(el, dir) {
    if (!el || el.hidden) return;
    const swiped = el.dataset.swiped;
    delete el.dataset.swiped;
    const r = el.getBoundingClientRect();
    if (swiped || this.calm() || !r.height) { el.hidden = true; return; }
    // Abbild gleitet hinaus, das echte Fenster ist sofort zu (Zustand bleibt eindeutig)
    const g = el.cloneNode(true);
    g.removeAttribute('id');
    g.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    const a = el.querySelectorAll('input, textarea, select'), b = g.querySelectorAll('input, textarea, select');
    a.forEach((n, i) => { if (b[i]) b[i].value = n.value; });
    g.inert = true;
    g.setAttribute('aria-hidden', 'true');
    Object.assign(g.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px',
      right: 'auto', bottom: 'auto', transform: 'none', translate: 'none', margin: '0', maxHeight: 'none', pointerEvents: 'none', transition: 'none' });
    el.after(g);
    const sc = el.querySelectorAll('*'), gc = g.querySelectorAll('*');
    if (el.scrollTop) g.scrollTop = el.scrollTop;
    sc.forEach((n, i) => { if (n.scrollTop && gc[i]) gc[i].scrollTop = n.scrollTop; });
    el.hidden = true;
    const an = g.animate([{ translate: '0 0', opacity: 1 }, { translate: this.away(r, typeof dir === 'function' ? dir() : dir), opacity: 0.6 }],
      { duration: 260, easing: 'cubic-bezier(.45,0,.85,.4)', fill: 'forwards' });
    an.onfinish = an.oncancel = () => g.remove();
  },
  /* Höhe weich ändern; from: Verschiebung vom Wischen, die dabei zurückgeht */
  fold(el, cls, on, from) {
    if (el.classList.contains(cls) === on) return;
    const h0 = el.getBoundingClientRect().height;
    if (el._fold) { const f = el._fold; el._fold = null; f.cancel(); }
    el.classList.toggle(cls, on);
    if (this.calm() || el.hidden) { el.classList.remove('folding'); return; }
    el.classList.add('folding');
    const h1 = el.getBoundingClientRect().height;
    const kf = [{ height: h0 + 'px' }, { height: h1 + 'px' }];
    if (from) { kf[0].translate = from; kf[1].translate = '0 0'; }
    const an = el._fold = el.animate(kf, { duration: 320, easing: 'cubic-bezier(.25,.85,.3,1)' });
    for (const k of el.children) {
      if (k.classList.contains('grab') || getComputedStyle(k).display === 'none') continue;
      k.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: on ? 40 : 90, easing: 'ease-out', fill: 'backwards' });
    }
    an.onfinish = an.oncancel = () => { if (el._fold === an) { el._fold = null; el.classList.remove('folding'); } };
  },

  setup() {
    const side = () => (this.phone() ? 'down' : 'right');
    // iPhone: an Kopfzeile oder Griff ziehen, damit die Listen normal scrollen; iPad: überall seitlich
    const sheetHandle = () => (this.phone() ? '.sheet-head, .grab' : null);
    // Seitenfenster: Menü, Ort, Track
    this.attach($('#sheet'), { dir: side, handle: sheetHandle, onDismiss: () => closeSheet() });
    this.attach($('#spot'), { dir: side, handle: sheetHandle, onDismiss: () => closeEditor(), enabled: () => !editor.moving });
    this.attach($('#trackinfo'), { dir: side, handle: sheetHandle, onDismiss: () => closeTrackInfo() });
    this.attach($('#hike-sheet'), { dir: side, handle: sheetHandle, onDismiss: () => Hike.close() });
    this.attach($('#tour-sheet'), { dir: side, handle: sheetHandle, onDismiss: () => Tours.close() });
    // Suche und Planer nach oben (iPhone) bzw. zur Seite (iPad) wegschieben
    this.attach($('#search'), { dir: () => 'up', handle: () => '.search-bar, .grab', onDismiss: () => closeSearch() });
    this.attach($('#planner'), { dir: () => (this.phone() ? 'up' : 'left'), handle: () => (this.phone() ? '.pl-head, .grab' : null), onDismiss: () => Planner.close() });

    // Routenauswahl: nach unten wischen klappt sie klein, damit man die Routen sieht
    const alts = $('#nav-alts');
    this.attach(alts, {
      dir: () => (alts.classList.contains('peek') ? 'up' : 'down'),
      // in der Liste wird gescrollt, nicht weggewischt
      exclude: '.na-list',
      fold: true,
      onDismiss: (d, from) => this.fold(alts, 'peek', d === 'down', from)
    });
    this.foldable(alts, 'peek', '.na-peek-txt, .grab');
    // seitlich (nach links) hinausschieben schließt die Auswahl, wie „Abbrechen“
    this.attach(alts, { dir: () => 'left', onDismiss: () => Nav.cancelPick() });

    // Navigation: Hinweis oben und Restweg unten lassen sich klein machen
    const banner = $('#nav-banner'), foot = $('#nav-foot');
    this.attach(banner, { dir: () => 'up', onDismiss: () => banner.classList.add('mini'), enabled: () => !banner.classList.contains('mini') });
    this.foldable(banner, 'mini');
    this.attach(foot, { dir: () => 'down', onDismiss: () => foot.classList.add('mini'), enabled: () => !foot.classList.contains('mini') });
    this.foldable(foot, 'mini');

    // Zeichenleiste
    const db = $('#draw-bar');
    this.attach(db, { dir: () => 'up', onDismiss: () => db.classList.add('mini'), enabled: () => !db.classList.contains('mini') });
    this.foldable(db, 'mini', '.db-head');

    // Tacho zur Seite schieben, ein kleiner Griff bleibt stehen
    const hud = $('.hud');
    if (hud) {
      if (store.get('hudTucked', false)) hud.classList.add('tucked');
      this.attach(hud, { dir: () => 'left', onDismiss: () => { hud.classList.add('tucked'); store.set('hudTucked', true); }, enabled: () => !hud.classList.contains('tucked') });
      hud.addEventListener('click', (e) => {
        if (!hud.classList.contains('tucked')) return;
        e.stopPropagation();
        hud.classList.remove('tucked'); store.set('hudTucked', false);
      }, true);
    }

    // Hinweise unten wegwischen
    const t = $('#toast');
    this.attach(t, { dir: () => 'down', onDismiss: () => t.classList.remove('show') });
  }
};

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
      if (e.target.closest('input, textarea, select, .switch, .maplibregl-canvas')) return;
      if (opts.enabled && !opts.enabled()) return;
      const dir = opts.dir();
      if (scrollBlocks(e.target, dir)) return;
      st = { dir, x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, on: false, off: 0, lastOff: 0, lastT: performance.now(), v: 0 };
    });

    zone.addEventListener('pointermove', (e) => {
      if (!st || e.pointerId !== st.id) return;
      const dx = e.clientX - st.x, dy = e.clientY - st.y;
      const main = axis(st.dir) === 'y' ? dy : dx, cross = axis(st.dir) === 'y' ? dx : dy;
      if (!st.on) {
        if (Math.abs(cross) > 12 && Math.abs(cross) > Math.abs(main)) { st = null; return; }
        if (Math.abs(main) < 8) return;
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
      el.style.transition = 'translate .2s ease';
      if (!go) { el.style.translate = ''; setTimeout(() => { el.style.transition = ''; }, 220); return; }
      const out = (size + 60) * sign(s.dir);
      el.style.translate = axis(s.dir) === 'y' ? `0 ${out}px` : `${out}px 0`;
      setTimeout(() => {
        el.style.transition = 'none';
        opts.onDismiss(s.dir);
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
      el.classList.remove(cls);
    }, true);
  },

  setup() {
    const side = () => (this.phone() ? 'down' : 'right');
    // iPhone: an Kopfzeile oder Griff ziehen, damit die Listen normal scrollen; iPad: überall seitlich
    const sheetHandle = () => (this.phone() ? '.sheet-head, .grab' : null);
    // Seitenfenster: Menü, Ort, Track
    this.attach($('#sheet'), { dir: side, handle: sheetHandle, onDismiss: () => closeSheet() });
    this.attach($('#spot'), { dir: side, handle: sheetHandle, onDismiss: () => closeEditor(), enabled: () => !editor.moving });
    this.attach($('#trackinfo'), { dir: side, handle: sheetHandle, onDismiss: () => closeTrackInfo() });
    // Suche und Planer nach oben (iPhone) bzw. zur Seite (iPad) wegschieben
    this.attach($('#search'), { dir: () => 'up', handle: () => '.search-bar, .grab', onDismiss: () => closeSearch() });
    this.attach($('#planner'), { dir: () => (this.phone() ? 'up' : 'left'), handle: () => (this.phone() ? '.pl-head, .grab' : null), onDismiss: () => Planner.close() });

    // Routenauswahl: nach unten wischen klappt sie klein, damit man die Routen sieht
    const alts = $('#nav-alts');
    this.attach(alts, {
      dir: () => (alts.classList.contains('peek') ? 'up' : 'down'),
      onDismiss: (d) => { alts.classList.toggle('peek', d === 'down'); }
    });
    this.foldable(alts, 'peek', '.na-peek-txt, .grab');

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

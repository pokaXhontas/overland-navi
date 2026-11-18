/* Zugang: Nur freigegebene Geräte bekommen Karten, Sync und Standort vom Worker.
 * Jedes Gerät hat einen eigenen geheimen Schlüssel; Verwalter geben neue Geräte in der App frei. */
'use strict';

const Access = {
  FALLBACK: 'https://ovl-karte.y3m.workers.dev',
  state: null,
  timer: null,

  key() {
    let k = localStorage.getItem('ovl.devKey');
    if (!k) {
      k = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('ovl.devKey', k);
    }
    return k;
  },
  origin() {
    try {
      const s = typeof Tiles !== 'undefined' && Tiles.sources ? (Tiles.sources.sync || Tiles.sources.base) : '';
      return new URL(s || this.FALLBACK).origin;
    } catch (e) { return this.FALLBACK; }
  },
  /* Nur wenn der Worker die Zugangsprüfung kennt (ältere Worker lehnen die Kopfzeile ab) */
  on() { const s = this.saved(); return !(s && s.status === 'open'); },
  /* Schlüssel an Anfragen zum eigenen Worker hängen */
  init(input, init) {
    if (!this.on()) return init;
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!url.startsWith(this.origin())) return init;
    const h = new Headers((init && init.headers) || (input && input.headers) || undefined);
    h.set('X-Key', this.key());
    return { ...(init || {}), headers: h };
  },
  msg() { return { key: this.on() ? this.key() : '', origin: this.origin() }; },
  model() {
    const u = navigator.userAgent;
    if (/iPad|Macintosh/.test(u) && navigator.maxTouchPoints > 1) return 'iPad';
    if (/iPhone/.test(u)) return 'iPhone';
    if (/Android/.test(u)) return 'Android';
    if (/Mac/.test(u)) return 'Mac';
    if (/Windows/.test(u)) return 'Windows';
    return 'Gerät';
  },
  saved() { try { return JSON.parse(localStorage.getItem('ovl.access') || 'null'); } catch (e) { return null; } },
  async call(what, body) {
    const headers = { 'X-Key': this.key(), ...(body ? { 'Content-Type': 'application/json' } : {}) };
    const r = await rawFetch(this.origin() + '/auth/' + what, body ? { method: 'POST', body: JSON.stringify(body), headers } : { cache: 'no-store', headers });
    if (r.status === 404 || r.status === 501) return { status: 'open' };   // Worker noch ohne Zugangsprüfung
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j.status) throw new Error(j.error || 'Server ' + r.status);
    return j;
  },
  async check() {
    if (!navigator.onLine) { const s = this.saved(); if (s && s.status !== 'ok' && s.status !== 'open') this.showGate(s.status); return; }
    let s;
    const before = this.saved();
    try { s = await this.call('status'); } catch (e) {
      // Worker ohne Zugangsprüfung (lehnt die Kopfzeile ab) oder kurz nicht erreichbar: nicht aussperren
      if (!before) localStorage.setItem('ovl.access', JSON.stringify({ status: 'open', at: Date.now() }));
      return;
    }
    this.state = s;
    localStorage.setItem('ovl.access', JSON.stringify({ status: s.status, admin: !!s.admin, at: Date.now() }));
    if (s.status === 'ok' || s.status === 'open') {
      // gerade freigegeben oder Zugangsprüfung neu eingeschaltet: Karte mit Schlüssel neu laden
      if (!$('#gate').hidden || (s.status === 'ok' && before && before.status === 'open')) { location.reload(); return; }
      this.hideGate();
      $('#acc-section').hidden = !s.admin;
      if (s.admin && s.pending) toast(`${s.pending} ${s.pending === 1 ? 'neue Zugangsanfrage' : 'neue Zugangsanfragen'} – Menü → Zugänge`, 6000);
      if (before && before.status !== 'ok' && before.status !== 'open' && s.status === 'ok') toast('Zugang freigegeben – willkommen!');
      return;
    }
    this.showGate(s.status);
  },
  showGate(status) {
    const g = $('#gate');
    g.hidden = false;
    const blocked = status === 'blocked';
    const waiting = status === 'pending';
    $('#gate-title').textContent = blocked ? 'Kein Zugang' : 'Diese App ist privat';
    $('#gate-txt').textContent = blocked ? 'Dieses Gerät wurde gesperrt. Wenn das ein Versehen ist, sag den Leuten Bescheid, von denen du den Link hast.'
      : waiting ? 'Deine Anfrage ist angekommen. Du kannst die App schließen – beim nächsten Öffnen geht es los, sobald du freigegeben bist. Mit Benachrichtigung erfährst du es sofort.'
        : 'Gib deinen Namen ein und frag nach Zugang. Sobald jemand zustimmt, startet die App hier von selbst.';
    $('#gate-form').hidden = blocked || waiting;
    $('#gate-wait').hidden = !waiting;
    $('#gate-push').hidden = !waiting;
    if (waiting) this.renderPushBtn($('#gate-push'), 'Du wirst benachrichtigt ✓', 'Benachrichtigen, wenn freigegeben');
    clearInterval(this.timer);
    if (waiting) this.timer = setInterval(() => { if (!document.hidden) this.check(); }, 15000);
  },
  hideGate() { $('#gate').hidden = true; clearInterval(this.timer); },
  async request() {
    const name = $('#gate-name').value.trim();
    if (!name) { $('#gate-name').focus(); toast('Bitte deinen Namen eingeben, damit man dich erkennt.'); return; }
    localStorage.setItem('ovl.liveName', JSON.stringify(name));
    try {
      const s = await this.call('request', { name, model: this.model() });
      if (s.error) { toast(s.error); return; }
      this.showGate(s.status === 'none' ? 'pending' : s.status);
    } catch (e) { toast('Anfrage ging nicht raus – Internet da?'); }
  },
  async becomeAdmin() {
    const code = $('#gate-code').value.trim();
    if (!code) return;
    try {
      const s = await this.call('admin', { code, name: $('#gate-name').value.trim() || 'Verwalter', model: this.model() });
      if (s.error) { toast(s.error === 'falscher Code' ? 'Der Verwalter-Code stimmt nicht.' : s.error); return; }
      await this.check();
    } catch (e) { toast('Ging nicht – Internet da?'); }
  },

  /* ---------- Push-Nachrichten ---------- */
  pushOk() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; },
  async pushOn() {
    if (!this.pushOk() || Notification.permission !== 'granted') return false;
    try { const reg = await navigator.serviceWorker.ready; return !!(await reg.pushManager.getSubscription()); } catch (e) { return false; }
  },
  async enablePush() {
    if (!this.pushOk()) {
      const ios = /iPhone|iPad/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
      toast(ios && !(navigator.standalone || matchMedia('(display-mode: standalone)').matches)
        ? 'Benachrichtigungen gehen auf dem iPhone nur in der App vom Home-Bildschirm (nicht in Safari).'
        : 'Dieses Gerät oder dieser Browser kann keine Benachrichtigungen empfangen.', 7000);
      return false;
    }
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('Benachrichtigungen sind nicht erlaubt. In den Einstellungen bei Mitteilungen → Overland-Navi einschalten.', 7000); return false; }
      const reg = await navigator.serviceWorker.ready;
      const { key } = await this.call('vapid');
      if (!key) throw new Error('kein Schlüssel');
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((key.length + 3) % 4)), (c) => c.charCodeAt(0)) });
      const r = await this.call('push', { sub: sub.toJSON(), test: true });
      if (r.error) throw new Error(r.error);
      toast('Benachrichtigungen sind an. Zur Probe kommt gleich eine Nachricht.', 5000);
      return true;
    } catch (e) { toast('Benachrichtigungen ließen sich nicht einschalten: ' + e.message, 7000); return false; }
  },
  async renderPushBtn(btn, onTxt, offTxt) {
    if (!btn) return;
    const on = await this.pushOn();
    btn.textContent = on ? onTxt : offTxt;
    btn.classList.toggle('primary', !on);
  },

  /* ---------- Verwaltung im Menü ---------- */
  async renderList() {
    const box = $('#acc-list');
    if (!box || $('#acc-section').hidden) return;
    this.renderPushBtn($('#acc-push'), 'Benachrichtigungen sind an ✓', 'Bei neuen Anfragen benachrichtigen');
    let data;
    try { data = await this.call('list'); } catch (e) { box.innerHTML = '<p class="muted small">Liste gerade nicht abrufbar.</p>'; return; }
    if (!data.devices) return;
    box.innerHTML = '';
    const label = { pending: 'wartet auf Freigabe', ok: 'freigegeben', blocked: 'gesperrt' };
    for (const d of data.devices) {
      const row = document.createElement('div');
      row.className = 'acc-row' + (d.status === 'pending' ? ' new' : '');
      const me = d.id === data.me;
      row.innerHTML = `<span class="pi-txt"><b></b><small></small></span>`;
      row.querySelector('b').textContent = (d.name || 'Ohne Namen') + (me ? ' (dieses Gerät)' : '');
      const seen = d.seen ? ' · zuletzt ' + new Date(d.seen).toLocaleDateString('de') : '';
      row.querySelector('small').textContent = [d.model, label[d.status] || d.status, d.admin ? 'Verwalter' : ''].filter(Boolean).join(' · ') + seen;
      const btns = document.createElement('span');
      btns.className = 'acc-btns';
      const add = (txt, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ' + cls; b.textContent = txt; b.onclick = fn; btns.appendChild(b); };
      const set = async (body, msg) => { try { const r = await this.call('set', { id: d.id, ...body }); if (r.error) toast(r.error); else if (msg) toast(msg); } catch (e) { toast('Ging nicht – Internet da?'); } this.renderList(); };
      if (d.status === 'pending') {
        add('Erlauben', 'primary', () => set({ status: 'ok' }, (d.name || 'Gerät') + ' ist freigegeben'));
        add('Ablehnen', '', () => set({ status: 'delete' }));
      } else if (!me) {
        add('…', '', async () => {
          const opts = d.status === 'ok'
            ? [{ id: 'blocked', label: 'Sperren', d: 'M6 6l12 12M18 6 6 18' }, { id: 'admin', label: d.admin ? 'Kein Verwalter mehr' : 'Zum Verwalter machen', d: 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6Z' }]
            : [{ id: 'ok', label: 'Wieder freigeben', d: 'M5 12l5 5 9-10' }];
          opts.push({ id: 'delete', label: 'Ganz entfernen', d: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13' });
          const pick = await Lists.choose(d.name || 'Gerät', opts);
          if (!pick) return;
          if (pick === 'admin') set({ admin: !d.admin });
          else set({ status: pick });
        });
      }
      row.appendChild(btns);
      box.appendChild(row);
    }
  },

  setup() {
    const s = this.saved();
    $('#acc-section').hidden = !(s && s.admin);
    $('#gate-req').onclick = () => this.request();
    $('#gate-admin').onclick = () => this.becomeAdmin();
    $('#acc-refresh').onclick = () => this.renderList();
    $('#acc-push').onclick = async () => { await this.enablePush(); this.renderPushBtn($('#acc-push'), 'Benachrichtigungen sind an ✓', 'Bei neuen Anfragen benachrichtigen'); };
    $('#gate-push').onclick = async () => { await this.enablePush(); this.renderPushBtn($('#gate-push'), 'Du wirst benachrichtigt ✓', 'Benachrichtigen, wenn freigegeben'); };
    // Tipp auf eine Nachricht: Zugänge öffnen
    const openAcc = () => { if ($('#acc-section').hidden) return; $('#btn-layers').click(); setTimeout(() => $('#acc-section').scrollIntoView({ block: 'start' }), 300); };
    if (location.hash === '#zugaenge') { history.replaceState(null, '', location.pathname + location.search); setTimeout(openAcc, 1500); }
    if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'open') { this.check(); if (e.data.hash === '#zugaenge') openAcc(); } });
    const nm = localStorage.getItem('ovl.liveName');
    if (nm) { try { $('#gate-name').value = JSON.parse(nm); } catch (e) { /* egal */ } }
    this.check();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#gate').hidden) this.check(); });
  }
};

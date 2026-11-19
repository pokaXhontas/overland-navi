// Overland-Navi: Zwischenstation für Kartendateien.
// Die Kartenserver erlauben keine direkten Zugriffe aus Web-Apps (fehlende CORS-Freigabe).
// Dieser Cloudflare Worker reicht nur Kartenanfragen durch und ergänzt die Freigabe.
// Einfügen unter Cloudflare → Workers & Pages → ovl-karte → Code bearbeiten → alles ersetzen → Bereitstellen.
//
// Zusätzlich: Ablage für Sync-Codes unter /sync/<raum>. Dafür braucht der Worker einen KV-Speicher
// mit dem Variablennamen SYNC (Einstellungen → Bindungen → KV-Namespace). Die Daten kommen
// verschlüsselt an; der Schlüssel steckt nur im Code auf den Geräten, nie hier.
//
// Standort teilen unter /loc/<gruppe>[/<mitglied>]: braucht eine D1-Datenbank mit dem
// Variablennamen LOC (Einstellungen → Bindungen → D1-Datenbank). Die Tabelle legt der Worker selbst an.
//
// Zugang: Karten, Sync und Standort gibt es nur für freigegebene Geräte (Kopfzeile X-Key).
// Geräte fragen unter /auth/request an, Verwalter geben sie in der App frei. Ohne LOC-Datenbank bleibt alles offen.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-Match, If-None-Match, X-Write, X-Key, Content-Type',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, ETag, Accept-Ranges',
  'Access-Control-Max-Age': '86400'
};

// Wanderwege: Dateien aus den GitHub-Downloads des App-Projekts
const WANDER = 'https://github.com/pokaXhontas/overland-navi/releases/download/wanderwege/';

const MAX = 20 * 1024 * 1024;   // größte Ablage pro Verbindung

async function sha(text) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const reply = (status, body, extra = {}) => new Response(body, { status, headers: { ...CORS, 'Cache-Control': 'no-store', ...extra } });

async function sync(request, env, room) {
  if (!env.SYNC) return reply(501, 'Sync-Speicher fehlt (KV-Bindung SYNC)');
  const key = 'r:' + room;
  if (request.method === 'GET' || request.method === 'HEAD') {
    const { value, metadata } = await env.SYNC.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!value) return reply(404, 'leer');
    const etag = '"' + (metadata && metadata.v || 0) + '"';
    if (request.headers.get('If-None-Match') === etag) return reply(304, null, { ETag: etag });
    return reply(200, request.method === 'HEAD' ? null : value, { ETag: etag, 'Content-Type': 'application/octet-stream' });
  }
  const token = request.headers.get('X-Write') || '';
  if (token.length < 16) return reply(403, 'nur lesen');
  const hash = await sha(token);
  const old = await env.SYNC.getWithMetadata(key, { type: 'stream' });
  const meta = old.metadata || null;
  if (old.value) await old.value.cancel();
  if (meta && meta.h !== hash) return reply(403, 'falscher Schreibschlüssel');
  if (request.method === 'DELETE') {
    if (meta) await env.SYNC.delete(key);
    return reply(204, null);
  }
  if (request.method !== 'PUT') return reply(405, 'nicht erlaubt');
  const ifMatch = request.headers.get('If-Match');
  const cur = '"' + (meta && meta.v || 0) + '"';
  if (ifMatch && ifMatch !== cur) return reply(412, 'inzwischen geändert', { ETag: cur });
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX) return reply(413, 'zu groß');
  const v = (meta && meta.v || 0) + 1;
  await env.SYNC.put(key, body, { metadata: { h: hash, v, t: Date.now() } });
  return reply(200, String(v), { ETag: '"' + v + '"' });
}

/* ---------- Push-Nachrichten (Web Push, RFC 8291/8292) ---------- */
const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (t) => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((t.length + 3) % 4)), (c) => c.charCodeAt(0));
const cat = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };
const te = (t) => new TextEncoder().encode(t);
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
/* Schlüsselpaar für die Absenderkennung: legt der Worker beim ersten Mal selbst an und merkt es sich in der Datenbank */
let vapid = null;
async function vapidKeys(db) {
  if (vapid) return vapid;
  await db.prepare('CREATE TABLE IF NOT EXISTS cfg (k TEXT PRIMARY KEY, v TEXT)').run();
  let row = await db.prepare("SELECT v FROM cfg WHERE k = 'vapid'").first();
  if (!row) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const pub = await crypto.subtle.exportKey('raw', kp.publicKey);
    await db.prepare("INSERT OR IGNORE INTO cfg (k, v) VALUES ('vapid', ?)").bind(JSON.stringify({ jwk, pub: b64u(pub) })).run();
    row = await db.prepare("SELECT v FROM cfg WHERE k = 'vapid'").first();
  }
  const v = JSON.parse(row.v);
  vapid = { pub: v.pub, key: await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  return vapid;
}
async function pushTo(db, sub, msg) {
  const v = await vapidKeys(db);
  const ua = unb64u(sub.p256dh), auth = unb64u(sub.auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const as = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, cat(te('WebPush: info\0'), ua, as), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te('Content-Encoding: nonce\0'), 12);
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, cat(te(JSON.stringify(msg)), new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt); new DataView(head.buffer).setUint32(16, 4096); head[20] = 65;
  const body = cat(head, as, ct);
  const aud = new URL(sub.endpoint).origin;
  const jwtHead = b64u(te(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const jwtBody = b64u(te(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://pokaxhontas.github.io' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.key, te(jwtHead + '.' + jwtBody));
  const r = await fetch(sub.endpoint, { method: 'POST', body, headers: {
    'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high',
    Authorization: `vapid t=${jwtHead}.${jwtBody}.${b64u(sig)}, k=${v.pub}` } });
  if (r.status === 404 || r.status === 410) await db.prepare('DELETE FROM push WHERE endpoint = ?').bind(sub.endpoint).run();   // abgemeldet
  return r.status;
}
async function pushTable(db) { await db.prepare('CREATE TABLE IF NOT EXISTS push (endpoint TEXT PRIMARY KEY, dev TEXT NOT NULL, p256dh TEXT, auth TEXT, created INTEGER)').run(); }
async function notify(db, where, args, msg) {
  await pushTable(db);
  const { results } = await db.prepare('SELECT p.endpoint, p.p256dh, p.auth FROM push p JOIN dev d ON d.id = p.dev WHERE ' + where).bind(...args).all();
  await Promise.all(results.map((sub) => pushTo(db, sub, msg).catch(() => 0)));
}

/* ---------- Zugang ---------- */
const ADMIN_HASH = 'aa589afaca59eb6e8cd6d17e06acd21bcab19bda712b0210ac9a24988d0f0975';   // Hash des Verwalter-Codes (der Code selbst steht nirgends)
const REVIEW_HASH = '9314d300d8778e2e827795f3b33fd065ccd3daf7ebab8680b93eeaa294ffb666';   // Hash des Prüfer-Codes für Apples App-Prüfung (gibt normalen Zugang, keinen Verwalter)
const CI_HASH = '3a078d0c6bb72b7de96caa4b4437e5ecd79c4e025dbfd9cde8a5507d6d257f7b';      // Hash des Schlüssels für die automatischen Prüfläufe
let devReady = false;
const seenOk = new Map();   // kurzer Zwischenspeicher: Schlüssel-Hash → Zeit der letzten erfolgreichen Prüfung
async function devTable(db) {
  if (devReady) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS dev (id TEXT PRIMARY KEY, name TEXT, model TEXT, status TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, created INTEGER, seen INTEGER)').run();
  devReady = true;
}
async function device(env, request) {
  const key = request.headers.get('X-Key') || '';
  if (key.length < 16) return null;
  const id = await sha(key);
  if (id === CI_HASH) return { id, status: 'ok', admin: 0, ci: true };
  await devTable(env.LOC);
  return (await env.LOC.prepare('SELECT id, name, model, status, admin FROM dev WHERE id = ?').bind(id).first()) || { id, status: 'none', admin: 0 };
}
/* null = darf; sonst Antwort 401 */
async function gate(request, env) {
  if (!env.LOC) return null;
  const key = request.headers.get('X-Key') || '';
  const now = Date.now();
  const hit = key && seenOk.get(key);
  if (hit && now - hit < 120e3) return null;
  const d = await device(env, request);
  if (d && d.status === 'ok') {
    seenOk.set(key, now);
    if (!d.ci) await env.LOC.prepare('UPDATE dev SET seen = ? WHERE id = ?').bind(now, d.id).run();
    return null;
  }
  return reply(401, JSON.stringify({ status: d ? d.status : 'none' }), { 'Content-Type': 'application/json' });
}
async function auth(request, env, what, ctx) {
  if (!env.LOC) return reply(501, JSON.stringify({ status: 'open' }), { 'Content-Type': 'application/json' });
  const db = env.LOC;
  await devTable(db);
  const json = (o, st = 200) => reply(st, JSON.stringify(o), { 'Content-Type': 'application/json' });
  const d = await device(env, request);
  if (!d) return json({ status: 'none' }, 400);
  const now = Date.now();
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
  if (what === 'status') {
    const out = { status: d.status, admin: !!d.admin, name: d.name || '' };
    if (d.admin) out.pending = (await db.prepare("SELECT COUNT(*) AS n FROM dev WHERE status = 'pending'").first()).n;
    return json(out);
  }
  if (what === 'request' && request.method === 'POST') {
    if (d.status === 'none') {
      const open = (await db.prepare("SELECT COUNT(*) AS n FROM dev WHERE status = 'pending'").first()).n;
      if (open >= 50) return json({ status: 'none', error: 'zu viele offene Anfragen' }, 429);
      const name = String(body.name || '').slice(0, 40), model = String(body.model || '').slice(0, 40);
      await db.prepare('INSERT INTO dev (id, name, model, status, admin, created, seen) VALUES (?, ?, ?, ?, 0, ?, ?)')
        .bind(d.id, name, model, 'pending', now, now).run();
      const job = notify(db, "d.admin = 1 AND d.status = 'ok'", [], { title: 'Neue Zugangsanfrage', body: `${name || 'Jemand'}${model ? ' (' + model + ')' : ''} möchte Overland-Navi nutzen.`, url: '#zugaenge' });
      if (ctx) ctx.waitUntil(job); else await job;
      return json({ status: 'pending' });
    }
    if (d.status === 'pending' && body.name) await db.prepare('UPDATE dev SET name = ?, model = ? WHERE id = ?').bind(String(body.name).slice(0, 40), String(body.model || '').slice(0, 40), d.id).run();
    return json({ status: d.status });
  }
  if (what === 'admin' && request.method === 'POST') {
    const code = String(body.code || '').trim().toUpperCase();
    const h = code ? await sha(code) : '';
    if (h && h === REVIEW_HASH) {
      // Prüfer-Code: sofort normaler Zugang; das Gerät steht in „Zugänge“ und lässt sich dort jederzeit sperren
      await db.prepare('INSERT INTO dev (id, name, model, status, admin, created, seen) VALUES (?, ?, ?, ?, 0, ?, ?) ON CONFLICT (id) DO UPDATE SET status = CASE WHEN dev.status = \'blocked\' THEN \'blocked\' ELSE \'ok\' END')
        .bind(d.id, 'App-Prüfung · ' + String(body.name || '').slice(0, 30), String(body.model || '').slice(0, 40), 'ok', now, now).run();
      const job = notify(db, "d.admin = 1 AND d.status = 'ok'", [], { title: 'Prüfer-Code benutzt', body: 'Ein Gerät hat sich mit dem Prüfer-Code angemeldet.', url: '#zugaenge' });
      if (ctx) ctx.waitUntil(job); else await job;
      const st = await db.prepare('SELECT status FROM dev WHERE id = ?').bind(d.id).first();
      return st && st.status === 'blocked' ? json({ status: 'blocked', error: 'gesperrt' }, 403) : json({ status: 'ok', admin: false });
    }
    if (!h || h !== ADMIN_HASH) return json({ status: d.status, error: 'falscher Code' }, 403);
    await db.prepare('INSERT INTO dev (id, name, model, status, admin, created, seen) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status, admin = 1, name = COALESCE(NULLIF(excluded.name, \'\'), dev.name)')
      .bind(d.id, String(body.name || '').slice(0, 40), String(body.model || '').slice(0, 40), 'ok', now, now).run();
    return json({ status: 'ok', admin: true });
  }
  if (what === 'vapid') return json({ key: (await vapidKeys(db)).pub });
  if (what === 'push' && request.method === 'POST') {
    if (d.status === 'none' || d.status === 'blocked') return json({ error: 'erst Zugang anfragen' }, 403);
    const sub = body.sub || {};
    if (!/^https:\/\//.test(sub.endpoint || '') || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return json({ error: 'ungültig' }, 400);
    await pushTable(db);
    await db.prepare('INSERT INTO push (endpoint, dev, p256dh, auth, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET dev = excluded.dev, p256dh = excluded.p256dh, auth = excluded.auth')
      .bind(sub.endpoint, d.id, sub.keys.p256dh, sub.keys.auth, now).run();
    if (body.test) await pushTo(db, { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth }, { title: 'Benachrichtigungen sind an', body: d.admin ? 'Neue Zugangsanfragen erscheinen ab jetzt hier.' : 'Du bekommst hier Bescheid, sobald dein Zugang freigegeben ist.' });
    return json({ ok: true });
  }
  if (!d.admin || d.status !== 'ok') return json({ error: 'nur für Verwalter' }, 403);
  if (what === 'list') {
    const { results } = await db.prepare('SELECT id, name, model, status, admin, created, seen FROM dev ORDER BY status = \'pending\' DESC, seen DESC').all();
    return json({ me: d.id, devices: results });
  }
  if (what === 'set' && request.method === 'POST') {
    if (body.id === d.id && (body.status !== 'ok' || body.admin === false)) return json({ error: 'Dich selbst kannst du nicht sperren' }, 400);
    if (body.status === 'delete') { await db.prepare('DELETE FROM dev WHERE id = ?').bind(body.id).run(); await pushTable(db); await db.prepare('DELETE FROM push WHERE dev = ?').bind(body.id).run(); }
    else {
      if (['ok', 'blocked', 'pending'].includes(body.status)) {
        const old = await db.prepare('SELECT status FROM dev WHERE id = ?').bind(body.id).first();
        await db.prepare('UPDATE dev SET status = ? WHERE id = ?').bind(body.status, body.id).run();
        if (body.status === 'ok' && old && old.status === 'pending') {
          const job = notify(db, 'd.id = ?', [body.id], { title: 'Zugang freigegeben', body: 'Du kannst Overland-Navi jetzt nutzen. Tippen zum Öffnen.', url: '' });
          if (ctx) ctx.waitUntil(job); else await job;
        }
      }
      if (typeof body.admin === 'boolean') await db.prepare('UPDATE dev SET admin = ? WHERE id = ?').bind(body.admin ? 1 : 0, body.id).run();
    }
    seenOk.clear();
    return json({ ok: true });
  }
  return json({ error: 'unbekannt' }, 404);
}

let locReady = false;
async function loc(request, env, room, member) {
  if (!env.LOC) return reply(501, 'Standort-Datenbank fehlt (D1-Bindung LOC)');
  const db = env.LOC;
  if (!locReady) {
    await db.prepare('CREATE TABLE IF NOT EXISTS loc (room TEXT NOT NULL, member TEXT NOT NULL, h TEXT NOT NULL, data TEXT NOT NULL, t INTEGER NOT NULL, exp INTEGER NOT NULL, PRIMARY KEY (room, member))').run();
    locReady = true;
  }
  const now = Date.now();
  if (request.method === 'GET' && !member) {
    const { results } = await db.prepare('SELECT member, data, t FROM loc WHERE room = ? AND exp > ?').bind(room, now).all();
    const etag = '"' + results.length + '-' + results.reduce((m, r) => Math.max(m, r.t), 0) + '"';
    if (request.headers.get('If-None-Match') === etag) return reply(304, null, { ETag: etag });
    return reply(200, JSON.stringify(results.map((r) => ({ m: r.member, t: r.t, d: r.data }))), { ETag: etag, 'Content-Type': 'application/json' });
  }
  if (!member) return reply(405, 'nicht erlaubt');
  const token = request.headers.get('X-Write') || '';
  if (token.length < 16) return reply(403, 'nur ansehen');
  const hash = await sha(token);
  const other = await db.prepare('SELECT h FROM loc WHERE room = ? AND exp > ? LIMIT 1').bind(room, now).first();
  if (other && other.h !== hash) return reply(403, 'falscher Schreibschlüssel');
  if (request.method === 'DELETE') {
    await db.prepare('DELETE FROM loc WHERE room = ? AND member = ?').bind(room, member).run();
    return reply(204, null);
  }
  if (request.method !== 'PUT') return reply(405, 'nicht erlaubt');
  const data = await request.text();
  if (data.length > 200000) return reply(413, 'zu groß');
  let exp = Number(new URL(request.url).searchParams.get('bis')) || 0;
  if (!exp || exp > now + 30 * 864e5) exp = now + 2 * 864e5;   // ohne Ende: läuft nach 2 Tagen ohne Meldung ab
  await db.prepare('INSERT INTO loc (room, member, h, data, t, exp) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (room, member) DO UPDATE SET h = excluded.h, data = excluded.data, t = excluded.t, exp = excluded.exp')
    .bind(room, member, hash, data, now, exp).run();
  if (Math.random() < 0.02) await db.prepare('DELETE FROM loc WHERE exp < ?').bind(now).run();   // Abgelaufenes aufräumen
  return reply(200, String(now));
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const path = new URL(request.url).pathname;
    const am = path.match(/^\/auth\/(status|request|admin|list|set|vapid|push)$/);
    if (am) return auth(request, env, am[1], ctx);
    const sm = path.match(/^\/sync\/([a-f0-9]{32})$/);
    if (sm) return (await gate(request, env)) || sync(request, env, sm[1]);
    const lm = path.match(/^\/loc\/([a-f0-9]{32})(?:\/([a-f0-9]{16}))?$/);
    if (lm) return (await gate(request, env)) || loc(request, env, lm[1], lm[2]);
    if (path === '/loc/') return reply(env.LOC ? 200 : 501, env.LOC ? 'Standort bereit' : 'Standort-Datenbank fehlt (D1-Bindung LOC)');
    if (path === '/sync/') return reply(env.SYNC ? 200 : 501, env.SYNC ? 'Sync bereit' : 'Sync-Speicher fehlt (KV-Bindung SYNC)');
    let target = null;
    if (/^\/\d{8}\.pmtiles$/.test(path)) target = 'https://build.protomaps.com' + path;          // Grundkarte, z. B. /20261114.pmtiles
    const m = path.match(/^\/wander\/([a-z0-9-]+\.(?:pmtiles|json))$/);
    if (m) target = WANDER + m[1];                                                                // Wanderwege, z. B. /wander/kirgistan.pmtiles
    if (!target) return new Response('Overland-Navi Kartenproxy', { status: 404, headers: CORS });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('nur lesen', { status: 405, headers: CORS });
    const no = await gate(request, env);
    if (no) return no;

    const headers = new Headers();
    const range = request.headers.get('Range');
    if (range) headers.set('Range', range);
    const upstream = await fetch(target, { method: request.method, headers, redirect: 'follow' });
    const response = new Response(upstream.body, upstream);
    for (const [k, v] of Object.entries(CORS)) response.headers.set(k, v);
    return response;
  }
};

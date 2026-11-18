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

/* ---------- Zugang ---------- */
const ADMIN_HASH = 'aa589afaca59eb6e8cd6d17e06acd21bcab19bda712b0210ac9a24988d0f0975';   // Hash des Verwalter-Codes (der Code selbst steht nirgends)
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
async function auth(request, env, what) {
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
      await db.prepare('INSERT INTO dev (id, name, model, status, admin, created, seen) VALUES (?, ?, ?, ?, 0, ?, ?)')
        .bind(d.id, String(body.name || '').slice(0, 40), String(body.model || '').slice(0, 40), 'pending', now, now).run();
      return json({ status: 'pending' });
    }
    if (d.status === 'pending' && body.name) await db.prepare('UPDATE dev SET name = ?, model = ? WHERE id = ?').bind(String(body.name).slice(0, 40), String(body.model || '').slice(0, 40), d.id).run();
    return json({ status: d.status });
  }
  if (what === 'admin' && request.method === 'POST') {
    const code = String(body.code || '').trim().toUpperCase();
    if (!code || await sha(code) !== ADMIN_HASH) return json({ status: d.status, error: 'falscher Code' }, 403);
    await db.prepare('INSERT INTO dev (id, name, model, status, admin, created, seen) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status, admin = 1, name = COALESCE(NULLIF(excluded.name, \'\'), dev.name)')
      .bind(d.id, String(body.name || '').slice(0, 40), String(body.model || '').slice(0, 40), 'ok', now, now).run();
    return json({ status: 'ok', admin: true });
  }
  if (!d.admin || d.status !== 'ok') return json({ error: 'nur für Verwalter' }, 403);
  if (what === 'list') {
    const { results } = await db.prepare('SELECT id, name, model, status, admin, created, seen FROM dev ORDER BY status = \'pending\' DESC, seen DESC').all();
    return json({ me: d.id, devices: results });
  }
  if (what === 'set' && request.method === 'POST') {
    if (body.id === d.id && (body.status !== 'ok' || body.admin === false)) return json({ error: 'Dich selbst kannst du nicht sperren' }, 400);
    if (body.status === 'delete') await db.prepare('DELETE FROM dev WHERE id = ?').bind(body.id).run();
    else {
      if (['ok', 'blocked', 'pending'].includes(body.status)) await db.prepare('UPDATE dev SET status = ? WHERE id = ?').bind(body.status, body.id).run();
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
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const path = new URL(request.url).pathname;
    const am = path.match(/^\/auth\/(status|request|admin|list|set)$/);
    if (am) return auth(request, env, am[1]);
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

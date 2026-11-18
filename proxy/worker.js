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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-Match, If-None-Match, X-Write, Content-Type',
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
    const sm = path.match(/^\/sync\/([a-f0-9]{32})$/);
    if (sm) return sync(request, env, sm[1]);
    const lm = path.match(/^\/loc\/([a-f0-9]{32})(?:\/([a-f0-9]{16}))?$/);
    if (lm) return loc(request, env, lm[1], lm[2]);
    if (path === '/loc/') return reply(env.LOC ? 200 : 501, env.LOC ? 'Standort bereit' : 'Standort-Datenbank fehlt (D1-Bindung LOC)');
    if (path === '/sync/') return reply(env.SYNC ? 200 : 501, env.SYNC ? 'Sync bereit' : 'Sync-Speicher fehlt (KV-Bindung SYNC)');
    let target = null;
    if (/^\/\d{8}\.pmtiles$/.test(path)) target = 'https://build.protomaps.com' + path;          // Grundkarte, z. B. /20261114.pmtiles
    const m = path.match(/^\/wander\/([a-z0-9-]+\.(?:pmtiles|json))$/);
    if (m) target = WANDER + m[1];                                                                // Wanderwege, z. B. /wander/kirgistan.pmtiles
    if (!target) return new Response('Overland-Navi Kartenproxy', { status: 404, headers: CORS });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('nur lesen', { status: 405, headers: CORS });

    const headers = new Headers();
    const range = request.headers.get('Range');
    if (range) headers.set('Range', range);
    const upstream = await fetch(target, { method: request.method, headers, redirect: 'follow' });
    const response = new Response(upstream.body, upstream);
    for (const [k, v] of Object.entries(CORS)) response.headers.set(k, v);
    return response;
  }
};

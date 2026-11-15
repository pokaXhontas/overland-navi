// Overland-Navi: Zwischenstation für Kartendateien.
// Die Kartenserver erlauben keine direkten Zugriffe aus Web-Apps (fehlende CORS-Freigabe).
// Dieser Cloudflare Worker reicht nur Kartenanfragen durch und ergänzt die Freigabe.
// Einfügen unter Cloudflare → Workers & Pages → ovl-karte → Code bearbeiten → alles ersetzen → Bereitstellen.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-Match',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, ETag, Accept-Ranges',
  'Access-Control-Max-Age': '86400'
};

// Wanderwege: Dateien aus den GitHub-Downloads des App-Projekts
const WANDER = 'https://github.com/pokaXhontas/overland-navi/releases/download/wanderwege/';

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const path = new URL(request.url).pathname;
    let target = null;
    if (/^\/\d{8}\.pmtiles$/.test(path)) target = 'https://build.protomaps.com' + path;          // Grundkarte, z. B. /20261114.pmtiles
    const m = path.match(/^\/wander\/([a-z0-9-]+\.(?:pmtiles|json))$/);
    if (m) target = WANDER + m[1];                                                                // Wanderwege, z. B. /wander/kirgistan.pmtiles
    if (!target) return new Response('Overland-Navi Kartenproxy', { status: 404, headers: CORS });

    const headers = new Headers();
    const range = request.headers.get('Range');
    if (range) headers.set('Range', range);
    const upstream = await fetch(target, { method: request.method, headers, redirect: 'follow' });
    const response = new Response(upstream.body, upstream);
    for (const [k, v] of Object.entries(CORS)) response.headers.set(k, v);
    return response;
  }
};

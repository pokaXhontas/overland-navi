// Overland-Navi: Zwischenstation für die Protomaps-Karte.
// Der Protomaps-Server erlaubt keine Zugriffe aus Web-Apps (fehlende CORS-Freigabe).
// Dieser Cloudflare Worker reicht nur Kartenanfragen durch und ergänzt die Freigabe.
// Einfügen unter Cloudflare → Workers & Pages → Worker erstellen → Code bearbeiten → Bereitstellen.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-Match',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, ETag, Accept-Ranges',
  'Access-Control-Max-Age': '86400'
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    // nur Tagesstände der Karte, z. B. /20261114.pmtiles
    if (!/^\/\d{8}\.pmtiles$/.test(url.pathname)) {
      return new Response('Overland-Navi Kartenproxy', { status: 404, headers: CORS });
    }
    const headers = new Headers();
    const range = request.headers.get('Range');
    if (range) headers.set('Range', range);
    const upstream = await fetch('https://build.protomaps.com' + url.pathname, { method: request.method, headers });
    const response = new Response(upstream.body, upstream);
    for (const [k, v] of Object.entries(CORS)) response.headers.set(k, v);
    return response;
  }
};

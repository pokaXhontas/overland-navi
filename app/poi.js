/* In der Nähe: Supermärkte, Restaurants, Geldautomaten … im Kartenausschnitt oder in einem Ort.
 * Online aus OpenStreetMap (Overpass) mit Öffnungszeiten, Telefon, Website; offline aus den Kartenkacheln (nur Name). */
'use strict';

const POI_CATS = [
  { id: 'supermarket', nom: ['supermarket'], types: ['supermarket', 'wholesale'], label: 'Supermärkte', one: 'Supermarkt', color: '#2F9E44', q: ['nwr["shop"~"^(supermarket|wholesale)$"]'], pm: ['supermarket'],
    words: ['supermarkt', 'supermärkte', 'einkaufen', 'lebensmittel', 'supermarket'], d: 'M3 4h2l2.4 11h10.2L20 7H6.3M9 20h.01M17 20h.01' },
  { id: 'shop', nom: ['convenience store', 'bakery', 'kiosk'], types: ['convenience', 'general', 'kiosk', 'greengrocer', 'bakery', 'butcher'], label: 'Läden & Kioske', one: 'Laden', color: '#5C940D', q: ['nwr["shop"~"^(convenience|general|kiosk|greengrocer|bakery|butcher)$"]'], pm: ['convenience', 'bakery'],
    words: ['laden', 'kiosk', 'bäcker', 'bäckerei', 'späti', 'tante emma', 'shop', 'magazin'], d: 'M4 9h16l-1 11H5ZM8 9V7a4 4 0 0 1 8 0v2' },
  { id: 'market', nom: ['marketplace'], types: ['marketplace'], label: 'Märkte', one: 'Markt', color: '#E8590C', q: ['nwr["amenity"="marketplace"]'], pm: ['marketplace'],
    words: ['markt', 'märkte', 'basar', 'bazar', 'basar', 'market'], d: 'M3 10h18l-2-6H5ZM5 10v10h14V10M9 20v-5h6v5' },
  { id: 'restaurant', nom: ['restaurant', 'fast food'], types: ['restaurant', 'fast_food', 'food_court'], label: 'Restaurants', one: 'Restaurant', color: '#C2255C', q: ['nwr["amenity"~"^(restaurant|fast_food|food_court)$"]'], pm: ['restaurant', 'fast_food'],
    words: ['restaurant', 'restaurants', 'essen', 'imbiss', 'fast food', 'lokal', 'gaststätte'], d: 'M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M16 21V3c-2 1-3 4-3 8h3' },
  { id: 'cafe', nom: ['cafe'], types: ['cafe'], label: 'Cafés', one: 'Café', color: '#8B5A2B', q: ['nwr["amenity"="cafe"]'], pm: ['cafe'],
    words: ['café', 'cafe', 'kaffee', 'coffee'], d: 'M4 9h12v5a5 5 0 0 1-10 0ZM16 10h2a2 2 0 0 1 0 4h-2M8 3v3M12 3v3' },
  { id: 'atm', nom: ['atm'], types: ['atm', 'bank'], label: 'Geldautomaten', one: 'Geldautomat', color: '#1C6DD0', q: ['nwr["amenity"="atm"]', 'nwr["amenity"="bank"]["atm"="yes"]'], pm: ['atm'],
    words: ['geldautomat', 'geldautomaten', 'atm', 'bankautomat', 'bargeld', 'geld abheben'], d: 'M3 6h18v12H3ZM3 10h18M7 15h3' },
  { id: 'bank', nom: ['bank', 'bureau de change'], types: ['bank', 'bureau_de_change', 'money_transfer'], label: 'Banken & Wechselstuben', one: 'Bank', color: '#364FC7', q: ['nwr["amenity"~"^(bank|bureau_de_change|money_transfer)$"]'], pm: ['bank', 'bureau_de_change'],
    words: ['bank', 'banken', 'wechselstube', 'geld wechseln', 'exchange', 'wechsel'], d: 'M3 10 12 4l9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18' },
  { id: 'fuel', nom: ['fuel'], types: ['fuel'], label: 'Tankstellen', one: 'Tankstelle', color: '#495057', q: ['nwr["amenity"="fuel"]'], pm: ['fuel'],
    words: ['tankstelle', 'tankstellen', 'tanken', 'diesel', 'benzin', 'fuel'], d: 'M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M4 10h10M14 8l3 3v6a1.5 1.5 0 0 0 3 0V9l-3-3' },
  { id: 'repair', nom: ['car repair', 'tyres'], types: ['car_repair', 'tyres', 'car_parts', 'vehicle_inspection'], label: 'Werkstätten & Reifen', one: 'Werkstatt', color: '#6741D9', q: ['nwr["shop"~"^(car_repair|tyres|car_parts)$"]', 'nwr["amenity"="vehicle_inspection"]'], pm: ['car_repair'],
    words: ['werkstatt', 'werkstätten', 'reifen', 'mechaniker', 'autowerkstatt', 'ersatzteile', 'reparatur'], d: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4Z' },
  { id: 'hardware', nom: ['hardware store', 'doityourself'], types: ['hardware', 'doityourself', 'outdoor'], label: 'Baumärkte', one: 'Baumarkt', color: '#A61E4D', q: ['nwr["shop"~"^(hardware|doityourself|outdoor)$"]'], pm: ['hardware', 'doityourself'],
    words: ['baumarkt', 'eisenwaren', 'werkzeug', 'outdoor', 'hardware'], d: 'M14 4l6 6-3 3-6-6ZM11 7l-8 8 3 3 8-8' },
  { id: 'pharmacy', nom: ['pharmacy'], types: ['pharmacy'], label: 'Apotheken', one: 'Apotheke', color: '#E03131', q: ['nwr["amenity"="pharmacy"]'], pm: ['pharmacy'],
    words: ['apotheke', 'apotheken', 'pharmacy', 'medikamente'], d: 'M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6Z' },
  { id: 'doctor', nom: ['hospital', 'clinic', 'doctors'], types: ['hospital', 'clinic', 'doctors', 'dentist'], label: 'Ärzte & Kliniken', one: 'Arzt', color: '#C92A2A', q: ['nwr["amenity"~"^(hospital|clinic|doctors|dentist)$"]'], pm: ['hospital', 'clinic', 'doctors', 'dentist'],
    words: ['arzt', 'ärzte', 'krankenhaus', 'klinik', 'hospital', 'zahnarzt', 'notaufnahme'], d: 'M12 21s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.6-7 10-7 10ZM12 9v5M9.5 11.5h5' },
  { id: 'water', nom: ['drinking water'], types: ['drinking_water', 'water_point'], label: 'Trinkwasser', one: 'Trinkwasser', color: '#1C7ED6', q: ['nwr["amenity"~"^(drinking_water|water_point)$"]'], pm: ['drinking_water'],
    words: ['wasser', 'trinkwasser', 'water'], d: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z' },
  { id: 'laundry', nom: ['laundry'], types: ['laundry', 'dry_cleaning'], label: 'Wäschereien', one: 'Wäscherei', color: '#0B7285', q: ['nwr["shop"~"^(laundry|dry_cleaning)$"]'], pm: ['laundry'],
    words: ['wäscherei', 'waschsalon', 'laundry', 'wäsche'], d: 'M5 3h14v18H5ZM5 7h14M12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z' },
  { id: 'toilets', nom: ['toilets', 'shower'], types: ['toilets', 'shower'], label: 'Toiletten & Duschen', one: 'Toilette', color: '#868E96', q: ['nwr["amenity"~"^(toilets|shower)$"]'], pm: ['toilets'],
    words: ['toilette', 'toiletten', 'wc', 'dusche', 'duschen', 'shower'], d: 'M7 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM17 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM5 21v-6H4l1.5-6h3L10 15H9v6M15 21V9h4v12M12 3v18' },
  { id: 'mobile', nom: ['mobile phone shop'], types: ['mobile_phone', 'telecommunication'], label: 'SIM-Karten & Handyläden', one: 'Handyladen', color: '#1098AD', q: ['nwr["shop"~"^(mobile_phone|telecommunication)$"]'], pm: ['mobile_phone', 'electronics'],
    words: ['sim', 'simkarte', 'sim-karte', 'handy', 'handyladen', 'mobilfunk', 'telefon'], d: 'M7 2h10v20H7ZM11 18h2' },
  { id: 'post', nom: ['post office'], types: ['post_office'], label: 'Post', one: 'Post', color: '#F59F00', q: ['nwr["amenity"="post_office"]'], pm: ['post_office'],
    words: ['post', 'postamt', 'paket'], d: 'M3 6h18v12H3ZM3 6l9 7 9-7' },
  { id: 'camp', nom: ['camp site', 'hotel', 'hostel', 'guest house'], types: ['camp_site', 'caravan_site', 'hostel', 'guest_house', 'motel', 'hotel'], label: 'Camping & Unterkünfte', one: 'Unterkunft', color: '#2B8A3E', q: ['nwr["tourism"~"^(camp_site|caravan_site|hostel|guest_house|motel|hotel)$"]'], pm: ['camp_site', 'hotel', 'hostel'],
    words: ['camping', 'campingplatz', 'hotel', 'hostel', 'gästehaus', 'unterkunft', 'übernachten', 'pension'], d: 'M3 20h18M5 20V10l7-6 7 6v10M10 20v-5h4v5' }
];
const POI = Object.fromEntries(POI_CATS.map((c) => [c.id, c]));
const POI_GENERIC = { id: 'poi', label: 'Orte', one: 'Ort', color: '#7048E8', d: 'M12 21s6-5.4 6-10.5a6 6 0 0 0-12 0C6 15.6 12 21 12 21ZM12 10.5h.01' };
// OSM-Schlüssel, die eine Einrichtung beschreiben (kein Ort, Berg oder See)
const POI_KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'craft', 'office', 'healthcare', 'club'];
const POI_EXTRA_KIND = { museum: 'Museum', attraction: 'Sehenswürdigkeit', viewpoint: 'Aussichtspunkt', bar: 'Bar', pub: 'Kneipe', ice_cream: 'Eisdiele',
  clothes: 'Bekleidung', mall: 'Einkaufszentrum', department_store: 'Kaufhaus', electronics: 'Elektronik', car: 'Autohaus', bicycle: 'Fahrradladen',
  sports: 'Sportgeschäft', books: 'Buchhandlung', police: 'Polizei', embassy: 'Botschaft', place_of_worship: 'Gotteshaus', parking: 'Parkplatz',
  bus_station: 'Busbahnhof', car_wash: 'Autowäsche', car_rental: 'Autovermietung', veterinary: 'Tierarzt', gym: 'Fitnessstudio', fitness_centre: 'Fitnessstudio',
  theatre: 'Theater', cinema: 'Kino', library: 'Bibliothek', school: 'Schule', university: 'Universität', townhall: 'Rathaus', park: 'Park', bakery: 'Bäckerei',
  information: 'Touristeninfo', zoo: 'Zoo', spa: 'Wellness', swimming_pool: 'Schwimmbad', sauna: 'Sauna', beauty: 'Kosmetik', hairdresser: 'Friseur' };

/* Kategorie zu einem OSM-Merkmal (z. B. amenity=restaurant) */
function poiCatFor(key, value) {
  if (!POI_KEYS.includes(key)) return null;
  const c = POI_CATS.find((x) => x.types.includes(value));
  return c || POI_GENERIC;
}
function poiKindName(value) {
  return POI_KIND[value] || POI_EXTRA_KIND[value] || String(value || '').replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase());
}
const POI_OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const POI_KIND = {
  supermarket: 'Supermarkt', wholesale: 'Großmarkt', convenience: 'Laden', general: 'Gemischtwaren', kiosk: 'Kiosk', greengrocer: 'Obst und Gemüse',
  bakery: 'Bäckerei', butcher: 'Metzger', marketplace: 'Markt', restaurant: 'Restaurant', fast_food: 'Imbiss', food_court: 'Essensstände', cafe: 'Café',
  atm: 'Geldautomat', bank: 'Bank', bureau_de_change: 'Wechselstube', money_transfer: 'Geldtransfer', fuel: 'Tankstelle', car_repair: 'Werkstatt',
  tyres: 'Reifen', car_parts: 'Autoteile', vehicle_inspection: 'Fahrzeugprüfung', hardware: 'Eisenwaren', doityourself: 'Baumarkt', outdoor: 'Outdoorladen',
  pharmacy: 'Apotheke', hospital: 'Krankenhaus', clinic: 'Klinik', doctors: 'Arzt', dentist: 'Zahnarzt', drinking_water: 'Trinkwasser', water_point: 'Wasserstelle',
  laundry: 'Wäscherei', dry_cleaning: 'Reinigung', toilets: 'Toilette', shower: 'Dusche', mobile_phone: 'Handyladen', telecommunication: 'Mobilfunk',
  post_office: 'Post', camp_site: 'Campingplatz', caravan_site: 'Wohnmobilplatz', hostel: 'Hostel', guest_house: 'Gästehaus', motel: 'Motel', hotel: 'Hotel'
};
const POI_DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const POI_DAYS_DE = { Mo: 'Mo', Tu: 'Di', We: 'Mi', Th: 'Do', Fr: 'Fr', Sa: 'Sa', Su: 'So', PH: 'Feiertag' };

/* Öffnungszeiten (häufige Formen): true = offen, false = zu, null = unklar */
function poiOpenNow(oh, now = new Date()) {
  if (!oh) return null;
  const s = oh.trim();
  if (s === '24/7') return true;
  const day = POI_DAYS[now.getDay()];
  const prev = POI_DAYS[(now.getDay() + 6) % 7];
  const mins = now.getHours() * 60 + now.getMinutes();
  const inDays = (spec, d) => {
    if (!spec) return true;
    return spec.split(',').some((part) => {
      const m = part.trim().match(/^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/);
      if (!m) return false;
      const order = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
      const a = order.indexOf(m[1]), b = m[2] ? order.indexOf(m[2]) : a, x = order.indexOf(d);
      return a <= b ? x >= a && x <= b : x >= a || x <= b;
    });
  };
  let result = null, understood = false;
  for (const rule of s.split(';')) {
    const r = rule.trim();
    if (!r) continue;
    const m = r.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?)+)?\s*(off|closed|(?:\d{1,2}:\d{2}-\d{1,2}:\d{2}\+?,?\s*)+)$/);
    if (!m) { if (/PH|SH|week|[A-Z][a-z]{2} \d/.test(r)) continue; return null; }
    understood = true;
    const days = m[1] ? m[1].replace(/,$/, '') : null;
    const times = m[2];
    if (inDays(days, day)) {
      if (/off|closed/.test(times)) { result = false; continue; }
      result = times.split(',').some((t) => {
        const tm = t.trim().match(/(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/);
        if (!tm) return false;
        const a = +tm[1] * 60 + +tm[2], b = +tm[3] * 60 + +tm[4];
        return b > a ? mins >= a && mins < b : mins >= a || mins < b;
      });
    } else if (inDays(days, prev) && !/off|closed/.test(times)) {
      // über Mitternacht vom Vortag
      const late = times.split(',').some((t) => {
        const tm = t.trim().match(/(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/);
        if (!tm) return false;
        const a = +tm[1] * 60 + +tm[2], b = +tm[3] * 60 + +tm[4];
        return b < a && mins < b;
      });
      if (late) result = true;
    }
  }
  if (!understood) return null;
  return result === null ? false : result;
}

function poiHours(oh) {
  return String(oh || '').replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, (d) => POI_DAYS_DE[d]).replace(/\boff\b/g, 'geschlossen').replace(/;\s*/g, '\n');
}

const Poi = {
  results: [],
  cat: null,
  where: '',
  popup: null,
  busy: false,

  /* Kategorie in einer Eingabe erkennen, z. B. „Supermarkt in Osch“ */
  match(q) {
    const t = norm(q);
    if (t.length < 2) return [];
    const m = t.match(/^(.+?)\s+(?:in|bei|nahe|near|um)\s+(.+)$/);
    const what = m ? m[1] : t;
    const place = m ? q.trim().slice(q.trim().length - m[2].length) : '';
    const hits = POI_CATS.filter((c) => c.words.some((w) => norm(w) === what || (what.length >= 3 && norm(w).startsWith(what))));
    return hits.slice(0, 3).map((c) => ({ cat: c, place }));
  },

  async geocode(place) {
    const local = Search.query(place).filter((r) => r.type !== 'coord');
    const town = local.find((r) => ['city', 'town', 'village', 'suburb', 'hamlet'].includes(r.type)) || local[0];
    if (town) return { lat: town.lat, lon: town.lon, name: town.name };
    const web = await Search.online(place);
    return web[0] ? { lat: web[0].lat, lon: web[0].lon, name: web[0].name } : null;
  },

  center() {
    const c = map.getCenter();
    const b = map.getBounds();
    const r = distance({ lat: c.lat, lon: c.lng }, { lat: b.getNorth(), lon: b.getEast() });
    // weit herausgezoomt: um den eigenen Standort, sonst Kartenausschnitt
    if (map.getZoom() < 10 && gps.pos) return { lat: gps.pos.lat, lon: gps.pos.lon, r: 5000, name: 'deinem Standort' };
    return { lat: c.lat, lon: c.lng, r: Math.max(1500, Math.min(12000, r)), name: 'im Kartenausschnitt' };
  },

  errors: [],
  async overpass(cat, at) {
    const body = '[out:json][timeout:25];(' + cat.q.map((q) => `${q}(around:${Math.round(at.r)},${at.lat.toFixed(5)},${at.lon.toFixed(5)});`).join('') + ');out center tags 200;';
    for (const u of POI_OVERPASS) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 12000);
        const r = await originalFetch(u, { method: 'POST', body: 'data=' + encodeURIComponent(body), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
        clearTimeout(timer);
        if (!r.ok) { this.errors.push(u.split('/')[2] + ': HTTP ' + r.status); continue; }
        const j = await r.json();
        return (j.elements || []).map((e) => {
          const lat = e.lat !== undefined ? e.lat : e.center && e.center.lat;
          const lon = e.lon !== undefined ? e.lon : e.center && e.center.lon;
          return lat === undefined ? null : { lat, lon, tags: e.tags || {}, osm: e.type + '/' + e.id };
        }).filter(Boolean);
      } catch (e) { this.errors.push(u.split('/')[2] + ': ' + (e.name === 'AbortError' ? 'Zeitüberschreitung' : e.message)); }
    }
    return null;
  },

  /* Nominatim (OpenStreetMap-Suche): schnell und mit Öffnungszeiten, Telefon, Website; höchstens 1 Anfrage pro Sekunde */
  async nominatim(cat, at) {
    const dLat = at.r / 111195, dLon = at.r / (111195 * Math.cos(at.lat * Math.PI / 180));
    const box = [at.lon - dLon, at.lat + dLat, at.lon + dLon, at.lat - dLat].map((v) => v.toFixed(5)).join(',');
    const seen = new Map();
    let ok = false;
    for (let i = 0; i < cat.nom.length; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1100));
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cat.nom[i])}&viewbox=${box}&bounded=1&extratags=1&addressdetails=1&format=jsonv2&limit=50&accept-language=de`;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 15000);
        const r = await originalFetch(url, { signal: ctl.signal });
        clearTimeout(timer);
        if (!r.ok) { this.errors.push('nominatim: HTTP ' + r.status); continue; }
        ok = true;
        for (const x of await r.json()) {
          if (!cat.types.includes(x.type)) continue;
          const a = x.address || {};
          const tags = { ...(x.extratags || {}), [x.category]: x.type };
          if (x.name) tags.name = x.name;
          if (a.road && !tags['addr:street']) tags['addr:street'] = a.road;
          if (a.house_number && !tags['addr:housenumber']) tags['addr:housenumber'] = a.house_number;
          if (!tags['addr:city']) tags['addr:city'] = a.city || a.town || a.village || '';
          seen.set(x.osm_type + x.osm_id, { lat: +x.lat, lon: +x.lon, tags, osm: x.osm_type + '/' + x.osm_id });
        }
      } catch (e) { this.errors.push('nominatim: ' + (e.name === 'AbortError' ? 'Zeitüberschreitung' : e.message)); }
    }
    return ok ? [...seen.values()] : null;
  },

  /* offline: was in den geladenen Kartenkacheln steht (nur Name und Art) */
  offline(cat, at) {
    let feats = [];
    try { feats = map.querySourceFeatures('protomaps', { sourceLayer: 'pois' }); } catch (e) { feats = []; }
    const seen = new Set();
    const out = [];
    for (const f of feats) {
      const p = f.properties || {};
      if (!cat.pm.includes(p.kind) || f.geometry.type !== 'Point') continue;
      const [lon, lat] = f.geometry.coordinates;
      const key = (p.name || '') + lon.toFixed(4) + lat.toFixed(4);
      if (seen.has(key)) continue;
      seen.add(key);
      if (distance(at, { lat, lon }) > at.r) continue;
      out.push({ lat, lon, tags: { name: p['name:de'] || p.name, [cat.id === 'atm' ? 'amenity' : 'shop']: p.kind }, offline: true });
    }
    return out;
  },

  async run(cat, place) {
    if (this.busy) return;
    $('#search-cats').hidden = true;
    let at = this.center();
    if (place) {
      renderSearchResults([], `Suche „${place}“ …`);
      const g = await this.geocode(place);
      if (!g) { renderSearchResults([], `„${place}“ nicht gefunden.`); return; }
      at = { lat: g.lat, lon: g.lon, r: 6000, name: 'in ' + g.name };
    }
    this.busy = true;
    renderSearchResults([], `${cat.label} ${at.name} werden gesucht …`);
    this.errors = [];
    let list = navigator.onLine ? await this.nominatim(cat, at) : null;
    if (!list && navigator.onLine) list = await this.overpass(cat, at);
    let note = '';
    if (!list) {
      list = this.offline(cat, at);
      note = navigator.onLine ? 'Server gerade nicht erreichbar, zeige Treffer aus der Karte (ohne Details).' : 'Offline: nur Treffer aus geladenen Kartengebieten, ohne Öffnungszeiten. Zoom ggf. näher heran.';
    }
    this.busy = false;
    const ref = gps.pos && distance(gps.pos, at) < at.r * 1.5 ? gps.pos : at;
    this.cat = cat;
    this.where = at.name;
    this.results = list.map((p, i) => ({ ...p, i, dist: distance(ref, p), open: poiOpenNow(p.tags.opening_hours) }))
      .sort((a, b) => a.dist - b.dist).slice(0, 80);
    this.results.forEach((p, i) => { p.i = i; });
    Search.remember({ kind: 'cat', cat: cat.id, place: place || '', name: cat.label + (place ? ' in ' + place : ''), sub: place ? '' : 'in der Nähe' });
    this.draw();
    this.renderList(note);
  },

  label(p) {
    const t = p.tags;
    return t.name || t.brand || t.operator || POI_KIND[t.shop || t.amenity || t.tourism] || (p.cat || this.cat || POI_GENERIC).one;
  },

  sub(p) {
    const t = p.tags;
    const kind = POI_KIND[t.shop || t.amenity || t.tourism] || '';
    const bits = [];
    if (kind && kind !== this.label(p)) bits.push(kind);
    if (t.cuisine) bits.push(t.cuisine.split(';').slice(0, 2).join(', ').replace(/_/g, ' '));
    if (p.open === true) bits.push('jetzt geöffnet');
    else if (p.open === false) bits.push('jetzt geschlossen');
    else if (t.opening_hours) bits.push(poiHours(t.opening_hours).split('\n')[0]);
    return bits.join(' · ');
  },

  renderList(note) {
    const cat = this.cat;
    const n = this.results.length;
    const head = n ? `${n} ${n === 1 ? cat.one : cat.label} ${this.where}${note ? '. ' + note : ''}` : `Keine ${cat.label} ${this.where} gefunden.${note ? ' ' + note : ''} Verschieb die Karte oder zoom heraus.`;
    renderResultList($('#search-results'), this.results.map((p) => ({ name: this.label(p), sub: this.sub(p), dist: p.dist, lat: p.lat, lon: p.lon, color: cat.color, icon: cat.d, poi: p })), head, (r) => {
      closeSearch();
      this.focus(r.poi);
    });
    if (n) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn wide poi-all';
      b.textContent = 'Alle auf der Karte zeigen';
      b.onclick = () => { closeSearch(); this.fitAll(); };
      $('#search-results').insertBefore(b, $('#search-results').children[1] || null);
    }
  },

  geojson() {
    return { type: 'FeatureCollection', features: this.results.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { i: p.i, cat: this.cat ? this.cat.id : '', name: this.label(p), open: p.open === true ? 1 : p.open === false ? 0 : -1 } })) };
  },
  source() { return { type: 'geojson', data: this.geojson() }; },
  layers(dark) {
    const halo = dark ? '#0B0F12' : '#FFFFFF';
    return [
      { id: 'poi-icon', type: 'symbol', source: 'poi',
        layout: { 'icon-image': ['concat', 'poi-', ['get', 'cat']], 'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.75, 15, 1],
          'text-field': ['step', ['zoom'], '', 14, ['get', 'name']], 'text-font': ['Noto Sans Medium'], 'text-size': 11.5, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 9 },
        paint: { 'icon-opacity': ['case', ['==', ['get', 'open'], 0], 0.55, 1], 'text-color': dark ? '#E9EEF1' : '#15191D', 'text-halo-color': halo, 'text-halo-width': 1.6 } }
    ];
  },

  draw() {
    const src = map.getSource('poi');
    if (src) src.setData(this.geojson()); else refreshStyle();
    const pill = $('#poi-pill');
    pill.hidden = !this.results.length;
    pill.querySelector('span').textContent = `${this.results.length} ${this.cat ? this.cat.label : ''}`;
  },

  clear() {
    this.results = [];
    this.draw();
    if (this.popup) this.popup.remove();
  },

  fitAll() {
    if (!this.results.length) return;
    const b = new maplibregl.LngLatBounds();
    for (const p of this.results) b.extend([p.lon, p.lat]);
    gps.follow = false; $('#btn-locate').classList.remove('active');
    map.fitBounds(b, { padding: { top: 110, bottom: 90, left: 50, right: 90 }, maxZoom: 16, duration: 700 });
  },

  focus(p) {
    gps.follow = false; $('#btn-locate').classList.remove('active');
    map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 16), duration: 700 });
    this.show(p);
  },

  show(p) {
    const t = p.tags;
    const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const cat = p.cat || this.cat || POI_GENERIC;
    const kind = POI_KIND[t.shop || t.amenity || t.tourism] || p.kind || cat.one;
    const addr = [[t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' '), [t['addr:postcode'], t['addr:city']].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const phone = t.phone || t['contact:phone'];
    const web = t.website || t['contact:website'] || t.url;
    const pay = [];
    if (t['payment:cash'] === 'yes') pay.push('bar');
    if (t['payment:cards'] === 'yes' || t['payment:credit_cards'] === 'yes' || t['payment:visa'] === 'yes' || t['payment:mastercard'] === 'yes') pay.push('Karte');
    if (t['payment:cards'] === 'no' || t['payment:credit_cards'] === 'no') pay.push('keine Karten');
    const yn = (v) => ({ yes: 'ja', no: 'nein', limited: 'eingeschränkt' }[v] || v);
    const fuels = Object.keys(t).filter((k) => /^fuel:/.test(k) && t[k] === 'yes').map((k) => k.slice(5).replace('_', ' '));
    const rows = [
      ['Art', kind],
      ['Öffnungszeiten', t.opening_hours ? poiHours(t.opening_hours) : ''],
      ['Adresse', addr],
      ['Küche', t.cuisine ? t.cuisine.replace(/;/g, ', ').replace(/_/g, ' ') : ''],
      ['Marke', t.brand && t.brand !== t.name ? t.brand : ''],
      ['Betreiber', t.operator && t.operator !== t.name && t.operator !== t.brand ? t.operator : ''],
      ['Bezahlen', pay.join(', ')],
      ['Bargeld einzahlen', t.cash_in ? yn(t.cash_in) : ''],
      ['Gebühr', t.fee ? yn(t.fee) : ''],
      ['Kraftstoff', fuels.join(', ')],
      ['Rollstuhl', t.wheelchair ? yn(t.wheelchair) : ''],
      ['Draußen sitzen', t.outdoor_seating ? yn(t.outdoor_seating) : ''],
      ['WLAN', t.internet_access ? (t.internet_access === 'no' ? 'nein' : 'ja') : '']
    ].filter((r) => r[1]);
    const status = p.open === true ? '<span class="poi-open">Jetzt geöffnet</span>' : p.open === false ? '<span class="poi-closed">Jetzt geschlossen</span>' : '';
    const links = [
      phone ? `<a class="btn small-btn" href="tel:${esc(phone.split(';')[0].replace(/\s/g, ''))}">Anrufen</a>` : '',
      web && /^https?:\/\//.test(web) ? `<a class="btn small-btn" href="${esc(web)}" target="_blank" rel="noopener">Website</a>` : ''
    ].filter(Boolean).join('');
    const html = `<div class="hk-pop">
      <div class="hk-head"><span class="hk-badge" style="background:${cat.color}"><svg viewBox="0 0 24 24" aria-hidden="true" class="poi-ico"><path d="${cat.d}"/></svg></span><b>${esc(this.label(p))}</b></div>
      ${status}
      ${rows.map((r) => `<div class="hk-row"><span>${r[0]}</span><b>${esc(r[1]).replace(/\n/g, '<br>')}</b></div>`).join('')}
      ${p.offline ? '<p class="small">Offline nur Name und Art. Mit Internet gibt es Öffnungszeiten, Telefon und mehr.</p>' : '<p class="small">Angaben aus OpenStreetMap, vor Ort können sie abweichen.</p>'}
      ${links ? `<div class="hk-actions">${links}</div>` : ''}
      <div class="hk-actions"><button type="button" class="btn small-btn" data-a="save">Speichern</button><button type="button" class="btn primary small-btn" data-a="nav">Hierhin</button></div>
    </div>`;
    if (this.popup) this.popup.remove();
    if (Hike.popup) Hike.popup.remove();
    this.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '300px', className: 'hk-popup' }).setLngLat([p.lon, p.lat]).setHTML(html).addTo(map);
    $('#poi-pill').hidden = true;
    this.popup.on('close', () => { $('#poi-pill').hidden = !this.results.length; });
    const el = this.popup.getElement();
    el.querySelector('[data-a="nav"]').onclick = () => { this.popup.remove(); Nav.choose({ lon: p.lon, lat: p.lat, name: this.label(p) }); };
    el.querySelector('[data-a="save"]').onclick = () => {
      this.popup.remove();
      openEditor(null, { lat: p.lat, lon: p.lon });
      editor.draft.name = this.label(p);
      editor.draft.note = rows.map((r) => r[0] + ': ' + r[1].replace(/\n/g, ', ')).concat(phone ? ['Telefon: ' + phone] : [], web ? ['Website: ' + web] : []).join('\n');
      $('#spot-name').value = editor.draft.name;
      $('#spot-note').value = editor.draft.note;
    };
  },

  /* Einzelne Einrichtung aus der Suche: Details nachladen und Infofenster zeigen */
  async open(r) {
    gps.follow = false; $('#btn-locate').classList.remove('active');
    map.flyTo({ center: [r.lon, r.lat], zoom: Math.max(map.getZoom(), 16.5), duration: 700 });
    const cat = r.poiCat ? POI[r.poiCat] || POI_GENERIC : POI_GENERIC;
    let p = { lat: r.lat, lon: r.lon, tags: { name: r.name, [r.osmKey || 'amenity']: r.osmValue || '' }, cat, kind: r.kind, offline: !navigator.onLine };
    if (navigator.onLine && r.osmRef) {
      try {
        const u = `https://nominatim.openstreetmap.org/lookup?osm_ids=${r.osmRef}&extratags=1&addressdetails=1&format=jsonv2&accept-language=de`;
        const x = (await (await originalFetch(u)).json())[0];
        if (x) {
          const a = x.address || {};
          const tags = { ...(x.extratags || {}), [x.category]: x.type, name: x.name || r.name };
          if (a.road && !tags['addr:street']) tags['addr:street'] = a.road;
          if (a.house_number && !tags['addr:housenumber']) tags['addr:housenumber'] = a.house_number;
          if (!tags['addr:city']) tags['addr:city'] = a.city || a.town || a.village || '';
          p = { lat: +x.lat, lon: +x.lon, tags, cat, kind: r.kind };
        }
      } catch (e) { /* mit dem zeigen, was die Suche lieferte */ }
    }
    p.open = poiOpenNow(p.tags.opening_hours);
    this.show(p);
  },

  /* Kategorien-Leiste in der Suche */
  renderChips() {
    const box = $('#search-cats');
    if (box.childElementCount) return;
    for (const c of POI_CATS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'poi-chip';
      b.innerHTML = `<span style="background:${c.color}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${c.d}"/></svg></span>${c.label}`;
      b.onclick = () => this.run(c);
      box.appendChild(b);
    }
  },

  image(id) {
    const c = POI[id];
    const ratio = 2, size = 34;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size * ratio;
    const g = cv.getContext('2d');
    g.scale(ratio, ratio);
    g.beginPath();
    g.arc(size / 2, size / 2, 14, 0, Math.PI * 2);
    g.fillStyle = c.color;
    g.fill();
    g.lineWidth = 2.5;
    g.strokeStyle = '#FFFFFF';
    g.stroke();
    g.translate(size / 2 - 8.4, size / 2 - 8.4);
    g.scale(0.7, 0.7);
    g.strokeStyle = '#FFFFFF';
    g.lineWidth = 2.6;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.stroke(new Path2D(c.d));
    return { image: g.getImageData(0, 0, size * ratio, size * ratio), ratio };
  },

  setup() {
    map.on('styleimagemissing', (e) => {
      if (!e.id || !e.id.startsWith('poi-') || map.hasImage(e.id) || !POI[e.id.slice(4)]) return;
      const { image, ratio } = this.image(e.id.slice(4));
      map.addImage(e.id, image, { pixelRatio: ratio });
    });
    map.on('click', 'poi-icon', (e) => {
      if ((typeof Draw !== 'undefined' && Draw.active) || editor.open || editor.moving) return;
      const f = e.features && e.features[0];
      const p = f && this.results[f.properties.i];
      if (p) { this._tap = e.originalEvent; this.show(p); }
    });
    map.on('mouseenter', 'poi-icon', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'poi-icon', () => { map.getCanvas().style.cursor = ''; });
    $('#poi-pill').onclick = (e) => { if (e.target.closest('.poi-x')) this.clear(); else this.fitAll(); };
    this.renderChips();
  }
};

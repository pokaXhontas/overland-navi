/* Fahrzeug-Symbole für die eigene Position (Seitenansicht, Blick nach rechts).
 * Einfache, eigene Zeichnungen ohne Markenzeichen. */
'use strict';
(function () {
  const TIRE = '#1c2024', RIM = '#aab2b7', GLASS = '#2b3c48', DARK = '#23282c', LINE = 'rgba(0,0,0,.28)';

  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f));
    return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  const wheel = (cx, cy, r) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${TIRE}"/><circle cx="${cx}" cy="${cy}" r="${(r * 0.5).toFixed(2)}" fill="${RIM}"/><circle cx="${cx}" cy="${cy}" r="${(r * 0.16).toFixed(2)}" fill="${TIRE}"/>`;
  const glass = (d) => `<path d="${d}" fill="${GLASS}"/>`;
  const rect = (x, y, w, h, fill, rx = 0.6) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"/>`;
  const line = (d, w = 0.6, c = LINE) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>`;
  const body = (d, c) => `<path d="${d}" fill="${c}" stroke="${DARK}" stroke-width="1.1" stroke-linejoin="round"/>`;
  const head = (x, y) => `<circle cx="${x}" cy="${y}" r="1.35" fill="#fff4c2" stroke="${DARK}" stroke-width=".5"/>`;
  const tail = (x, y) => rect(x, y, 1.1, 2.8, '#d8402f', 0.3);

  const V = {
    defender110: {
      name: 'Defender 110',
      draw: (c) => {
        const d = shade(c, -0.22);
        return rect(5, 3.4, 36, 1.7, DARK, 0.5) + rect(8, 4.6, 1.2, 2.6, DARK, 0.2) + rect(22, 4.6, 1.2, 2.6, DARK, 0.2) + rect(37, 4.6, 1.2, 2.6, DARK, 0.2) +
          body('M4 29V9.2Q4 7 6.2 7H40L42.8 16.6H58.8Q60 16.6 60 17.8V28Q60 29 59 29H58A8 8 0 0 0 42 29H23A8 8 0 0 0 7 29Z', c) +
          `<path d="M4.6 23H59.4V28Q59.4 28.4 59 28.4H58.1A8 8 0 0 0 42 28.4H23A8 8 0 0 0 7 28.4H4.6Z" fill="${d}"/>` +
          glass('M6.5 9.4H15.4V15.8H6.5Z') + glass('M17.2 9.4H27.6V15.8H17.2Z') + glass('M29.6 9.4H39.4L41.4 15.8H29.6Z') +
          rect(10, 7.1, 4.4, 1.1, GLASS, 0.3) + rect(19, 7.1, 5, 1.1, GLASS, 0.3) +
          line('M16.3 9V28') + line('M28.6 9V28') + line('M4.6 17H42.6', 0.5) +
          `<path d="M45.6 22.5V17.6L43 8.2" fill="none" stroke="${DARK}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` +
          rect(42, 6.6, 2.4, 1.8, DARK, 0.4) +
          rect(55.8, 26.4, 6.2, 2.8, DARK) + rect(1.8, 26.8, 4.4, 2.2, DARK) + head(58.6, 19.6) + tail(4.4, 19.4) +
          wheel(3.2, 17.2, 4.5) + wheel(15, 30.2, 6.3) + wheel(50, 30.2, 6.3);
      }
    },
    defender90: {
      name: 'Defender 90',
      draw: (c) => {
        const d = shade(c, -0.22);
        return rect(13, 3.4, 28, 1.7, DARK, 0.5) + rect(15.5, 4.6, 1.2, 2.6, DARK, 0.2) + rect(37, 4.6, 1.2, 2.6, DARK, 0.2) +
          body('M12 29V9.2Q12 7 14.2 7H40L42.8 16.6H58.8Q60 16.6 60 17.8V28Q60 29 59 29H58A8 8 0 0 0 42 29H31A8 8 0 0 0 15 29Z', c) +
          `<path d="M12.6 23H59.4V28Q59.4 28.4 59 28.4H58.1A8 8 0 0 0 42 28.4H31A8 8 0 0 0 15 28.4H12.6Z" fill="${d}"/>` +
          glass('M14.5 9.4H27.6V15.8H14.5Z') + glass('M29.6 9.4H39.4L41.4 15.8H29.6Z') + rect(18, 7.1, 6, 1.1, GLASS, 0.3) +
          line('M28.6 9V28') + line('M12.6 17H42.6', 0.5) +
          `<path d="M45.6 22.5V17.6L43 8.2" fill="none" stroke="${DARK}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` +
          rect(42, 6.6, 2.4, 1.8, DARK, 0.4) +
          rect(55.8, 26.4, 6.2, 2.8, DARK) + rect(9.8, 26.8, 4.4, 2.2, DARK) + head(58.6, 19.6) + tail(12.4, 19.4) +
          wheel(11.2, 17.2, 4.5) + wheel(23, 30.2, 6.3) + wheel(50, 30.2, 6.3);
      }
    },
    troopy: {
      name: 'Land Cruiser 78 „Troopy“',
      draw: (c) => {
        const d = shade(c, -0.22);
        return rect(4, 1.8, 33, 1.7, DARK, 0.5) + rect(7, 3, 1.2, 2, DARK, 0.2) + rect(20, 3, 1.2, 2, DARK, 0.2) + rect(33, 3, 1.2, 2, DARK, 0.2) +
          body('M3 29V7Q3 4.5 5.5 4.5H37L43.6 15.4L57.5 17Q60.5 17.4 60.5 20.5V28Q60.5 29 59.5 29H57A8 8 0 0 0 41 29H23A8 8 0 0 0 7 29Z', c) +
          `<path d="M3.6 24H59.9V28Q59.9 28.4 59.5 28.4H57.1A8 8 0 0 0 41 28.4H23A8 8 0 0 0 7 28.4H3.6Z" fill="${d}"/>` +
          glass('M5.2 7H19.6V15H5.2Z') + glass('M21.6 7H29.8V15H21.6Z') + glass('M31.6 7H37.2L41.8 15H31.6Z') +
          line('M30.7 6.6V28') + line('M20.6 6.6V28') +
          `<path d="M57.6 29A8.6 8.6 0 0 0 40.4 29M23.6 29A8.6 8.6 0 0 0 6.4 29" fill="none" stroke="${DARK}" stroke-width="1.9"/>` +
          `<path d="M46.2 23V17L43.8 7.2" fill="none" stroke="${DARK}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` +
          rect(42.8, 5.8, 2.4, 1.8, DARK, 0.4) +
          rect(56.5, 26.2, 6, 2.9, DARK) + rect(1.2, 26.6, 4, 2.4, DARK) + head(58.8, 21) + tail(3.4, 18.6) +
          wheel(15, 30.2, 6.3) + wheel(49, 30.2, 6.3);
      }
    },
    cruiser: {
      name: 'Land Cruiser Station',
      draw: (c) => {
        const d = shade(c, -0.22);
        return rect(9, 5.6, 25, 1.3, DARK, 0.5) +
          body('M3.5 27.6V12.5Q3.5 8.6 7.2 8.2L32.6 7.6Q35.8 7.6 37.6 9.4L44.2 16.2L57 17.6Q60.6 18 60.6 21.2V27.6Q60.6 29 59.2 29H57A8 8 0 0 0 41 29H23A8 8 0 0 0 7 29H4.9Q3.5 29 3.5 27.6Z', c) +
          `<path d="M4.1 23.4H60V27.6Q60 28.4 59.2 28.4H57.1A8 8 0 0 0 41 28.4H23A8 8 0 0 0 7 28.4H4.9Q4.1 28.4 4.1 27.6Z" fill="${d}"/>` +
          glass('M6.2 15.6V12.4Q6.2 10 8.4 9.9H15.4V15.6Z') + glass('M17.2 9.8H27.4V15.6H17.2Z') + glass('M29.2 9.7H35.8L41.6 15.6H29.2Z') +
          line('M28.3 9.6V27.6') + line('M16.3 9.8V27.6') + line('M4.1 18.6H43.6', 0.5) +
          rect(56.8, 26.1, 5.4, 2.9, DARK) + rect(1.8, 26.4, 3.6, 2.4, DARK) + head(59, 21.2) + tail(3.9, 17.6) +
          wheel(15, 30.2, 6.3) + wheel(49, 30.2, 6.3);
      }
    },
    samurai: {
      name: 'Suzuki Samurai',
      draw: (c) => {
        const d = shade(c, -0.22);
        return `<g transform="translate(3 0)">` +
          body('M11 29V12.2Q11 10 13.2 10H37.6L40.6 18.2H54Q55.2 18.2 55.2 19.4V28Q55.2 29 54.2 29H52.4A7.4 7.4 0 0 0 37.6 29H26.9A7.4 7.4 0 0 0 12.1 29Z', c) +
          `<path d="M11.6 24H54.6V28Q54.6 28.4 54.2 28.4H52.5A7.4 7.4 0 0 0 37.6 28.4H26.9A7.4 7.4 0 0 0 12.1 28.4H11.6Z" fill="${d}"/>` +
          glass('M13 12.2H24.4V17.6H13Z') + glass('M26.2 12.2H37.2L39.4 17.6H26.2Z') +
          line('M25.3 11.8V28') + line('M11.6 19.2H40.2', 0.5) +
          rect(52.4, 26.2, 5, 2.6, DARK) + rect(8.8, 26.6, 3.4, 2.2, DARK) + head(54, 21) + tail(11.4, 19.6) +
          wheel(10.3, 19.6, 4.1) + wheel(19.5, 30.6, 5.8) + wheel(45, 30.6, 5.8) + '</g>';
      }
    },
    pickup: {
      name: 'Pickup mit Kabine',
      draw: (c) => {
        const box = '#efebe2';
        return body('M2 29V19H31V12Q31 10 33 10H39.4L44.4 17.8H58Q60 17.8 60 19.8V28Q60 29 59 29H57A8 8 0 0 0 41 29H23A8 8 0 0 0 7 29Z', c) +
          body('M2 21V5.5Q2 3.5 4 3.5H37Q38.6 3.5 38.6 5.1V7.8Q38.6 9.4 37 9.4H32V21Z', box) +
          `<path d="M2.6 13.6H31.4" stroke="${shade(c, -0.1)}" stroke-width="1.6"/>` +
          glass('M5.5 6.4H14.5V11.4H5.5Z') + rect(20, 6, 7.4, 13.6, 'none') + `<rect x="20" y="6" width="7.4" height="13.4" rx="1" fill="none" stroke="${LINE}" stroke-width=".7"/>` +
          glass('M33.2 11.8H38.8L42.4 17.2H33.2Z') +
          `<path d="M57.6 29A8.6 8.6 0 0 0 40.4 29M23.6 29A8.6 8.6 0 0 0 6.4 29" fill="none" stroke="${DARK}" stroke-width="1.6"/>` +
          rect(56.4, 26.2, 5.8, 2.9, DARK) + rect(0.6, 26.6, 3.4, 2.4, DARK) + head(58.6, 20.6) + tail(2.4, 22.4) +
          wheel(15, 30.2, 6.3) + wheel(49, 30.2, 6.3);
      }
    },
    van: {
      name: 'Kastenwagen',
      draw: (c) => {
        const d = shade(c, -0.22);
        return body('M3 28.5V7Q3 4.5 5.5 4.5H41Q43 4.5 44.2 6L52.5 16.5L58.6 19Q61 20 61 22.5V28Q61 29 60 29H58A8 8 0 0 0 42 29H22A8 8 0 0 0 6 29H4Q3 29 3 28.5Z', c) +
          `<path d="M3.6 24.4H60.4V28Q60.4 28.4 60 28.4H58.1A8 8 0 0 0 42 28.4H22A8 8 0 0 0 6 28.4H4Q3.6 28.4 3.6 28Z" fill="${d}"/>` +
          glass('M22 8H34.6V14.6H22Z') + glass('M38 7.4H43.4L50.6 16H38Z') +
          line('M37 6.4V28') + line('M20.6 6.4V28') +
          rect(57.4, 26, 5.2, 3, DARK) + rect(1.6, 26.2, 3.4, 2.6, DARK) + head(59, 22) + tail(3.4, 17) +
          wheel(14, 30.2, 6.3) + wheel(50, 30.2, 6.3);
      }
    },
    truck: {
      name: 'Expeditions-LKW',
      draw: (c) => {
        const box = '#efebe2';
        return rect(2, 22, 58, 4.4, DARK, 0.8) +
          body('M2 21.5V4Q2 1.6 4.4 1.6H38Q40.4 1.6 40.4 4V21.5Z', box) +
          glass('M6 6.6H16.4V12.4H6Z') + `<rect x="22" y="5" width="7.6" height="15" rx="1" fill="none" stroke="${LINE}" stroke-width=".7"/>` +
          body('M42.2 25.6V6.2Q42.2 4 44.4 4H57.4Q60 4 60.4 6.6L61.6 16.2V25.4Q61.6 26.4 60.6 26.4H42.2Z', c) +
          glass('M49 6.4H58.4L59.6 14.4H49Z') + line('M47.4 6V25') +
          rect(57.8, 24.4, 5, 3, DARK) + head(60.2, 19.6) + tail(2.2, 15) +
          wheel(15, 30.4, 7.6) + wheel(50, 30.4, 7.6);
      }
    }
  };

  const COLORS = [
    ['#e9e5da', 'Weiß'], ['#c9b48a', 'Sand'], ['#4a5f45', 'Grün'], ['#6c7a52', 'Oliv'], ['#7d8790', 'Grau'],
    ['#2f3438', 'Schwarz'], ['#a8342b', 'Rot'], ['#2f5d8a', 'Blau'], ['#d8792a', 'Orange']
  ];

  function svg(id, color) {
    const v = V[id];
    if (!v) return '';
    return `<svg viewBox="-1 0 66 38" xmlns="http://www.w3.org/2000/svg"><g stroke="none">${v.draw(color || COLORS[0][0])}</g></svg>`;
  }

  self.Vehicles = { list: Object.keys(V).map((id) => ({ id, name: V[id].name })), colors: COLORS, svg };
})();

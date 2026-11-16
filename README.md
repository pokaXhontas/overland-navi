# Overland-Navi

Offline-Navigation fürs Overlanding auf iPad und iPhone – als Web-App, ohne App Store.

**Etappe 1 (diese Version)**

- Topografische Karte aus OpenStreetMap (Protomaps) mit Geländeschattierung und Höhenlinien (Mapterhorn-Höhenmodell)
- GPS-Position mit Tempo, Kurs, Höhe und Genauigkeit, Karte folgt in Fahrtrichtung oder mit Norden oben
- Helles und dunkles Design, automatisch nach Systemeinstellung
- Kartengebiete komplett offline laden (Berlin & Umgebung, Kirgistan)
- „Platz hier“ speichert die aktuelle Position, Export als GPX

## Einmalig einrichten

1. Im Repository auf **Settings → Pages** gehen und bei **Source** „**GitHub Actions**“ wählen.
2. Unter **Actions** den Lauf „Bauen und veröffentlichen“ abwarten (beim ersten Mal dauert er etwas länger, weil die Kartendaten geschnitten werden). Falls er vor Schritt 1 schon fehlgeschlagen ist: Lauf öffnen und „Re-run all jobs“.
3. Die App ist dann unter `https://pokaxhontas.github.io/overland-navi/` erreichbar.

## Auf iPad und iPhone installieren

1. Adresse in **Safari** öffnen.
2. Teilen-Symbol → **Zum Home-Bildschirm**.
3. App vom Home-Bildschirm starten, Standort erlauben.
4. Oben rechts auf das Ebenen-Symbol → bei **Offline-Karten** ein Gebiet **Laden**. Während des Downloads die App offen lassen.

## Navigation ohne Internet

- Beim Laden eines Gebiets kommt das Straßennetz für das Offline-Routing mit. Für schon geladene Gebiete unter **Offline-Karten** auf **Offline-Routen laden** tippen.
- Ohne Netz (oder wenn die Routenserver nicht antworten) rechnet die App Routen mit dem Auto und zu Fuß selbst, inklusive Abbiegehinweisen, Neuberechnung und Abbiegeverboten. Bus & Bahn geht nur online.
- Die Daten baut der Lauf **Offline-Straßennetz bauen** (`scripts/build_routing.py`) einmal pro Land aus OpenStreetMap, alle drei Monate neu.

## Kartengebiete ändern

Die Gebiete stehen in `regions.json` (Name, Begrenzung als `[West, Süd, Ost, Nord]`, höchste Zoomstufe). Nach einer Änderung baut GitHub die Kartendaten automatisch neu. Die gesamte Seite darf bei GitHub Pages höchstens 1 GB groß sein.

## Datenquellen

- Karte: © OpenStreetMap-Mitwirkende, aufbereitet von [Protomaps](https://protomaps.com)
- Höhen: [Mapterhorn](https://mapterhorn.com)
- Darstellung: [MapLibre GL JS](https://maplibre.org), [maplibre-contour](https://github.com/onthegomap/maplibre-contour)

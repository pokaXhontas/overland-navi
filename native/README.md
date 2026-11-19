# Overland-Navi als iPhone-/iPad-App

Die App ist dieselbe Web-App wie unter https://pokaxhontas.github.io/overland-navi/,
nur in eine native Hülle (Capacitor) verpackt. Die Webseite und die Home-Bildschirm-App
laufen unverändert weiter.

Gebaut wird auf einem macOS-Rechner von GitHub (`.github/workflows/ios.yml`):
nach jeder Veröffentlichung der Webseite oder von Hand über „Run workflow“.

Ohne Apple-Schlüssel prüft der Lauf nur, ob sich die App bauen lässt.
Sobald diese Secrets gesetzt sind, lädt er jede Version zu TestFlight hoch:

| Secret          | Woher                                                             |
|-----------------|-------------------------------------------------------------------|
| `ASC_KEY_ID`    | App Store Connect → Benutzer und Zugriff → Integrationen → Schlüssel-ID |
| `ASC_ISSUER_ID` | gleiche Seite, oben „Aussteller-ID“                               |
| `ASC_KEY_P8`    | Inhalt der heruntergeladenen Datei `AuthKey_….p8`                 |
| `APPLE_TEAM_ID` | developer.apple.com → Konto → Mitgliedschaft → Team-ID             |

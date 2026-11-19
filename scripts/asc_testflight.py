"""TestFlight einrichten und Stand zeigen (App Store Connect API).
Legt die interne Gruppe „Wir“ an (alle Builds automatisch), trägt alle Team-Mitglieder als Tester ein
und zeigt, wie weit Apple mit den hochgeladenen Builds ist. Gibt keine Namen oder E-Mails aus (öffentliches Protokoll)."""
import json, os, time, urllib.request, urllib.error
import jwt  # PyJWT

KEY_ID, ISSUER, P8 = os.environ['ASC_KEY_ID'], os.environ['ASC_ISSUER_ID'], os.environ['ASC_KEY_P8']
BUNDLE = 'io.github.pokaxhontas.overlandnavi'
API = 'https://api.appstoreconnect.apple.com'

def token():
    now = int(time.time())
    return jwt.encode({'iss': ISSUER, 'iat': now, 'exp': now + 1100, 'aud': 'appstoreconnect-v1'}, P8, algorithm='ES256', headers={'kid': KEY_ID, 'typ': 'JWT'})

def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r:
            t = r.read()
            return json.loads(t) if t else {}
    except urllib.error.HTTPError as e:
        msg = e.read().decode()[:600]
        print(f'  Hinweis von Apple ({e.code}) bei {method} {path.split("?")[0]}: {msg}')
        return None

apps = call('GET', f'/v1/apps?filter[bundleId]={BUNDLE}')
if not apps or not apps['data']:
    raise SystemExit('Keine App mit dieser Bundle-ID in App Store Connect gefunden – „Neue App“ anlegen.')
app = apps['data'][0]['id']
print('App gefunden.')

builds = call('GET', f'/v1/builds?filter[app]={app}&sort=-uploadedDate&limit=5&include=preReleaseVersion')
vers = {v['id']: v['attributes'].get('version') for v in (builds or {}).get('included', [])}
print('Hochgeladene Builds (neueste zuerst):')
for b in (builds or {}).get('data', []):
    a = b['attributes']
    pv = (b.get('relationships', {}).get('preReleaseVersion', {}).get('data') or {}).get('id')
    print(f"  {vers.get(pv, '?')} ({a.get('version')}): Verarbeitung {a.get('processingState')}, abgelaufen {a.get('expired')}, Exportfrage {a.get('usesNonExemptEncryption')}")
    # Exportkontrolle beantworten, falls Apple noch fragt (die App nutzt nur Standard-HTTPS)
    if a.get('usesNonExemptEncryption') is None and a.get('processingState') == 'VALID':
        call('PATCH', f"/v1/builds/{b['id']}", {'data': {'type': 'builds', 'id': b['id'], 'attributes': {'usesNonExemptEncryption': False}}})

groups = call('GET', f'/v1/apps/{app}/betaGroups?limit=50') or {'data': []}
grp = next((g for g in groups['data'] if g['attributes'].get('isInternalGroup')), None)
if not grp:
    r = call('POST', '/v1/betaGroups', {'data': {'type': 'betaGroups', 'attributes': {'name': 'Wir', 'isInternalGroup': True, 'hasAccessToAllBuilds': True},
             'relationships': {'app': {'data': {'type': 'apps', 'id': app}}}}})
    grp = r and r['data']
    print('Interne Gruppe „Wir“ angelegt.' if grp else 'Interne Gruppe konnte nicht angelegt werden.')
else:
    print('Interne Gruppe vorhanden: ' + grp['attributes'].get('name', ''))
if grp:
    if not grp['attributes'].get('hasAccessToAllBuilds'):
        call('PATCH', f"/v1/betaGroups/{grp['id']}", {'data': {'type': 'betaGroups', 'id': grp['id'], 'attributes': {'hasAccessToAllBuilds': True}}})
    have = {t['attributes'].get('email', '').lower() for t in (call('GET', f"/v1/betaGroups/{grp['id']}/betaTesters?limit=200") or {'data': []})['data']}
    users = (call('GET', '/v1/users?limit=100') or {'data': []})['data']
    added = 0
    for u in users:
        a = u['attributes']
        mail = (a.get('username') or a.get('email') or '').lower()
        if not mail or mail in have:
            continue
        r = call('POST', '/v1/betaTesters', {'data': {'type': 'betaTesters', 'attributes': {'email': mail, 'firstName': a.get('firstName', ''), 'lastName': a.get('lastName', '')},
                 'relationships': {'betaGroups': {'data': [{'type': 'betaGroups', 'id': grp['id']}]}}}})
        if r:
            added += 1
    print(f'Team-Mitglieder: {len(users)}, schon Tester: {len(have)}, neu eingetragen: {added}')

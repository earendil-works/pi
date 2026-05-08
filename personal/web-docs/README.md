# Pi Web Docs — datenschutzkonformer Dokumenten-Chat im Browser

Ein Browser-Frontend für Olivers MAV-/Beratungs-Dokumentenarbeit, gehostet auf dem
eigenen Hetzner-VPS, mit Google-OAuth-Login (nur o.gerets@gmail.com) und Infomaniak
Kimi K2.6 als LLM-Backend.

**Use-Case:** PDF/DOCX/XLSX hochladen → im Browser parsen → an Infomaniak (Schweiz)
schicken → Antwort/Zusammenfassung/Entwurf im Chat. Von Laptop, Smartphone, beliebigem
Gerät erreichbar.

**Was es nicht ist:** Kein Pi-CLI-Ersatz, kein OPJ1-Telegram-Ersatz. Nur fokussiert
auf Dokumenten-Verarbeitung mit Web-UX.

---

## Architektur

```
Browser (Laptop/Smartphone)
   │
   │  HTTPS (Let's Encrypt)
   ▼
docs.og-monschau.de  →  VPS Hetzner Nürnberg (46.225.80.223)
   │                       │
   │                       ├─ nginx (TLS, vhost-Routing, Static-Hosting)
   │                       │
   │                       ├─ /oauth2/* → oauth2-proxy (127.0.0.1:4180)
   │                       │              ├─ Login-Provider: Google
   │                       │              └─ allowed: nur o.gerets@gmail.com
   │                       │
   │                       ├─ /api/proxy/* (gated by auth_request)
   │                       │       └─ → CORS-Mini-Proxy (127.0.0.1:8090)
   │                       │              └─ → api.infomaniak.com (Whitelist)
   │                       │
   │                       └─ /* (gated by auth_request) → /home/opipi/web-docs/dist/
   │
   ▼
Infomaniak AI (Schweiz, OpenAI-kompatibel)
   └─ Default-Modell: moonshotai/Kimi-K2.6 (200k Kontext)
```

### Datenfluss-DSGVO-Bewertung

| Komponente | Datenstand | Sieht Inhalte? |
|---|---|---|
| Browser (Olivers Geräte) | Lokal: API-Key (IndexedDB), Chat-Verlauf, hochgeladene Dokumente | ja, eigene Geräte |
| Hetzner DNS / konsoleH | DNS-Anfragen-Metadaten | nein, nur Hostname-Lookups, DE |
| Google OAuth | Login-Event (Email + Timestamp) | nein |
| Hetzner Frankfurt (Server) | Durchleitung via nginx + Mini-Proxy | nein (Proxy loggt nur Status, kein Body) |
| Infomaniak Schweiz (LLM) | Extrahierter Text + Anfrage | ja, das ist der Verarbeitungszweck |

- **DPA mit Infomaniak** ist Pflicht (siehe `dsgvo/VVT-Eintrag.md`)
- **Keine US-Beteiligung** an personenbezogenen Daten (Domain bei Hetzner DE,
  Hosting Hetzner DE, LLM Infomaniak CH)
- **Keine externen CORS-Proxies** (eigener Mini-Proxy auf VPS)

---

## Komponenten

| Pfad | Zweck |
|---|---|
| `frontend/` | Vite-basiertes Web-UI, abgeleitet von `pi/packages/web-ui/example` (pi 0.74.0). Auto-Provisionierung Custom Provider „infomaniak", deutsche Texte. |
| `proxy/server.js` | Mini-CORS-Proxy in Node (~150 Zeilen). Whitelist auf `api.infomaniak.com`. Kein Body-Logging. |
| `deploy/nginx/docs.og-monschau.de.conf` | nginx-Vhost mit auth_request-Pattern |
| `deploy/oauth2-proxy/oauth2-proxy.cfg` | oauth2-proxy-Config (Provider Google, Email-Allowlist) |
| `deploy/oauth2-proxy/allowed-emails.txt` | Liste autorisierter Email-Adressen |
| `deploy/systemd/*.service` | systemd-Units für CORS-Proxy + oauth2-proxy |
| `deploy/setup-vps.sh` | Idempotentes Setup-Skript für die root-Schritte |
| `dsgvo/VVT-Eintrag.md` | Verzeichnis-von-Verarbeitungstätigkeiten-Snippet |

---

## Setup (Schritt-für-Schritt)

### Phase A — DNS (Olivers Aktion, ~3 Min in Hetzner konsoleH)

Domain `og-monschau.de` ist bei Hetzner registriert. DNS wird über Hetzner konsoleH
verwaltet (NICHT über Hetzner Cloud DNS — Default-NS bleiben bei konsoleH):

In der konsoleH-Domain-Verwaltung von `og-monschau.de` einen neuen DNS-Record anlegen:

| Feld | Wert |
|---|---|
| Typ | A |
| Name | `docs` (nur Subdomain-Teil, nicht voll qualifiziert) |
| Wert | `46.225.80.223` |
| TTL | 3600 |

Verifizieren: `dig +short @8.8.8.8 docs.og-monschau.de` muss `46.225.80.223` liefern
(meist nach 5-30 Min Propagation).

### Phase B — Google OAuth Client (Olivers Aktion, ~5 Min auf Google Cloud Console)

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → Projekt
   wählen oder neues anlegen („Pi Web Docs")
2. „OAuth Client ID erstellen" → Type: **Web application**
3. Authorized redirect URIs: `https://docs.og-monschau.de/oauth2/callback`
4. Speichern → Olivers `CLIENT_ID` + `CLIENT_SECRET` notieren (kommen gleich ins
   ENV-File auf VPS)
5. OAuth Consent Screen: Internal (wenn Google Workspace) oder External mit Olivers
   Email als Testuser

### Phase C — Code auf VPS bringen (vom Laptop)

Aus dem Repo-Root (`/home/oliver/pi`):

```bash
cd personal/web-docs/frontend
npm install                         # einmalig (oder bei Updates)
npm run build                       # erzeugt dist/

cd /home/oliver/pi
rsync -av --delete --exclude node_modules personal/web-docs/ vps-opipi:web-docs/
```

### Phase D — Setup-Skript auf VPS (root)

Über OPJ1 oder direkt als root:

```bash
sudo bash /home/opipi/web-docs/deploy/setup-vps.sh
```

Was passiert:
- nginx + certbot installieren (falls fehlt)
- oauth2-proxy v7.7.1 Binary nach `/usr/local/bin/`
- `/etc/web-docs-oauth2-proxy.env` Skelett anlegen mit zufälligem `COOKIE_SECRET`
- nginx-Vhost via Symlinks aktivieren
- TLS-Cert via certbot/webroot ziehen
- systemd-Units verlinken

Das Skript ist idempotent — kann beliebig oft laufen, macht nur was fehlt.

### Phase E — OAuth-Secrets ins ENV-File (Olivers Aktion auf VPS)

Als root:
```bash
sudoedit /etc/web-docs-oauth2-proxy.env
```

`OAUTH2_PROXY_CLIENT_ID` und `OAUTH2_PROXY_CLIENT_SECRET` mit den Werten aus Phase B
ersetzen.

### Phase F — Services starten

```bash
sudo systemctl enable --now web-docs-proxy web-docs-oauth2-proxy
sudo systemctl status web-docs-proxy web-docs-oauth2-proxy
```

Beide sollten `active (running)` zeigen.

### Phase G — Smoke-Test

```bash
# Vom Laptop:
curl -sI https://docs.og-monschau.de/                       # erwartet: 302 zu /oauth2/sign_in
curl -sI https://docs.og-monschau.de/oauth2/ping            # erwartet: 200 OK
```

Im Browser: `https://docs.og-monschau.de/` → Google-Login → App lädt → Settings öffnen
→ Provider „Infomaniak (Schweiz)" sollte vorausgewählt sein → API-Key eintragen
(aus `~/.pi-keys/infomaniak.env` auf Laptop) → „Hallo" tippen → Antwort von Kimi.

---

## Updates

### Frontend-Update nach Code-Änderung

```bash
cd /home/oliver/pi/personal/web-docs/frontend
git pull                  # Bzw. lokale Edits
npm run build
rsync -av --delete frontend/dist/ vps-opipi:web-docs/dist/
# Kein systemd-Restart nötig — nginx serviert direkt aus dist/
```

### Proxy-/oauth2-/nginx-Update nach Config-Änderung

```bash
cd /home/oliver/pi/personal/web-docs
git pull                  # bzw. Edit
rsync -av --exclude frontend/node_modules --exclude frontend/dist . vps-opipi:web-docs/
ssh vps-opipi 'sudo systemctl reload nginx && sudo systemctl restart web-docs-proxy web-docs-oauth2-proxy'
```

### Pi-Web-UI-Library-Update (neue Version `@earendil-works/pi-web-ui`)

```bash
cd /home/oliver/pi/personal/web-docs/frontend
npm update @earendil-works/pi-web-ui @earendil-works/pi-agent-core @earendil-works/pi-ai
npm run check && npm run build
rsync -av --delete frontend/dist/ vps-opipi:web-docs/dist/
```

---

## Bekannte Einschränkungen

- **API-Key in IndexedDB:** Pro Browser-Profil sichtbar in DevTools. Mitigation: Browser
  mit Passwort sichern, Profil-Lock; Key alle ~6 Monate rotieren.
- **Disk-Belegung VPS:** Stand 2026-05-08 80 % belegt (15 GB frei). Mein Setup nutzt
  ~50 MB. Aber generell sollte das VPS-Disk in den nächsten Wochen aufgeräumt werden.
- **nginx-Traverse-Recht für /home/opipi:** Auf Hetzner-Defaults ist `/home/opipi`
  `0750 opipi:opipi`. nginx-Worker (www-data) kann ohne Gruppen-Mitgliedschaft nicht
  reintraversieren → 403 beim Static-Hosting aus `dist/`. setup-vps.sh nimmt deshalb
  `www-data` in die `opipi`-Gruppe auf (`usermod -aG opipi www-data`). Nach dem
  Hinzufügen muss nginx einmal neu gestartet werden (`systemctl restart nginx`),
  damit die Gruppen-Mitgliedschaft aktiv wird.
- **Cookie-TTL 7 Tage:** Nach 7 Tagen Inaktivität neu einloggen. Über `cookie_expire`
  in `oauth2-proxy.cfg` änderbar.

---

## Migrations-Pfad „eigene Domain"

Wenn Oliver eine eigene .de-Domain hat (Hetzner DNS, Infomaniak Domain, oder bestehende):

1. DNS-Record `docs.<eigene-domain>` → `46.225.80.223` setzen
2. nginx-Vhost-Datei kopieren oder umbenennen, `server_name` ändern
3. `certbot certonly -d docs.<eigene-domain>`
4. SSL_certificate-Pfad in vhost auf neuen Cert
5. Google OAuth: zusätzliche Redirect URI eintragen, oder Client-Secret komplett ersetzen
6. `systemctl reload nginx && systemctl restart web-docs-oauth2-proxy`
7. Alte `docs.og-monschau.de`-Subdomain in dynu löschen, Vhost archivieren

Aufwand: ~30 Min Tech + 10 Min Olivers DNS/Google-Klicks.

---

## Sicherheits-Notizen

- `oauth2-proxy.env` enthält Client-Secret + Cookie-Secret → permissions `0640
  root:opipi`, nicht in Git
- `authorized_emails.txt` ist im Repo (nur deine eigene Adresse — keine
  personenbezogenen Drittdaten)
- Mini-Proxy hat **Whitelist** für Ziel-Hosts → versuchte SSRF-Attacks
  (`?url=http://internal-service`) werden mit 403 geblockt
- Body wird nicht geloggt, nur Status + Pfad + Dauer
- nginx setzt CSP, HSTS, X-Frame-Options
- Cookie-Secret regenerieren bei Server-Kompromittierung:
  `head -c 32 /dev/urandom | base64 | tr -d '\n=' | cut -c1-32`

# Verzeichnis von Verarbeitungstätigkeiten — Pi Web Docs

Verarbeitungs-Snippet für Olivers internes Verzeichnis nach Art. 30 DSGVO.

---

## Bezeichnung der Verarbeitungstätigkeit

Cloud-LLM-gestützte Auswertung personenbezogener Dokumente in der MAV-Tätigkeit
und ehrenamtlichen Beratung („Pi Web Docs")

## Verantwortlicher

Oliver Gerets, [Adresse], o.gerets@gmail.com

## Zwecke der Verarbeitung

- Zusammenfassung von Personalakten, Verträgen, Schriftverkehr und Anhörungen
- Vorbereitung von MAV-Stellungnahmen
- Vergleichende Analyse von Dokument-Versionen
- Entwurf von Antwortschreiben

## Kategorien betroffener Personen

- Beschäftigte des Arbeitgebers (im Rahmen der MAV-Tätigkeit)
- Beratungsuchende (ehrenamtliche Beratung)
- Sonstige natürliche Personen, deren Daten in den verarbeiteten Dokumenten enthalten sind

## Kategorien personenbezogener Daten

- Stammdaten (Name, Adresse, Geburtsdatum)
- Beschäftigungsdaten (Vertrag, Eingruppierung, Arbeitszeit)
- Kommunikationsdaten (Schriftverkehr-Inhalte)
- Falls in Dokumenten enthalten: ggf. Krankheits- oder Religionsangaben (Art. 9 DSGVO,
  in MAV-/Beratungs-Kontext nur einschlägig, wenn vom Betroffenen freiwillig zur
  Verfügung gestellt)

## Empfänger / Auftragsverarbeiter

| Empfänger | Sitz | Rolle | Vertragsbasis |
|---|---|---|---|
| Infomaniak Network SA | Schweiz, Genf | Auftragsverarbeiter (LLM-Hosting) | Auftragsverarbeitungsvertrag (DPA) gem. Art. 28 DSGVO + Adäquanzbeschluss CH-EU. **TODO Oliver: DPA aus Infomaniak-Manager herunterladen und gegenzeichnen, falls noch nicht erfolgt.** |
| Hetzner Online GmbH | Deutschland, Gunzenhausen | Hosting-Provider (VPS) + Domain-Registrar (`og-monschau.de`) + DNS-Provider (konsoleH) | Bestehender DPA (Standard-Hetzner-Vertrag) |
| Google LLC | USA, Mountain View | OAuth-Login-Provider | Login-Metadaten (Email + Timestamp) — keine Inhaltsdaten. Standard-Vertragsklauseln + EU-US Data Privacy Framework. |

## Drittlandsübermittlung

- Schweiz (Infomaniak): Adäquanzbeschluss der EU-Kommission (kein Drittlandsproblem)
- USA (Google OAuth): Standard-Vertragsklauseln + EU-US Data Privacy Framework. Keine
  Inhaltsdaten betroffen — nur Login-Metadaten (Email + Timestamp).

## Löschfristen

- Browser-IndexedDB: bleibt im Browser des Verantwortlichen, manuell zu löschen
  (z.B. nach Abschluss einer Akte)
- VPS-Logs (nginx, systemd): Standard-Rotation 14 Tage
- Infomaniak: Verarbeitung ist transient, keine Speicherung der Anfragen-Inhalte
  (laut DPA, separat verifizieren)
- Cloud-Logs Google OAuth: lt. Google-DPA Standard

## Technische und organisatorische Maßnahmen (Art. 32 DSGVO)

- TLS 1.2+ für alle Übertragungen
- API-Key nur lokal im Browser (IndexedDB), nicht serverseitig gespeichert
- Authentifizierung: Google OAuth 2.0, Email-Allowlist (nur Verantwortlicher)
- VPS-Hardening: SSH Key-Auth, Port 2222, ufw, fail2ban
- nginx: HSTS, CSP, X-Frame-Options, no-cache für sensible Endpoints
- Mini-CORS-Proxy: Whitelist nur Infomaniak, kein Body-Logging
- VPS-Backups: keine, weil App stateless (Session-Verlauf nur im Browser-IndexedDB)

## Stand

Erstellt: 2026-05-08. Bei Architekturänderungen aktualisieren.

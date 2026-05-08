# Mobile-UX-Audit — Pi Web Docs (2026-05-09)

Lokaler Audit gegen `http://localhost:5173/` (Vite Dev-Server gegen `pi/personal/web-docs/frontend/`),
Playwright-MCP, zwei Mobile-Profile.

## Methodik

- **Pixel 7** (412 × 915 px Viewport)
- **iPhone SE** (375 × 667 px Viewport)

Pro Profil: Initialer Bootstrap, Settings-Dialog öffnen, Sessions-Dialog öffnen,
Touch-Target-Vermessung, Overflow-Check.

API-Key wurde **nicht** eingegeben → Live-Streaming + File-Upload sind getrennt
zu testen, sobald Cleanup auf VPS erfolgt ist (Phase 3 = Smartphone-Test mit echtem
Login).

## Befunde

### B1 — Touch-Targets: 45 von 49 Buttons unter 44 × 44 px (KRITISCH)

```
Header-Buttons (im Custom-Header in main.ts):
  Sessions       36 × 32 px   ✗
  Neue Session   36 × 32 px   ✗
  Theme-Toggle   32 × 32 px   ✗
  Einstellungen  36 × 32 px   ✗

Input-Action-Bar (pi-web-ui MessageEditor):
  File-Upload-Knopf      32 × 32 px   ✗
  Modell-Dropdown        170 × 32 px  ✗ (Höhe)
  Send-Button            32 × 32 px   ✗

Settings-Dialog (pi-web-ui SettingsDialog):
  Schließen-X            16 × 16 px   ✗✗ (besonders kritisch)
  Tab-Buttons            148 × 38 / 61 × 38 px  ✗ (Höhe)
  ~30× "Speichern"       78 × 32 px   ✗
  Bearbeiten             85 × 32 px   ✗
  Löschen                69 × 32 px   ✗

Sessions-Dialog:
  Schließen-X            16 × 16 px   ✗✗
```

**Fazit:** Alle interaktiven Elemente sind unter dem WCAG-AAA- und Apple-/Google-HIG-
Standard von 44 × 44 px. Auf Touch-Geräten häufige Mistaps zu erwarten.

**Klassifikation:** mehrteilig — Custom-Header in *unserem* `main.ts`, Restliches
in der pi-web-ui-Library.

### B2 — Custom-Provider-Card: Action-Buttons rendern außerhalb des Viewports (KRITISCH)

In `Settings → Providers & Models → Custom Providers` ist der Eintrag
„Infomaniak (Schweiz)" gerendert, mit zwei Action-Buttons (Bearbeiten / Löschen)
**rechts neben** der Card statt darunter:

| Viewport | Bearbeiten endet bei | Löschen endet bei | Out-of-bounds |
|---|---|---|---|
| Pixel 7 (412 px) | 420 px | 497 px | beide jenseits 412 |
| iPhone SE (375 px) | 418 px | 496 px | beide jenseits 375 |

Die Card-Reihe nutzt `flex` ohne `flex-wrap` → bei schmalem Viewport rutschen die
Buttons rechts raus, werden aber vom Scroll-Container abgeschnitten — `body
.scrollWidth = 412` ohne horizontalen Scroll. **Damit nicht erreichbar auf Mobile.**

Konsequenz: Provider auf Mobile **nicht editierbar / nicht löschbar**. Wenn Olivers
API-Key abläuft und er das von unterwegs am Smartphone fixen will, geht das so nicht.

**Klassifikation:** Library-Bug in `@earendil-works/pi-web-ui` (Custom-Provider-Card-
Layout). Workaround per CSS-Override im eigenen `app.css` möglich.

### B3 — Settings-Dialog: ~30 Standard-Provider-Cards vor der Custom-Provider-Sektion (HOCH)

Die Settings-Tab `Providers & Models` listet ~30 vordefinierte Cloud-Provider
(amazon-bedrock, anthropic, azure-openai-responses, …, zai), jede mit eigenem
API-Key-Eingabefeld + Speichern-Button. Custom Providers (Infomaniak) hängen ganz
unten bei Y ≈ 3182 px innerhalb des Dialogs.

Auf Mobile bedeutet das: User muss durch ~3000 px Inhalt scrollen, um an den
einzigen für ihn relevanten Provider zu kommen.

**Klassifikation:** Library-UX-Issue (`@earendil-works/pi-web-ui` SettingsDialog
hat `renderMobileTab()`, aber innerhalb des Tabs keine Filterung / kein Skip-to-
Custom-Provider). Schwer zu workaround-en — entweder vor-rechte Custom-Provider-
Position via CSS / DOM-Manipulation oder Library-Patch.

### B4 — Header passt knapp ohne Overflow auf 360 px wäre eng (MITTEL)

Custom-Header in `main.ts` (Sessions-Btn + Plus + Title + Theme + Settings):

| Viewport | Linker Block (px) | Rechter Block (px) | Lücke |
|---|---|---|---|
| Pixel 7 (412) | 258 | 88 | 24 px frei |
| iPhone SE (375) | 258 | 88 | -1 px (knapp) |
| Theoretisch 360 (Galaxy A) | 258 | 88 | -16 px (Overflow) |

Aktuell zeigt CSS `overflow: hidden` auf dem Outer-Wrapper (`overflow-hidden` in
[main.ts:326](../../frontend/src/main.ts#L326)) — kein sichtbarer Bug auf 375 +,
aber **bei aktivem Title-Edit** wird der Title durch ein `Input className="text-sm
w-64"` (256 px breit) ersetzt → kombiniert mit Sessions-Btn (36 px) + Plus-Btn
(36 px) + Lücken = 80 + 256 = 336 px links, plus rechte Buttons (88) = 424 px,
**weit über 375.** Die Right-Buttons werden vom flex-Layout dann verdrängt /
clipped.

**Klassifikation:** Frontend-Issue in unserem `main.ts:362` und Header-Layout.

### B5 — Hover-only Visuelle Feedback ohne Touch-Fallback (NIEDRIG)

Buttons haben in der Library Klassen wie `hover:bg-secondary`, `hover:text-foreground`.
Auf Touch-Geräten (`@media (hover: none)`) gibt es kein Hover → Buttons haben keinen
visuellen „aktiv jetzt"-Zustand bis sie tatsächlich gedrückt werden, fühlen sich
„tot" an.

**Klassifikation:** Cosmetic — kein Funktionsverlust. CSS-Override per `@media
(hover: none)` möglich.

### B6 — Konsole und Errors

- `Failed to load resource: 404 (favicon.ico)` — kosmetisch, kein Mobile-Issue
- 1 Warning beim Bootstrap (Lit dev-mode) — egal

Keine echten Mobile-spezifischen Errors während des Audit.

## Was nicht getestet wurde

- **Echter Login-Flow** (oauth2-proxy / Google) — passiert nur in Production. Wird
  in Phase 3 von Oliver auf seinem Android verifiziert.
- **Echtes Streaming + File-Upload** — bräuchte API-Key + Test-PDF. Funktional ist
  der File-Input geprüft (akzeptiert PDF/DOCX/XLSX, multiple, hidden — Standard).
- **Virtuelle Tastatur** — Playwright simuliert keine VK; Verifikation auf echtem
  Android in Phase 3.
- **Title-Edit-Mode mit langem Titel** — keine Session vorhanden zum Testen, aber
  per Code-Read (B4) als wahrscheinliches Overflow-Problem identifiziert.

## Priorisierung für Phase 2

1. **B1 (eigener Header)** — Touch-Targets in `main.ts` (Sessions, Plus, Theme,
   Settings) auf min 44 × 44 px (CSS in `app.css`)
2. **B2 (Custom-Provider-Card-Overflow)** — CSS-Override in `app.css`, der die
   Card-Action-Buttons auf Mobile unter die Card stackt (`flex-wrap` o. ä.)
3. **B4 (Title-Edit-Width)** — `main.ts:362` `className: "text-sm w-32 sm:w-64"`
4. **B5 (Hover-Fallback)** — CSS in `app.css`
5. **B1 (Library-Buttons)** — globaler `min-h-11 min-w-11` als Layer in `app.css`
   (wenn das Library-Layout nicht zerlegt)

**Out-of-scope (eigene Issues an Library / spätere Iteration):**
- B3 (Provider-Liste-Länge) — UX-Library-Issue, würde Patch / Filter brauchen
- Settings-/Sessions-Schließen-X (16 × 16 px) — Library-internal, Workaround
  schwer ohne Library-Touch

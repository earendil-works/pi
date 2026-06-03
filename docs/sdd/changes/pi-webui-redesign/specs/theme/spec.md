# theme Specification

## MODIFIED Requirements

### Requirement: Hermes Theme

The webui SHALL support a new `hermes` theme defined in `themes/hermes.json` with the following color tokens:
- `bg`: `#fafaf9` (warm off-white for main background)
- `bgSidebar`: `#f5f5f4` (slightly darker warm gray for sidebar)
- `bgBubble`: `#ffffff` (pure white for message bubbles)
- `text`: `#1c1917` (near-black for body text)
- `textMuted`: `#78716c` (warm gray for secondary text)
- `border`: `#e7e5e4` (light warm gray for borders)
- `accent`: `#3b82f6` (blue for active states and primary buttons)
- `accentText`: `#ffffff` (white text on accent backgrounds)

The theme SHALL be loaded by the browser at startup based on `webui.theme` in `~/.pi/agent/settings.json`. The theme SHALL be applied by injecting the color tokens as CSS custom properties on `:root` (e.g. `--accent: #3b82f6`).

#### Scenario: Default theme is applied
- **GIVEN** `settings.json` has `webui.theme: "hermes"`
- **WHEN** the webui loads
- **THEN** the browser fetches `themes/hermes.json` and injects CSS vars on `:root`
- **AND** components using `var(--accent)` render with the hermes blue

#### Scenario: Unknown theme falls back
- **GIVEN** `settings.json` has `webui.theme: "nonexistent"`
- **WHEN** the webui loads
- **THEN** the theme fetch fails gracefully
- **AND** the default colors remain in effect (no visual breakage)

### Requirement: Existing Themes Preserved

The existing `codewhale.json` theme and any other themes in the `themes/` directory SHALL continue to work without modification. Adding a new theme SHALL NOT break existing theme loading.

#### Scenario: codewhale theme still loads
- **GIVEN** `settings.json` has `webui.theme: "codewhale"`
- **WHEN** the webui loads
- **THEN** the codewhale theme is applied as before
- **AND** no visual regression occurs

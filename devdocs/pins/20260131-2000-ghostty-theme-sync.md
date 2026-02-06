# Pin: Ghostty Theme Sync Integration

**Goal:** Integrate Ghostty terminal theme synchronization as a built-in, default behavior for the mu coding agent. When running inside Ghostty, automatically detect the terminal's color scheme and generate a matching theme using semantic variable naming (bg, fg, accent, etc.) instead of palette-based naming (pink, cyan, dimmed1, etc.).

**Status:** Planning complete, ready for implementation

---

## Chosen Approach: "Respectful Sync" (Alternative B)

Check if running in Ghostty. If yes, compute a hash of Ghostty's colors. If a matching `ghostty-sync-<hash>` theme exists and is the current saved theme, use it. Otherwise, generate a new one and save it as the current theme. If not in Ghostty, use saved theme normally.

**Why:** Balances automation with user agency. Respects explicit theme choices. Hash-based naming gives free change detection.

---

## Abstractions

### 1. `GhosttyDetector`
Detects whether running inside Ghostty terminal and whether Ghostty CLI is available.
- `isGhosttyAvailable(): boolean` — Checks if `ghostty` command exists
- `isRunningInGhostty(): boolean` — Checks if `TERM_PROGRAM === "ghostty"`

### 2. `GhosttyColorParser`
Executes Ghostty's config export and parses color values.
- `fetchColors(): GhosttyColors | null` — Runs `ghostty +show-config` and parses
- `parseConfig(output: string): GhosttyColors` — Parses raw config string

### 3. `GhosttyThemeGenerator`
Generates a complete mu theme JSON from Ghostty colors using semantic naming.
- `generateTheme(colors: GhosttyColors): ThemeJson` — Creates theme with semantic vars
- `computeHash(colors: GhosttyColors): string` — Unique hash for change detection
- `deriveNeutrals(bg: string, fg: string): Neutrals` — Derives muted/dim/borderMuted

### 4. `GhosttyThemeManager`
Manages lifecycle of Ghostty-synced theme files.
- `getOrCreateTheme(): { name: string, isNew: boolean } | null`
- `cleanupOldThemes(currentName: string): void`
- `getThemePath(name: string): string`

### 5. `ThemeInitializer` (Extended)
Initializes theme system with Ghostty-aware selection.
- `initThemeWithGhostty(settingsManager: SettingsManager): void`
- `getEffectiveThemeName(settingsManager): string | undefined`

---

## Data Structures

### `GhosttyColors`
```typescript
interface GhosttyColors {
  background: string;        // Hex color, e.g., "#111113"
  foreground: string;        // Hex color, e.g., "#edeef0"
  palette: {
    0?: string;  // black
    1?: string;  // red → error
    2?: string;  // green → success
    3?: string;  // yellow → warning
    4?: string;  // blue → link
    5?: string;  // magenta → accent
    6?: string;  // cyan → accentAlt
    7?: string;  // white
    8?: string;  // bright black
    9?: string;  // bright red
    10?: string; // bright green
    11?: string; // bright yellow
    12?: string; // bright blue
    13?: string; // bright magenta
    14?: string; // bright cyan
    15?: string; // bright white
  };
}
```

### `SemanticThemeVars` (New convention)
```typescript
interface SemanticThemeVars {
  // Core semantic colors
  bg: string;           // Terminal background
  fg: string;           // Terminal foreground
  accent: string;       // Primary highlight (palette[5] or fallback)
  accentAlt: string;    // Secondary highlight (palette[6] or fallback)
  link: string;         // Links/borders (palette[4] or fallback)
  error: string;        // Errors/diff removed (palette[1] or fallback)
  success: string;      // Success/diff added (palette[2] or fallback)
  warning: string;      // Warnings/headings (palette[3] or fallback)
  
  // Derived neutrals (mixed from fg/bg)
  muted: string;        // 65% mix of fg/bg
  dim: string;          // 45% mix of fg/bg
  borderMuted: string;  // 25% mix of fg/bg
  
  // Derived backgrounds
  selectedBg: string;   // bg ±12 brightness
  userMsgBg: string;    // bg ±8 brightness
  toolPendingBg: string; // bg ±5 brightness
  toolSuccessBg: string; // bg mixed with success (88%)
  toolErrorBg: string;   // bg mixed with error (88%)
  customMsgBg: string;   // bg mixed with accent (92%)
  
  // Budget indicators (mixed colors)
  budgetGreen: string;
  budgetYellow: string;
  budgetOrange: string;
  budgetRed: string;
}
```

---

## Data Flow

```
main.ts startup
└── initThemeWithGhostty(settingsManager)
    ├── GhosttyDetector.isRunningInGhostty()?
    │   └── NO → return settingsManager.getTheme()
    │
    └── YES → GhosttyDetector.isGhosttyAvailable()?
        └── NO → return settingsManager.getTheme()
        
        └── YES → GhosttyThemeManager.getOrCreateTheme()
            ├── Compute hash of Ghostty colors
            ├── Check if ghostty-sync-<hash>.json exists
            │   └── YES → return existing theme name
            │
            └── NO → generate new theme
                ├── GhosttyColorParser.fetchColors()
                │   └── exec("ghostty +show-config")
                │   └── parse output → GhosttyColors
                │
                └── GhosttyThemeGenerator.generateTheme(colors)
                    ├── Map ANSI slots to semantic colors
                    ├── Derive neutrals from bg/fg
                    ├── Derive background variants
                    └── Return ThemeJson
                
                ├── Write to ~/.mu/agent/themes/ghostty-sync-<hash>.json
                ├── GhosttyThemeManager.cleanupOldThemes()
                └── Return new theme name
    
    └── settingsManager.setTheme(themeName)  // Persist
    └── initTheme(themeName)  // Existing loading
```

---

## Files to Modify/Create

### New Files
1. `packages/coding-agent/src/theme/ghostty-sync.ts` — Main module with all Ghostty sync logic
2. `packages/coding-agent/test/ghostty-sync.test.ts` — Unit tests

### Modified Files
1. `packages/coding-agent/src/theme/dark.json` — Migrate to semantic variable names
2. `packages/coding-agent/src/theme/light.json` — Migrate to semantic variable names
3. `packages/coding-agent/src/main.ts` — Replace `initTheme()` call with `initThemeWithGhostty()`

### Optional (Follow-up)
4. `packages/coding-agent/src/theme/theme-schema.json` — Fix `toolText` → `toolTitle`/`toolOutput`

---

## ANSI Color Mapping

| ANSI Slot | Semantic Role | Fallback |
|-----------|---------------|----------|
| palette[1] | error | #cc6666 |
| palette[2] | success | #98c379 |
| palette[3] | warning | #e5c07b |
| palette[4] | link | #61afef |
| palette[5] | accent | #c678dd |
| palette[6] | accentAlt | #56b6c2 |
| bg/fg mix | muted | 65% fg + 35% bg |
| bg/fg mix | dim | 45% fg + 55% bg |
| bg/fg mix | borderMuted | 25% fg + 75% bg |

---

## Verification Checklist

- [ ] Unit tests for GhosttyDetector
- [ ] Unit tests for GhosttyColorParser
- [ ] Unit tests for GhosttyThemeGenerator
- [ ] Manual test: Start in Ghostty → theme generated
- [ ] Manual test: Change Ghostty theme → new theme on restart
- [ ] Manual test: Start outside Ghostty → uses saved theme
- [ ] Manual test: /theme command shows Ghostty-synced theme
- [ ] Manual test: Select non-Ghostty theme → persists on restart
- [ ] Verify dark.json uses semantic vars
- [ ] Verify light.json uses semantic vars
- [ ] npm run check passes

---

## Design Decisions

1. **Semantic variable naming:** `bg`, `fg`, `accent`, `error` instead of `pink`, `cyan`, `background`
2. **Hash-based change detection:** `ghostty-sync-<hash>.json` naming
3. **Respectful sync:** Only sync when no explicit non-Ghostty theme is selected
4. **No real-time watching:** Check on startup only
5. **No disable flag:** Not needed in initial implementation

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Startup slowdown (100ms for ghostty +show-config) | Only run when in Ghostty |
| Theme file bloat | Cleanup old themes on each generation |
| Breaking existing themes | Keep schema backward-compatible |
| TERM_PROGRAM chain (tmux in Ghostty) | Check full chain if needed |

---

## Next Steps

1. Create `ghostty-sync.ts` module
2. Migrate `dark.json` and `light.json` to semantic vars
3. Update `main.ts` integration
4. Write tests
5. Manual verification
6. npm run check

---

**Created:** 2026-01-31 20:00 GMT+8  
**Author:** Agent  
**Status:** Ready for implementation

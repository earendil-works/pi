# Spec: Security TUI Theme & Customization

## Overview
Tema dark/hacker personalizado para operações de cibersegurança. Baseado no sistema de temas do pi-tui (`packages/coding-agent/src/modes/interactive/theme/theme.ts`).

## Theme File: `sec-hacker.json`

```json
{
  "$schema": "https://pi.dev/schemas/theme.json",
  "name": "sec-hacker",
  "vars": {
    "matrix-green": "#00ff00",
    "matrix-green-dim": "#008800",
    "matrix-green-bright": "#88ff88",
    "alert-red": "#ff0044",
    "alert-orange": "#ff8800",
    "warning-yellow": "#ffff00",
    "info-cyan": "#00ffff",
    "purple": "#aa00ff",
    "bg-black": "#000000",
    "bg-dark": "#0a0a0a",
    "bg-card": "#111111",
    "border-dim": "#1a1a1a",
    "text-dim": "#444444"
  },
  "colors": {
    "accent": "matrix-green",
    "border": "border-dim",
    "borderAccent": "matrix-green",
    "borderMuted": "text-dim",
    "success": "matrix-green",
    "error": "alert-red",
    "warning": "warning-yellow",
    "muted": "text-dim",
    "dim": "text-dim",
    "text": "matrix-green",
    "thinkingText": "purple",
    "selectedBg": "bg-card",
    "scrollbarThumb": "matrix-green-dim",
    "searchMatchBg": "matrix-green-dim",
    "searchMatchText": "bg-black",
    "userMessageBg": "bg-card",
    "userMessageText": "matrix-green-bright",
    "customMessageBg": "bg-card",
    "customMessageText": "info-cyan",
    "customMessageLabel": "purple",
    "toolPendingBg": "bg-card",
    "toolSuccessBg": "bg-dark",
    "toolErrorBg": "alert-red",
    "toolTitle": "matrix-green-bright",
    "toolOutput": "matrix-green",
    "mdHeading": "matrix-green-bright",
    "mdLink": "info-cyan",
    "mdLinkUrl": "matrix-green-dim",
    "mdCode": "warning-yellow",
    "mdCodeBlock": "bg-card",
    "mdCodeBlockBorder": "border-dim",
    "mdQuote": "info-cyan",
    "mdQuoteBorder": "matrix-green-dim",
    "mdHr": "border-dim",
    "mdListBullet": "matrix-green",
    "toolDiffAdded": "matrix-green",
    "toolDiffRemoved": "alert-red",
    "toolDiffContext": "text-dim",
    "syntaxComment": "text-dim",
    "syntaxKeyword": "matrix-green-bright",
    "syntaxFunction": "info-cyan",
    "syntaxVariable": "warning-yellow",
    "syntaxString": "matrix-green",
    "syntaxNumber": "alert-orange",
    "syntaxType": "purple",
    "syntaxOperator": "matrix-green-dim",
    "syntaxPunctuation": "text-dim",
    "thinkingOff": "text-dim",
    "thinkingMinimal": "purple",
    "thinkingLow": "purple",
    "thinkingMedium": "purple",
    "thinkingHigh": "purple",
    "thinkingXhigh": "purple",
    "thinkingMax": "purple",
    "bashMode": "alert-orange"
  },
  "export": {
    "pageBg": "bg-black",
    "cardBg": "bg-card",
    "infoBg": "bg-dark"
  }
}
```

---

## Theme Variants

### `sec-hacker-light.json` (for light terminals)
```json
{
  "name": "sec-hacker-light",
  "vars": {
    "matrix-green": "#006600",
    "matrix-green-dim": "#004400",
    "matrix-green-bright": "#008800",
    "alert-red": "#cc0033",
    "alert-orange": "#cc6600",
    "warning-yellow": "#ccaa00",
    "info-cyan": "#009999",
    "purple": "#8800cc",
    "bg-black": "#ffffff",
    "bg-dark": "#f5f5f5",
    "bg-card": "#eeeeee",
    "border-dim": "#dddddd",
    "text-dim": "#666666"
  },
  "colors": { ... same structure, adjusted for light bg ... }
}
```

### `sec-redteam.json` (red team focused)
```json
{
  "name": "sec-redteam",
  "vars": {
    "blood-red": "#ff0033",
    "blood-red-dim": "#880011",
    "blood-red-bright": "#ff4466",
    "flame-orange": "#ff6600",
    "ember-orange": "#ff8833",
    "ash-gray": "#333333",
    "charcoal": "#1a1a1a",
    "bg-void": "#050505",
    "bg-dark": "#0d0d0d",
    "bg-card": "#151515"
  },
  "colors": {
    "accent": "blood-red",
    "border": "ash-gray",
    "borderAccent": "blood-red",
    "borderMuted": "ash-gray",
    "success": "blood-red-bright",
    "error": "blood-red",
    "warning": "flame-orange",
    "muted": "ash-gray",
    "dim": "ash-gray",
    "text": "blood-red-bright",
    "thinkingText": "flame-orange",
    ...
  }
}
```

### `sec-blueteam.json` (blue team / defense focused)
```json
{
  "name": "sec-blueteam",
  "vars": {
    "defense-blue": "#0066ff",
    "defense-blue-dim": "#003388",
    "defense-blue-bright": "#4499ff",
    "alert-red": "#ff0044",
    "safe-green": "#00cc44",
    "intel-cyan": "#00ffff",
    "bg-void": "#000811",
    "bg-dark": "#001122",
    "bg-card": "#001a33"
  },
  "colors": {
    "accent": "defense-blue",
    "border": "defense-blue-dim",
    "borderAccent": "defense-blue",
    "borderMuted": "defense-blue-dim",
    "success": "safe-green",
    "error": "alert-red",
    "warning": "intel-cyan",
    "muted": "defense-blue-dim",
    "dim": "defense-blue-dim",
    "text": "defense-blue-bright",
    "thinkingText": "intel-cyan",
    ...
  }
}
```

---

## Custom UI Components

### 1. Status Indicator (Footer)
```typescript
// packages/coding-agent/src/modes/interactive/components/sec-status.ts
import { Component } from "@earendil-works/pi-tui";

export class SecStatusIndicator extends Component {
  // Shows: current target, scan status, active sessions, threat level
  // Colors: green=idle, yellow=scanning, red=active exploit, purple=post-exploit
}
```

### 2. Target Bar (Header)
```typescript
// packages/coding-agent/src/modes/interactive/components/sec-target-bar.ts
export class SecTargetBar extends Component {
  // Displays: target IP/domain, scope, methodology phase, findings count
  // Click to change target, right-click for scope menu
}
```

### 3. Findings Panel (Widget)
```typescript
// packages/coding-agent/src/modes/interactive/components/sec-findings-panel.ts
export class SecFindingsPanel extends Component {
  // Real-time findings feed with severity badges
  // Filter by: severity, type, phase, host
  // Click finding → open finding editor
}
```

### 4. Tool Output Theming
```typescript
// Custom renderResult for security tools
const secToolRenderResult = (result, options, theme, context) => {
  // Colorize: ports (green=open, red=closed), vulns (CVSS colors)
  // Icons: 🔓 open, 🔒 closed, ⚠️ vuln, 💀 critical
  // Collapsible sections for large outputs (nmap XML, nuclei JSON)
};
```

---

## Keybinding Customization

### Security-Specific Keybindings
```json
// ~/.pi/keybindings.json or .pi/keybindings.json
{
  "security": {
    "ctrl+shift+s": "scan:ports",
    "ctrl+shift+v": "scan:vulns",
    "ctrl+shift+e": "exploit:search",
    "ctrl+shift+p": "exploit:payload",
    "ctrl+shift+a": "analyze:logs",
    "ctrl+shift+t": "analyze:intel",
    "ctrl+shift+n": "pentest:new",
    "ctrl+shift+f": "pentest:finding",
    "ctrl+shift+r": "report:generate",
    "ctrl+shift+h": "help:security",
    "f1": "sec:cheatsheet",
    "f2": "sec:targets",
    "f3": "sec:findings",
    "f4": "sec:sessions"
  }
}
```

---

## Theme Installation

```bash
# Global theme
mkdir -p ~/.pi/themes
cp sec-hacker.json ~/.pi/themes/

# Project theme
mkdir -p .pi/themes
cp sec-hacker.json .pi/themes/

# Apply theme
pi --theme sec-hacker
# or in config.json:
# { "theme": "sec-hacker" }
```

---

## Auto Theme Detection (Light/Dark)

```json
// ~/.pi/config.json
{
  "theme": "sec-hacker-light/sec-hacker"
}
```

---

## Custom Components Registration

```typescript
// In extension factory (sec-ui extension)
export const secUiExtension: InlineExtension = {
  name: "sec-ui",
  factory: (ctx) => {
    ctx.ui.setHeader((tui, theme) => new SecTargetBar(tui, theme, ctx));
    ctx.ui.setFooter((tui, theme, footerData) => new SecFooter(tui, theme, footerData, ctx));
    ctx.ui.setWidget("findings", (tui, theme) => new SecFindingsPanel(tui, theme, ctx), { placement: "belowEditor" });
    ctx.ui.setWidget("status", (tui, theme) => new SecStatusIndicator(tui, theme, ctx), { placement: "aboveEditor" });

    // Custom keybindings
    ctx.keybindings.addKeybinding({
      key: "ctrl+shift+s",
      command: "sec:scan:ports",
      description: "Quick port scan",
      category: "Security",
    });

    return { components: { SecTargetBar, SecFindingsPanel, SecStatusIndicator, SecFooter } };
  },
};
```

---

## Syntax Highlighting for Security Formats

```json
// Additional syntax highlighting rules for:
// - Nmap XML output
// - Nuclei JSON/YAML templates
// - BloodHound Cypher queries
// - MITRE ATT&CK technique IDs (T1xxx)
// - CVE IDs (CVE-YYYY-NNNNN)
// - CVSS vectors (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H)
// - Hash formats (MD5, SHA1, SHA256, NTLM, Kerberos)
// - Indicators of Compromise (IPs, domains, hashes, mutexes)
```

---

## Animation & Effects (Optional)

```typescript
// Matrix rain background (subtle, low opacity)
// Scan line sweep on tool execution
// Pulse on critical finding
// Typewriter effect for exploit output
// Configurable: --no-animations flag
```
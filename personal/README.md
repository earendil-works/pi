# `personal/` — Geräte-spezifische Pi-Konfigurationen

Dieser Ordner hält die Pi-Configs für die einzelnen Geräte des Owners (`ogerets-glitch`). Konfigurations-Updates fließen via `git pull` automatisch ins Runtime-Verzeichnis (`~/.pi/agent/`), weil die Pi-Configs im Home-Verzeichnis Symlinks ins Repo sind.

## Struktur

```
personal/
├── shared/              ← geräteübergreifend (Modelle, Aliase, .bashrc-Snippet)
│   ├── models.json
│   ├── aliases.json
│   └── .bashrc.snippet
├── vps/                 ← VPS-spezifisch (Hetzner, User opipi)
│   ├── settings.json    (Default Kimi, kein Voice)
│   ├── README.md
│   └── {models,aliases,.bashrc.snippet}.json → ../shared/...
└── laptop/              ← Laptop-spezifisch (oliver-OMEN, Linux Mint)
    ├── settings.json    (Default Kimi + Voice-Block)
    └── README.md
```

## Geteilt vs. geräte-spezifisch

| Bereich | shared/ | vps/ | laptop/ |
|---|---|---|---|
| Provider Infomaniak (5 Modelle: Kimi, Qwen, Apertus, Gemma, Ministral) | ✅ | symlink | symlink |
| Provider `llama-local` (qwen3.6 35B) | ✅ | symlink (inert auf VPS) | symlink |
| Modell-Aliase (`coding`, `reasoning`, …) | ✅ | symlink | symlink |
| `.bashrc`-Snippet (PATH, Key-Loads, `PI_FINDER_MODELS`) | ✅ | symlink | source |
| Voice-Block (Whisper, Ctrl+Shift+V) | — | — | ✅ |
| `defaultProvider`/`defaultModel` | — | infomaniak/Kimi | infomaniak/Kimi |
| Pi-Extensions (9 synchron) | — | gleiche Liste | gleiche Liste |

## Pi-Extensions auf beiden Geräten

`pi-review-loop`, `pi-secret-guard`, `pi-finder-subagent`, `pi-model-switch`, `@tintinweb/pi-tasks`, `pi-subagents`, `pi-schedule-prompt`, `@joemccann/pi-pdf`, `@codexstar/pi-listen`

`pi-listen` ist auf VPS installiert, aber ohne Voice-Block in `settings.json` inaktiv.

## Repo-Workflow

- **Direkt-Push auf `main` ist via Hook blockiert** — Pflicht: Feature-Branch + PR
- **Security-Workflow** (Gitleaks, TruffleHog, Semgrep, npm-audit) läuft automatisch bei jedem PR
- **Dependabot** überwacht Dependencies

## Geräte-spezifische Setup-Anleitungen

- VPS: siehe [`vps/README.md`](vps/README.md)
- Laptop: siehe [`laptop/README.md`](laptop/README.md)

# Pi auf VPS — `personal/vps/`

Dieser Ordner enthält die VPS-spezifische Pi-Konfiguration. Auf dem VPS sind die Config-Dateien per Symlink in `~/.pi/agent/` eingebunden, sodass `git pull` im Fork automatisch zur Konfig-Aktualisierung führt.

> **Geteilte Configs:** `models.json`, `aliases.json` und `.bashrc.snippet` liegen seit dem Laptop-Sync in [`personal/shared/`](../shared/) und sind hier als repo-interne Symlinks (`../shared/...`) eingebunden. Der lokale Symlink-Pfad bleibt für VPS-Setups unverändert (`~/pi/personal/vps/...`).

## Komponenten

| Datei | Symlink-Ziel | Zweck |
|---|---|---|
| `models.json` → `../shared/models.json` | `~/.pi/agent/models.json` | Provider Infomaniak + `llama-local` (auf VPS inert) |
| `settings.json` | `~/.pi/agent/settings.json` | Default-Provider/Modell + Extension-Liste, kein Voice-Block |
| `aliases.json` → `../shared/aliases.json` | `~/.pi/agent/extensions/model-switch/aliases.json` | Aliase fuer `pi-model-switch` |
| `.bashrc.snippet` → `../shared/.bashrc.snippet` | append in `~/.bashrc` | PATH, Key-Source, `PI_FINDER_MODELS` |

## Aktiver Modell-Katalog (Infomaniak, Stand 2026-05-07)

### Chat-/Completion-Modelle (in Pi nutzbar)

| Modell-ID | Alias | Default-Use-Case |
|---|---|---|
| `moonshotai/Kimi-K2.6` | `coding` | **Default**, Coding und langer Kontext (200k) |
| `Qwen/Qwen3.5-122B-A10B-FP8` | `reasoning` | Hartes Reasoning, lange Antworten, Subagent |
| `swiss-ai/Apertus-70B-Instruct-2509` | `swiss` | Swiss-AI-Heritage, Allrounder |
| `google/gemma-4-31B-it` | `all` | Allrounder, mittlere Groesse |
| `mistralai/Ministral-3-14B-Instruct-2512` | `fast` / `cheap` | Schnell, kompakt, Fallback |

### Embedding-Modelle (NICHT in Pi)

Pi unterstuetzt nur Chat/Completion-Schemas. Die Embedding-Modelle (`bge_multilingual_gemma2`, `mini_lm_l12_v2`, `Qwen/Qwen3-Embedding-8B`) werden separat von Skills wie `wisdom` direkt gegen den Infomaniak-Endpunkt aufgerufen. Pi-Provider-Config ist dafuer nicht vorgesehen.

## Aufruf-Beispiele

```bash
pi -p "Frage..."                                              # Default: Kimi
pi --model coding -p "..."                                    # Alias coding -> Kimi
pi --model reasoning -p "..."                                 # Alias reasoning -> Qwen
pi --provider infomaniak --model swiss-ai/Apertus-70B-Instruct-2509 -p "..."
pi -p "Nutze finder, um in /home/opipi nach .md zu suchen"   # Subagent via PI_FINDER_MODELS
```

## Neuinstallation auf einem anderen VPS oder gleichem User

```bash
# 1. User anlegen (falls nicht vorhanden)
sudo useradd -m -s /bin/bash opipi
sudo loginctl enable-linger opipi

# 2. Fork klonen + bauen
sudo -iu opipi bash -c '
  git clone https://github.com/ogerets-glitch/pi.git ~/pi
  cd ~/pi && git remote add upstream https://github.com/earendil-works/pi.git
  npm ci && npm run build

  # PATH-Konfig
  npm config set prefix ~/.npm-global
  mkdir -p ~/.npm-global/bin
  ln -sf ~/pi/packages/coding-agent/dist/cli.js ~/.npm-global/bin/pi
  chmod +x ~/pi/packages/coding-agent/dist/cli.js

  # Extensions (separat auf npm) — synchroner Stack mit dem Laptop
  pi install npm:pi-review-loop npm:pi-secret-guard npm:pi-finder-subagent \
    npm:pi-model-switch npm:@tintinweb/pi-tasks npm:pi-subagents \
    npm:pi-schedule-prompt npm:@joemccann/pi-pdf npm:@codexstar/pi-listen

  # Symlinks aufs Repo
  mkdir -p ~/.pi/agent ~/.pi/agent/extensions/model-switch
  ln -sf ~/pi/personal/vps/models.json   ~/.pi/agent/models.json
  ln -sf ~/pi/personal/vps/settings.json ~/.pi/agent/settings.json
  ln -sf ~/pi/personal/vps/aliases.json  ~/.pi/agent/extensions/model-switch/aliases.json

  # .bashrc-Snippet einbinden
  grep -q "personal/vps/.bashrc.snippet" ~/.bashrc \
    || cat ~/pi/personal/vps/.bashrc.snippet >> ~/.bashrc
'

# 3. Key-File anlegen (Wert nicht ins Transcript)
sudo -iu opipi bash -c '
  mkdir -p ~/.pi-keys && chmod 700 ~/.pi-keys
  echo "INFOMANIAK_API_KEY=<dein-key>" > ~/.pi-keys/infomaniak.env
  chmod 600 ~/.pi-keys/infomaniak.env
'
```

## Updates

```bash
sudo -iu opipi bash -c '
  cd ~/pi
  git fetch upstream
  git rebase upstream/main      # Upstream-Aenderungen einziehen
  npm ci && npm run build       # neu bauen
'
```

Wenn der Fork eigene Configs ausserhalb von `personal/` und `.github/` aendert, kann es Konflikte geben. Aktuell beruehren wir nur diese beiden Pfade.

## Sicherheit

- Pi laeuft als dedizierter User `opipi`, nicht root.
- Key liegt in `~/.pi-keys/infomaniak.env` (chmod 600, opipi:opipi), nicht im Repo.
- `models.json` referenziert den Key per ENV-Var-Name `INFOMANIAK_API_KEY`, kein Klartext.
- Repo selbst ist Public-Fork mit `.github/workflows/security.yml` (Gitleaks, TruffleHog, Semgrep, npm-audit) und Dependabot.

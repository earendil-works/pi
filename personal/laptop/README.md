# Pi auf Laptop — `personal/laptop/`

Dieser Ordner enthält die Laptop-spezifische Pi-Konfiguration für `oliver-OMEN` (Linux Mint). Die geräteübergreifenden Configs (Modelle, Aliase, `.bashrc`-Snippet) liegen in [`personal/shared/`](../shared/) und werden von beiden Geräten geteilt.

## Komponenten

| Datei | Symlink-Ziel | Zweck |
|---|---|---|
| `settings.json` | `~/.pi/agent/settings.json` | Default-Provider/Modell + Voice-Block + Extension-Liste |
| `../shared/models.json` | `~/.pi/agent/models.json` | Provider Infomaniak (geteilt) + `llama-local` (Laptop-only effektiv) |
| `../shared/aliases.json` | `~/.pi/agent/extensions/model-switch/aliases.json` | Aliase für `pi-model-switch` |
| `../shared/.bashrc.snippet` | source in `~/.bashrc` | PATH, Key-Source, `PI_FINDER_MODELS` |

## Unterschied zu VPS

- **Voice-Block aktiv** (Whisper-Turbo lokal, Hotkey `Ctrl+Shift+V`, deutsch). Auf VPS deaktiviert (kein Mikrofon).
- **`llama-local` Provider in `shared/models.json`** zeigt auf einen lokalen llama.cpp-Server (`http://127.0.0.1:8080/v1`). Auf VPS harmlos inert (Server läuft dort nicht).
- Pi-Installation via `npm i -g @earendil-works/pi-coding-agent` (kein Source-Build wie auf VPS).

## Installation auf einem neuen Linux-Mint-Gerät

```bash
# 1. Pi installieren (nutzt vorhandene npm-global Konfiguration)
npm config set prefix ~/.npm-global
mkdir -p ~/.npm-global/bin
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
npm i -g @earendil-works/pi-coding-agent@latest

# 2. Fork klonen (sparse-checkout reicht — kein Source-Build nötig)
git clone git@github.com:ogerets-glitch/pi.git ~/pi
cd ~/pi
git remote add upstream https://github.com/earendil-works/pi.git

# 3. Symlinks setzen
mkdir -p ~/.pi/agent ~/.pi/agent/extensions/model-switch
ln -sf ~/pi/personal/shared/models.json   ~/.pi/agent/models.json
ln -sf ~/pi/personal/laptop/settings.json ~/.pi/agent/settings.json
ln -sf ~/pi/personal/shared/aliases.json  ~/.pi/agent/extensions/model-switch/aliases.json

# 4. .bashrc-Snippet einbinden
grep -q "personal/shared/.bashrc.snippet" ~/.bashrc \
  || echo '[ -f ~/pi/personal/shared/.bashrc.snippet ] && source ~/pi/personal/shared/.bashrc.snippet' >> ~/.bashrc

# 5. Keys anlegen (Werte nicht ins Transcript)
mkdir -p ~/.pi-keys && chmod 700 ~/.pi-keys
echo "INFOMANIAK_API_KEY=<dein-key>" > ~/.pi-keys/infomaniak.env
echo "GEMINI_API_KEY=<dein-key>" > ~/.pi-keys/gemini.env
chmod 600 ~/.pi-keys/*.env

# 6. Voice-Modell laden (Whisper-Turbo)
# Pi lädt das Modell beim ersten Voice-Toggle automatisch nach ~/.pi/models/whisper-turbo/

# 7. Extensions installieren
pi install npm:pi-review-loop npm:pi-secret-guard npm:pi-finder-subagent \
  npm:pi-model-switch npm:@tintinweb/pi-tasks npm:pi-subagents \
  npm:pi-schedule-prompt npm:@joemccann/pi-pdf npm:@codexstar/pi-listen
```

## Updates

```bash
# Pi-Binary
npm i -g @earendil-works/pi-coding-agent@latest

# Configs aus dem Repo
cd ~/pi && git pull

# Extensions
pi update
```

## Aufruf-Beispiele

```bash
pi -p "Frage..."                     # Default: Kimi via Infomaniak
pi --model coding -p "..."           # Alias coding -> Kimi
pi --model reasoning -p "..."        # Alias reasoning -> Qwen 3.5 122B
pi --provider llama-local -p "..."   # Lokaler Llama-Server (qwen3.6 35B)
# Voice: Ctrl+Shift+V toggelt Whisper-Aufnahme
```

## Sicherheit

- Pi läuft als User `oliver`, nicht root.
- API-Keys liegen in `~/.pi-keys/{infomaniak,gemini}.env` (chmod 600), nicht im Repo.
- `models.json` referenziert den Infomaniak-Key per ENV-Var-Name `INFOMANIAK_API_KEY`, kein Klartext.
- `settings.json` enthält keine Secrets — nur Provider-Default, Voice-Block und Paketliste.
- Keine Telegram-Bot-Konfig — der Bot läuft (falls genutzt) bewusst auf einem anderen Pfad oder Gerät, Token nie ins Repo.

# Build Remote Agent — pairing device (pi)

Pi can use **Build Remote Agent** as a pairing device: the paid iOS/Android
app spectates (and can inject into) this desktop `pi` session through the
free MIT `gbr-agent`. Phone and PC never open ports to each other.

This is documentation, not a runtime TypeScript extension. Prefer a third-party
[pi package](../docs/packages.md) or [monopi](https://github.com/ifiokjr/monopi)
over changing pi core.

Website: https://grokbuildremote.com/
Agent: https://github.com/LinespottingOrg/GrokBuildRemote-Agents (MIT)
Protocol: `gbr/1` · need agent **v0.6.0+**

Independent product by Linespotting AB. Not affiliated with xAI or SpaceX.

## Install + pair

```bash
# macOS / Linux
curl -fsSL https://grokbuildremote.com/install.sh | bash
gbr-agent version          # must print v0.6.0 or newer
gbr-agent pair             # QR in browser + printed 8-char code
gbr-agent run              # leave running
```

```powershell
# Windows
irm https://grokbuildremote.com/install.ps1 | iex
gbr-agent version
gbr-agent pair
gbr-agent run
```

Phone: open Build Remote Agent → **Scan QR from computer** (or type the 8-char
code). **Unpair** in Settings before changing PCs. Force-close is not enough.

## Attach this `pi` session

After `gbr-agent run`:

- HTTP Bot API: `http://127.0.0.1:8788`
- MCP stdio: clone the agent repo and run `node mcp/gbr-mcp/bin/gbr-mcp.js`

```bash
curl -sS http://127.0.0.1:8788/health
curl -sS http://127.0.0.1:8788/v1/sessions
```

```bash
git clone https://github.com/LinespottingOrg/GrokBuildRemote-Agents.git
cd GrokBuildRemote-Agents/mcp/gbr-mcp && npm install
node bin/gbr-mcp.js --diagnose
```

Point pi MCP config at that stdio command (absolute path). Phone is spectator.
Do not commit mailbox keys. Phone **Settings → Bot API** is the only place the
relay key is copied.

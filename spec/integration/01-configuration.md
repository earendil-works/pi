# Spec: Sec-Agent Integration & Configuration

## Overview
Configuração unificada, estrutura de diretórios, CLI commands, e integração entre extensions, prompts, skills e TUI.

---

## Directory Structure

```
.sec-agent/                    # Project-local config (gitignored)
├── config.json                # Main configuration
├── extensions/                # Local extensions
│   ├── sec-scanner/
│   ├── sec-exploit/
│   ├── sec-analysis/
│   ├── sec-pentest/
│   └── sec-report/
├── prompts/                   # Local prompt templates
│   ├── recon-passive.md
│   ├── vuln-web.md
│   └── ...
├── skills/                    # Local skills
│   ├── recon/
│   ├── vuln/
│   ├── exploit/
│   ├── pentest/
│   └── analysis/
├── themes/                    # Local themes
│   ├── sec-hacker.json
│   ├── sec-redteam.json
│   └── sec-blueteam.json
├── keybindings.json           # Local keybindings
├── reports/                   # Generated reports
│   ├── 2024-01-15-pentest-acme/
│   │   ├── executive.pdf
│   │   ├── technical.html
│   │   └── findings.json
│   └── ...
├── evidence/                  # Pentest evidence
│   ├── screenshots/
│   ├── pcaps/
│   └── logs/
├── wordlists/                 # Custom wordlists
│   ├── subdomains.txt
│   ├── directories.txt
│   └── passwords.txt
├── templates/                 # Report templates
│   ├── executive.md
│   ├── technical.md
│   └── compliance.md
└── sessions/                  # Session files (auto)

~/.sec-agent/                  # Global user config
├── config.json
├── extensions/
├── prompts/
├── skills/
├── themes/
├── keybindings.json
├── wordlists/
├── templates/
├── credentials/               # Encrypted credentials (age/GPG)
│   ├── shodan.api
│   ├── censys.api
│   ├── vt.api
│   └── github.token
└── cache/                     # Tool output cache
```

---

## Configuration Schema

### `config.json`
```json
{
  "$schema": "https://sec-agent.dev/schema/config.json",
  "version": "1.0",
  "profile": "redteam",              // "redteam" | "blueteam" | "pentest" | "custom"
  "theme": "sec-hacker",
  "autoTheme": "sec-hacker-light/sec-hacker",
  "language": "pt-BR",
  "extensions": {
    "sec-scanner": {
      "enabled": true,
      "priority": 10,
      "config": {
        "defaultPorts": "1-1000,8080,8443",
        "defaultTiming": "T4",
        "nmapPath": "nmap",
        "masscanPath": "masscan",
        "rustscanPath": "rustscan",
        "nucleiPath": "nuclei",
        "nucleiTemplates": "~/.sec-agent/nuclei-templates/",
        "maxRate": 1000,
        "allowedTargets": ["10.0.0.0/8", "192.168.0.0/16", "*.corp.local"]
      }
    },
    "sec-exploit": {
      "enabled": true,
      "priority": 20,
      "config": {
        "msfPath": "msfconsole",
        "msfRpcPort": 55553,
        "exploitDbPath": "~/.sec-agent/exploitdb/",
        "searchsploitPath": "searchsploit",
        "donutPath": "donut",
        "c2": {
          "default": "sliver",
          "sliver": { "server": "localhost:31337", "operator": "operator" },
          "covenant": { "url": "https://c2.example.com", "token": "${CRED:covenant.token}" },
          "mythic": { "url": "http://localhost:7443", "token": "${CRED:mythic.token}" }
        },
        "payload": {
          "defaultEncoder": "x64/xor",
          "defaultIterations": 3,
          "avEvasion": true
        }
      }
    },
    "sec-analysis": {
      "enabled": true,
      "priority": 30,
      "config": {
        "vtApiKey": "${CRED:virustotal.api}",
        "otxApiKey": "${CRED:otx.api}",
        "mispUrl": "https://misp.example.com",
        "mispKey": "${CRED:misp.key}",
        "yaraRules": "~/.sec-agent/yara-rules/",
        "volatilityPath": "volatility3",
        "zeekPath": "zeek",
        "suricataPath": "suricata"
      }
    },
    "sec-pentest": {
      "enabled": true,
      "priority": 40,
      "config": {
        "defaultMethodology": "ptes",
        "methodologies": {
          "ptes": "~/.sec-agent/skills/pentest/methodology/ptes/",
          "owasp": "~/.sec-agent/skills/pentest/methodology/owasp/",
          "mitre": "~/.sec-agent/skills/pentest/methodology/mitre-attack/"
        },
        "findingTemplates": "~/.sec-agent/templates/findings/",
        "evidenceDir": "./evidence/",
        "autoScreenshot": true
      }
    },
    "sec-report": {
      "enabled": true,
      "priority": 50,
      "config": {
        "defaultTemplate": "technical",
        "defaultFormat": "pdf",
        "outputDir": "./reports/",
        "templates": {
          "executive": "~/.sec-agent/templates/executive.md",
          "technical": "~/.sec-agent/templates/technical.md",
          "compliance": "~/.sec-agent/templates/compliance.md"
        },
        "pdfEngine": "weasyprint",
        "includeEvidence": true,
        "includeAppendices": true
      }
    },
    "sec-ui": {
      "enabled": true,
      "priority": 5,
      "config": {
        "showTargetBar": true,
        "showFindingsPanel": true,
        "showStatusIndicator": true,
        "animations": true,
        "matrixRain": false,
        "compactMode": false
      }
    }
  },
  "tools": {
    "timeout": 300000,
    "maxConcurrent": 5,
    "auditLog": true,
    "auditLogPath": "~/.sec-agent/audit.log"
  },
  "security": {
    "requireConfirmation": true,
    "dangerousToolsRequireYes": true,
    "scopeEnforcement": "warn",
    "allowedTargets": [],
    "blockedTargets": ["127.0.0.1", "localhost", "169.254.169.254"],
    "credentialStore": "age",
    "credentialPath": "~/.sec-agent/credentials/"
  },
  "cli": {
    "defaultMode": "interactive",
    "historySize": 10000,
    "completion": true
  }
}
```

---

## Profile Presets

### Red Team Profile (`sec-agent --profile redteam`)
```json
{
  "profile": "redteam",
  "theme": "sec-redteam",
  "extensions": {
    "sec-scanner": { "enabled": true, "config": { "defaultTiming": "T5", "maxRate": 5000 } },
    "sec-exploit": { "enabled": true, "config": { "avEvasion": true, "c2.default": "sliver" } },
    "sec-analysis": { "enabled": false },
    "sec-pentest": { "enabled": true, "config": { "defaultMethodology": "mitre" } },
    "sec-report": { "enabled": true, "config": { "defaultTemplate": "technical" } },
    "sec-ui": { "enabled": true, "config": { "matrixRain": true, "compactMode": true } }
  }
}
```

### Blue Team Profile (`sec-agent --profile blueteam`)
```json
{
  "profile": "blueteam",
  "theme": "sec-blueteam",
  "extensions": {
    "sec-scanner": { "enabled": true, "config": { "defaultTiming": "T3", "maxRate": 100 } },
    "sec-exploit": { "enabled": false },
    "sec-analysis": { "enabled": true, "config": { "yaraRules": "~/.sec-agent/yara-rules/blue/" } },
    "sec-pentest": { "enabled": true, "config": { "defaultMethodology": "nist" } },
    "sec-report": { "enabled": true, "config": { "defaultTemplate": "compliance" } },
    "sec-ui": { "enabled": true, "config": { "showFindingsPanel": true, "animations": false } }
  }
}
```

### Pentest Profile (`sec-agent --profile pentest`)
```json
{
  "profile": "pentest",
  "theme": "sec-hacker",
  "extensions": {
    "sec-scanner": { "enabled": true },
    "sec-exploit": { "enabled": true },
    "sec-analysis": { "enabled": true },
    "sec-pentest": { "enabled": true, "config": { "defaultMethodology": "ptes" } },
    "sec-report": { "enabled": true, "config": { "defaultTemplate": "technical", "defaultFormat": "pdf" } },
    "sec-ui": { "enabled": true }
  }
}
```

---

## CLI Commands

### Main Commands
```bash
sec-agent                          # Interactive mode with sec profile
sec-agent --profile redteam        # Load redteam profile
sec-agent --profile blueteam       # Load blueteam profile
sec-agent --profile pentest        # Load pentest profile
sec-agent -p "scan ports 10.0.0.1" # Print mode with prompt
sec-agent --target 10.0.0.1        # Set initial target
sec-agent --scope "10.0.0.0/8"     # Set allowed scope
sec-agent --theme sec-redteam      # Override theme
sec-agent --no-extensions          # Disable all extensions
sec-agent --extension sec-scanner  # Enable specific extension
sec-agent --prompt-template ./my-prompts/
sec-agent --skill ./my-skills/
sec-agent --config ./custom-config.json
sec-agent --audit-log              # Enable audit logging
sec-agent --dry-run                # Preview commands without execution
```

### Security Commands (slash commands in interactive)
```bash
# Target management
/target set 10.0.0.1
/target add 192.168.1.0/24
/target scope 10.0.0.0/8
/target clear

# Scanning
/scan:ports 10.0.0.1 --top100
/scan:services 10.0.0.1
/scan:vulns 10.0.0.1 --severity high
/scan:web https://target.com --wordlist /path/wordlist.txt
/scan:ssl target.com:443

# Exploitation
/exploit:search CVE-2021-44228
/exploit:payload reverse_tcp 10.0.0.1 4444 --format exe
/exploit:run exploit/windows/smb/ms17_010_eternalblue 10.0.0.1
/exploit:post meterpreter 1 --module enum

# Analysis
/analyze:logs /var/log/auth.log --since 24h
/analyze:pcap capture.pcap --filter "http"
/analyze:malware sample.exe --sandbox
/analyze:intel 1.2.3.4 --source otx
/analyze:forensics memory.dmp --profile Win10x64

# Pentest workflow
/pentest:new "ACME Corp" --methodology ptes
/pentest:phase recon start
/pentest:phase scan complete --note "Found 47 open ports"
/pentest:checklist --framework owasp
/pentest:finding "SQL Injection in login" --cvss 8.2 --evidence screenshot.png
/pentest:evidence 1 screenshot.png request.log

# Reporting
/report:generate --template executive --format pdf
/report:generate --template technical --format html
/report:template create custom --from technical
/report:export --format csv --severity high

# C2
/c2:connect sliver
/c2:sessions
/c2:interact 1

# Utilities
/sec:cheatsheet          # Quick reference card
/sec:targets             # Target manager
/sec:findings            # Findings browser
/sec:sessions            # Session manager
/sec:wordlists           # Wordlist manager
/sec:credentials         # Credential vault
/help:security           # Security commands help
```

---

## Credential Management

### Age Encryption
```bash
# Generate keypair
age-keygen -o ~/.sec-agent/age.key

# Encrypt credential
echo "shodan_api_key_xxx" | age -r $(cat ~/.sec-agent/age.pub) > ~/.sec-agent/credentials/shodan.api.age

# Config references
# "shodanApiKey": "${CRED:shodan.api}"
```

### Credential Store API (for extensions)
```typescript
interface CredentialStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
  // Auto-decrypts .age files using age key from SEC_AGENT_AGE_KEY env or ~/.sec-agent/age.key
}
```

---

## Audit Logging

### Log Format (JSONL)
```json
{"timestamp":"2024-01-15T10:30:00Z","user":"analyst","session":"pentest-acme-001","tool":"port_scan","target":"10.0.0.1","params":{"ports":"1-1000","timing":"T4"},"result":"success","findings":47}
{"timestamp":"2024-01-15T10:35:00Z","user":"analyst","session":"pentest-acme-001","tool":"exploit_run","target":"10.0.0.1","params":{"module":"exploit/windows/smb/ms17_010_eternalblue"},"result":"success","session_id":1}
```

### Audit Log Query
```bash
sec-agent audit --session pentest-acme-001
sec-agent audit --tool port_scan --since 24h
sec-agent audit --target 10.0.0.1 --format csv
```

---

## Environment Variables

```bash
# Core
SEC_AGENT_CONFIG=~/.sec-agent/config.json
SEC_AGENT_PROFILE=pentest
SEC_AGENT_THEME=sec-hacker

# Credentials
SEC_AGENT_AGE_KEY=~/.sec-agent/age.key
SEC_AGENT_CRED_DIR=~/.sec-agent/credentials/

# API Keys (alternative to credential store)
SHODAN_API_KEY=xxx
CENSYS_API_ID=xxx
CENSYS_API_SECRET=xxx
VIRUSTOTAL_API_KEY=xxx
OTX_API_KEY=xxx
GITHUB_TOKEN=xxx

# Tools
NMAP_PATH=/usr/bin/nmap
MASSCAN_PATH=/usr/bin/masscan
NUCLEI_PATH=/usr/bin/nuclei
MSFCONSOLE_PATH=/usr/bin/msfconsole
DONUT_PATH=/usr/local/bin/donut

# Scope enforcement
SEC_ALLOWED_TARGETS="10.0.0.0/8,192.168.0.0/16,*.corp.local"
SEC_BLOCKED_TARGETS="127.0.0.1,localhost,169.254.169.254"

# Behavior
SEC_REQUIRE_CONFIRMATION=true
SEC_DANGEROUS_TOOLS_REQUIRE_YES=true
SEC_AUDIT_LOG=true
SEC_DRY_RUN=false
```

---

## Extension Development Template

```typescript
// packages/coding-agent/src/extensions/sec-scanner/index.ts
import type { InlineExtension } from "../../core/extensions/types.ts";
import { defineTool } from "../../core/extensions/types.ts";
import { Type } from "typebox";

const portScanTool = defineTool({
  name: "port_scan",
  label: "Port Scan",
  description: "TCP/UDP port scanning with nmap/masscan/rustscan",
  parameters: Type.Object({
    target: Type.String({ description: "Target IP, hostname, or CIDR" }),
    ports: Type.Optional(Type.String({ default: "1-1000", description: "Port range" })),
    scanType: Type.Optional(Type.Union([Type.Literal("syn"), Type.Literal("connect"), Type.Literal("udp"), Type.Literal("masscan")], { default: "syn" })),
    timing: Type.Optional(Type.Union([Type.Literal("T0"), Type.Literal("T1"), Type.Literal("T2"), Type.Literal("T3"), Type.Literal("T4"), Type.Literal("T5")], { default: "T4" })),
    outputFormat: Type.Optional(Type.Union([Type.Literal("json"), Type.Literal("xml"), Type.Literal("normal")], { default: "json" })),
  }),
  promptSnippet: "port_scan(target, ports?, scanType?, timing?) - Scan ports on target",
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    // Implementation
    const { target, ports, scanType, timing, outputFormat } = params;
    // Validate target against scope
    // Execute scanner
    // Return structured result
  },
  renderResult: (result, options, theme, context) => {
    // Custom rendering with colorized ports
  },
});

export default {
  name: "sec-scanner",
  factory: (ctx) => ({
    tools: [portScanTool, serviceEnumTool, vulnScanTool, webScanTool, sslScanTool],
    commands: [scanPortsCmd, scanServicesCmd, scanVulnsCmd, scanWebCmd, scanSslCmd],
    keybindings: [
      { key: "ctrl+shift+s", command: "scan:ports", description: "Quick port scan" },
      { key: "ctrl+shift+v", command: "scan:vulns", description: "Quick vuln scan" },
    ],
    ui: {
      widgets: {
        scanProgress: ScanProgressWidget,
        scanResults: ScanResultsPanel,
      },
    },
  }),
} satisfies InlineExtension;
```

---

## Installation Script

```bash
# install-sec-agent.sh
#!/bin/bash
set -euo pipefail

REPO="https://github.com/user/sec-agent-fork"
INSTALL_DIR="${HOME}/.sec-agent"

echo "Installing Sec-Agent..."

# Clone or update
if [ -d "$INSTALL_DIR" ]; then
  cd "$INSTALL_DIR" && git pull
else
  git clone "$REPO" "$INSTALL_DIR"
fi

# Install dependencies
cd "$INSTALL_DIR"
npm ci --ignore-scripts

# Build
npm run build

# Create symlinks
ln -sf "$INSTALL_DIR/bin/sec-agent" ~/.local/bin/sec-agent

# Initialize config
sec-agent --init

# Download wordlists
sec-agent wordlists update

# Download nuclei templates
nuclei -update-templates

echo "Sec-Agent installed! Run 'sec-agent' to start."
```

---

## CI/CD Integration

```yaml
# .github/workflows/sec-agent.yml
name: Sec-Agent Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci --ignore-scripts
      - run: npm run check
      - run: npm run test:unit
      - run: |
          # Security tool tests (require tools installed)
          sudo apt-get update && sudo apt-get install -y nmap masscan nuclei
          sec-agent --dry-run -p "scan ports 127.0.0.1"
```
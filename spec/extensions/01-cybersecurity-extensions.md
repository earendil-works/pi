# Spec: Cybersecurity Extensions

## Overview
Extensions para operações de cibersegurança: scanning, exploitation, analysis, pentesting e geração de relatórios.

## Architecture
- Baseado no sistema de extensões existente (`packages/coding-agent/src/extensions/`)
- Cada extensão registra tools, commands, keybindings e UI components
- Extensões carregadas via `--extension` CLI flag ou auto-descoberta em `~/.pi/extensions/`

---

## 1. Security Scanner Extension (`sec-scanner`)

### Purpose
Port scanning, service enumeration, vulnerability scanning, web app scanning.

### Tools
| Tool | Description | Parameters |
|------|-------------|------------|
| `port_scan` | TCP/UDP port scan (nmap, masscan, rustscan) | `target`, `ports`, `scan_type`, `timing`, `output_format` |
| `service_enum` | Service version detection | `target`, `ports`, `banner_grab` |
| `vuln_scan` | Vulnerability scan (nmap NSE, nuclei templates) | `target`, `templates`, `severity`, `rate_limit` |
| `web_scan` | Web app scanning (nikto, dirb, feroxbuster) | `target`, `wordlist`, `extensions`, `threads`, `recursive` |
| `ssl_scan` | SSL/TLS configuration analysis | `target`, `port`, `protocols`, `ciphers` |

### Commands
- `/scan:ports <target> [ports]` - Quick port scan
- `/scan:services <target>` - Service enumeration
- `/scan:vulns <target> [--severity critical|high|medium|low]` - Vuln scan
- `/scan:web <url> [--wordlist path]` - Web directory/file enumeration
- `/scan:ssl <target>[:port]` - SSL/TLS analysis

### Keybindings
- `Ctrl+Shift+S` - Quick port scan current target
- `Ctrl+Shift+V` - Quick vuln scan

### UI Components
- `ScanResultsPanel` - Interactive results with filtering
- `ScanProgressWidget` - Real-time progress during scans
- `TargetInputDialog` - Target configuration

---

## 2. Exploitation Extension (`sec-exploit`)

### Purpose
Exploit development, payload generation, post-exploitation, C2 integration.

### Tools
| Tool | Description | Parameters |
|------|-------------|------------|
| `exploit_search` | Search exploits (ExploitDB, GitHub, Metasploit) | `cve`, `service`, `platform`, `type` |
| `payload_gen` | Generate payloads (msfvenom, donut, custom) | `payload_type`, `lhost`, `lport`, `encoder`, `format`, `arch` |
| `exploit_run` | Execute exploit module | `module`, `target`, `options`, `payload` |
| `post_exploit` | Post-exploitation modules | `session_id`, `module`, `options` |
| `c2_interact` | C2 framework interaction (Sliver, Covenant, Mythic) | `framework`, `command`, `session` |

### Commands
- `/exploit:search <cve|service>` - Search exploits
- `/exploit:payload <type> <lhost> <lport> [options]` - Generate payload
- `/exploit:run <module> <target> [options]` - Run exploit
- `/exploit:post <session> <module>` - Post-exploitation
- `/c2:connect <framework>` - Connect to C2
- `/c2:sessions` - List C2 sessions

### Keybindings
- `Ctrl+Shift+E` - Exploit search
- `Ctrl+Shift+P` - Payload generator

### UI Components
- `ExploitBrowser` - Searchable exploit database
- `PayloadBuilder` - Interactive payload configuration
- `SessionManager` - C2 session management panel

---

## 3. Analysis Extension (`sec-analysis`)

### Purpose
Log analysis, traffic analysis, malware analysis, forensics, threat intel.

### Tools
| Tool | Description | Parameters |
|------|-------------|------------|
| `log_analyze` | Parse and analyze logs (syslog, apache, nginx, windows) | `source`, `format`, `time_range`, `filters`, `patterns` |
| `pcap_analyze` | Network traffic analysis (tshark, zeek, suricata) | `file`, `filters`, `protocols`, `extract_files` |
| `malware_analyze` | Static/dynamic malware analysis | `file`, `sandbox`, `yara_rules`, `vt_api_key` |
| `threat_intel` | Threat intelligence lookup (OTX, MISP, AbuseIPDB) | `indicator`, `type`, `sources` |
| `forensics` | Disk/memory forensics (volatility, autopsy, sleuthkit) | `image`, `profile`, `plugins`, `output` |

### Commands
- `/analyze:logs <source> [--format json|text] [--since 1h]` - Log analysis
- `/analyze:pcap <file> [--filter "http"]` - PCAP analysis
- `/analyze:malware <file> [--sandbox]` - Malware analysis
- `/analyze:intel <ip|domain|hash> [--source otx|misp]` - Threat intel
- `/analyze:forensics <image> [--profile Win10x64]` - Forensics

### Keybindings
- `Ctrl+Shift+A` - Quick log analysis
- `Ctrl+Shift+T` - Threat intel lookup

### UI Components
- `LogViewer` - Filterable log viewer with syntax highlighting
- `PacketInspector` - PCAP packet detail view
- `ThreatIntelPanel` - IOC enrichment display

---

## 4. Pentesting Extension (`sec-pentest`)

### Purpose
Pentest workflow management, methodology tracking, checklist, reporting.

### Tools
| Tool | Description | Parameters |
|------|-------------|------------|
| `pentest_init` | Initialize pentest project | `name`, `scope`, `methodology`, `team` |
| `pentest_phase` | Manage pentest phases | `phase`, `action`, `notes`, `findings` |
| `checklist` | Pentest checklist (OWASP, PTES, NIST) | `framework`, `phase`, `status` |
| `finding_create` | Create finding with CVSS | `title`, `description`, `cvss`, `evidence`, `remediation` |
| `evidence_manage` | Manage evidence (screenshots, logs, pcaps) | `finding_id`, `files`, `tags` |

### Commands
- `/pentest:new <name> [--methodology owasp|ptes|nist]` - New pentest
- `/pentest:phase <recon|scan|exploit|post|report> [start|complete|note]` - Phase management
- `/pentest:checklist [--framework owasp]` - Show checklist
- `/pentest:finding <title> [--cvss 7.5]` - Create finding
- `/pentest:evidence <finding_id> <files...>` - Attach evidence

### Keybindings
- `Ctrl+Shift+N` - New pentest project
- `Ctrl+Shift+F` - Create finding

### UI Components
- `PentestDashboard` - Phase progress, findings summary
- `ChecklistPanel` - Interactive methodology checklist
- `FindingEditor` - Rich finding editor with CVSS calculator
- `EvidenceGallery` - Evidence attachment viewer

---

## 5. Report Generation Extension (`sec-report`)

### Purpose
Automated report generation from findings, evidence, templates.

### Tools
| Tool | Description | Parameters |
|------|-------------|------------|
| `report_generate` | Generate report from pentest data | `template`, `format`, `output`, `findings`, `evidence` |
| `report_template` | Manage report templates | `action`, `name`, `content`, `variables` |
| `export_findings` | Export findings to formats | `format`, `filter`, `output` |

### Commands
- `/report:generate [--template executive|technical|compliance] [--format pdf|html|docx|markdown]` - Generate report
- `/report:template <list|create|edit|delete> [name]` - Template management
- `/report:export [--format csv|json|sarif] [--severity high]` - Export findings

### Templates
- `executive` - Executive summary (1-2 pages)
- `technical` - Detailed technical report
- `compliance` - PCI-DSS, ISO 27001, NIST mappings
- `custom` - User-defined templates

### UI Components
- `ReportPreview` - Live preview during generation
- `TemplateEditor` - Template editor with variable insertion
- `ReportHistory` - Previously generated reports

---

## Extension Registration

Each extension follows the pattern:
```typescript
// packages/coding-agent/src/extensions/sec-scanner/index.ts
import type { InlineExtension } from "../../core/extensions/types.ts";

const secScannerExtension: InlineExtension = {
  name: "sec-scanner",
  factory: (ctx) => {
    // Register tools, commands, keybindings, UI
    return {
      tools: [portScanTool, serviceEnumTool, ...],
      commands: [scanPortsCmd, scanServicesCmd, ...],
      keybindings: [{ key: "ctrl+shift+s", command: "scan:ports" }],
      ui: { widgets: { scanProgress: ScanProgressWidget } },
    };
  },
};

export default secScannerExtension;
```

---

## Configuration

```json
// ~/.pi/config.json or project .pi/config.json
{
  "extensions": {
    "sec-scanner": {
      "enabled": true,
      "defaultPorts": "1-1000",
      "defaultTiming": "T4",
      "nmapPath": "/usr/bin/nmap"
    },
    "sec-exploit": {
      "enabled": true,
      "exploitDbPath": "~/.exploitdb",
      "msfPath": "/usr/bin/msfconsole"
    },
    "sec-report": {
      "enabled": true,
      "defaultTemplate": "technical",
      "defaultFormat": "pdf",
      "outputDir": "./reports"
    }
  }
}
```

---

## Security Considerations

- All tools require explicit user confirmation before execution
- Dangerous operations (exploit, payload) require `--yes` flag or interactive confirm
- Audit logging for all security tool executions
- Network tools respect `SEC_ALLOWED_TARGETS` env var for scope restriction
- Credentials never logged; use secure credential store
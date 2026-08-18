# Sec-Agent Specification

Especificação completa para o fork de cibersegurança do pi agent harness.

## Estrutura da Spec

```
spec/
├── extensions/
│   └── 01-cybersecurity-extensions.md    # 5 extensões principais
├── prompts/
│   └── 01-security-prompt-templates.md   # Prompt templates para segurança
├── skills/
│   └── 01-cybersecurity-skills.md        # Skills (SKILL.md) organizadas
├── tui/
│   └── 01-security-theme.md              # Temas hacker/redteam/blueteam
└── integration/
    └── 01-configuration.md               # Configuração unificada, CLI, profiles
```

## Resumo das Features

### 1. Extensions (5 extensões)
| Extensão | Tools | Propósito |
|----------|-------|-----------|
| `sec-scanner` | port_scan, service_enum, vuln_scan, web_scan, ssl_scan | Reconnaissance & scanning |
| `sec-exploit` | exploit_search, payload_gen, exploit_run, post_exploit, c2_interact | Exploitation & C2 |
| `sec-analysis` | log_analyze, pcap_analyze, malware_analyze, threat_intel, forensics | Analysis & forensics |
| `sec-pentest` | pentest_init, pentest_phase, checklist, finding_create, evidence_manage | Pentest workflow |
| `sec-report` | report_generate, report_template, export_findings | Report generation |
| `sec-ui` | - | Custom TUI components |

### 2. Prompt Templates (20+ templates)
- **Recon:** passive, active, cloud (AWS/Azure/GCP)
- **Vuln:** web (OWASP Top 10), API, network
- **Exploit:** web, payload, post-exploitation
- **Pentest:** scope, methodology (PTES/OWASP/MITRE)
- **Report:** finding, executive, technical, compliance

### 3. Skills (estrutura hierárquica)
```
skills/
├── recon/ (passive, active, cloud)
├── vuln/ (web, network, config)
├── exploit/ (web, network, payload, post)
├── pentest/ (methodology, workflow, reporting)
├── analysis/ (logs, traffic, malware, threat-intel, forensics)
└── tools/ (nmap, burp, metasploit, bloodhound)
```

### 4. TUI Themes (4 temas)
| Tema | Perfil | Cores |
|------|--------|-------|
| `sec-hacker` | Padrão | Matrix green/black |
| `sec-hacker-light` | Light terminal | Green on white |
| `sec-redteam` | Red team | Blood red/flame orange |
| `sec-blueteam` | Blue team | Defense blue/intel cyan |

### 5. Integration
- **Profiles:** redteam, blueteam, pentest, custom
- **Config:** JSON com schema, env vars, credential store (age)
- **CLI:** 30+ slash commands, keybindings
- **Audit:** JSONL logging, query CLI
- **Scope enforcement:** allowed/blocked targets

## Próximos Passos

1. **Implementar extensões** em `packages/coding-agent/src/extensions/sec-*`
2. **Criar prompt templates** em `~/.pi/prompts/` e `.pi/prompts/`
3. **Criar skills** em `~/.pi/skills/` e `.pi/skills/`
4. **Adicionar temas** em `~/.pi/themes/` e `.pi/themes/`
5. **Configurar keybindings** em `~/.pi/keybindings.json`
6. **Testar integração** com `sec-agent --profile pentest`

## Comandos Úteis

```bash
# Desenvolvimento
cd packages/coding-agent
npm run dev                    # Hot reload
npm run check                  # Typecheck + lint

# Testar extensão
sec-agent --extension sec-scanner -p "scan ports 10.0.0.1"

# Testar tema
sec-agent --theme sec-redteam

# Testar profile
sec-agent --profile redteam

# Debug
sec-agent --dry-run -p "exploit payload reverse_tcp 10.0.0.1 4444"
```
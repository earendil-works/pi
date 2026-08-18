# Spec: Security Prompt Templates

## Overview
Prompt templates para operações de cibersegurança. Carregados via `--prompt-template` ou auto-descoberta em `~/.pi/prompts/` e `.pi/prompts/`.

## Template Format
Frontmatter YAML + Markdown body com placeholders `$1`, `$2`, `$@`, `${1:-default}`.

---

## 1. Reconnaissance Templates

### `/recon:passive <target>`
```markdown
---
name: recon-passive
description: Passive reconnaissance using OSINT sources
argument-hint: <target> [--sources all|shodan|censys|virustotal|github]
---
Perform passive reconnaissance on **$1**.

Sources to use: ${2:-all}

Tasks:
1. Subdomain enumeration (crt.sh, certspotter, subfinder)
2. DNS records (A, AAAA, MX, TXT, NS, CNAME)
3. SSL certificate transparency logs
4. Shodan/Censys host intelligence (if API keys configured)
5. GitHub/GitLab code search for secrets/configs
6. Wayback Machine / Common Crawl for historical URLs
7. Email harvesting (Hunter.io, LinkedIn)
8. Technology fingerprinting (Wappalyzer, BuiltWith)

Output structured findings for each source. Flag high-value discoveries.
```

### `/recon:active <target>`
```markdown
---
name: recon-active
description: Active reconnaissance with port/service scanning
argument-hint: <target> [--ports top100|all|custom] [--timing T4]
---
Perform active reconnaissance on **$1**.

Port range: ${2:-top100}
Timing template: ${3:-T4}

Tasks:
1. Port scan (TCP SYN, UDP top 100)
2. Service version detection (-sV)
3. OS fingerprinting (-O)
4. Nmap NSE scripts for discovered services
5. Screenshot web services (gowitness, aquatone)
6. Directory enumeration on web ports (feroxbuster)
7. SMB/NFS/SNMP enumeration if ports open

Correlate findings with passive recon. Identify attack surface.
```

### `/recon:cloud <provider> <target>`
```markdown
---
name: recon-cloud
description: Cloud infrastructure reconnaissance (AWS, Azure, GCP)
argument-hint: <aws|azure|gcp> <target> [--depth basic|deep]
---
Cloud reconnaissance for **$1** target: **$2**.

Depth: ${3:-basic}

AWS Tasks:
- S3 bucket enumeration (bucket names, permissions)
- IAM role/user enumeration
- EC2 instance metadata (if SSRF)
- Lambda function enumeration
- CloudFormation stack analysis
- Route53 hosted zones

Azure Tasks:
- Storage account enumeration
- Key Vault discovery
- App Service enumeration
- Azure AD tenant enumeration
- Resource group mapping

GCP Tasks:
- Storage bucket enumeration
- Cloud Function discovery
- IAM policy analysis
- Compute instance metadata
- Secret Manager enumeration
```

---

## 2. Vulnerability Assessment Templates

### `/vuln:web <url>`
```markdown
---
name: vuln-web
description: Web application vulnerability assessment
argument-hint: <url> [--auth cookie|header|basic] [--scope domain|path]
---
Web vulnerability assessment for **$1**.

Authentication: ${2:-none}
Scope: ${3:-domain}

Checklist (OWASP Top 10 + ASVS):
- A01: Broken Access Control (IDOR, path traversal, privilege escalation)
- A02: Cryptographic Failures (weak TLS, sensitive data exposure)
- A03: Injection (SQLi, NoSQLi, command injection, LDAPi, XSS)
- A04: Insecure Design (business logic flaws, missing rate limits)
- A05: Security Misconfiguration (default creds, debug enabled, headers)
- A06: Vulnerable Components (outdated libs, CVE matching)
- A07: Auth/Session Failures (weak passwords, session fixation, JWT issues)
- A08: Software Integrity Failures (CI/CD, unsigned dependencies)
- A09: Logging/Monitoring Failures (insufficient audit trails)
- A10: SSRF (internal service access, cloud metadata)

Additional:
- API security (GraphQL, REST, gRPC)
- Client-side security (CSP, CORS, postMessage)
- Business logic testing
- Race conditions

For each finding: Provide PoC, impact, CVSS, remediation.
```

### `/vuln:api <spec_url>`
```markdown
---
name: vuln-api
description: API security testing (OpenAPI/Swagger/GraphQL)
argument-hint: <openapi.json|graphql_endpoint> [--auth bearer|apikey]
---
API security assessment for **$1**.

Authentication: ${2:-none}

Tasks:
1. Schema analysis (excessive data exposure, missing validation)
2. Authentication/Authorization testing (BOLA, BFLA, broken auth)
3. Input validation (injection, mass assignment, parameter pollution)
4. Rate limiting & DoS testing
5. Business logic flaws
6. GraphQL-specific (introspection, depth limiting, batching attacks)
7. API versioning & deprecated endpoints
8. Documentation vs implementation drift

Output: OpenAPI-annotated findings with request/response examples.
```

### `/vuln:network <target>`
```markdown
---
name: vuln-network
description: Network infrastructure vulnerability scan
argument-hint: <target> [--ports all|custom] [--credentials user:pass]
---
Network vulnerability assessment for **$1**.

Port scope: ${2:-all}
Credentials: ${3:-none}

Checks:
- Missing patches (OS, firmware)
- Default/weak credentials (SSH, RDP, SMB, SNMP, databases)
- Misconfigured services (anonymous FTP, open NFS, LDAP)
- Vulnerable protocols (SMBv1, TLS 1.0/1.1, weak ciphers)
- Network device config issues (Cisco, Juniper, Fortinet)
- VPN/concentrator vulnerabilities
- Wireless network assessment (if in scope)

Use authenticated scans where credentials provided.
```

---

## 3. Exploitation Templates

### `/exploit:web <vuln_type> <target>`
```markdown
---
name: exploit-web
description: Web exploitation guidance and payloads
argument-hint: <sqli|xss|rce|ssrf|idor|xxe|deserialization> <target> [--poc]
---
Exploitation guidance for **$1** on **$2**.

PoC requested: ${3:-false}

Provide:
1. Root cause analysis
2. Exploitation prerequisites
3. Payload examples (encoded, bypass techniques)
4. Automated exploitation script (if applicable)
5. Post-exploitation paths
6. Detection evasion techniques
7. Impact demonstration (data access, RCE, privilege escalation)

⚠️ Only for authorized testing. Include safety checks.
```

### `/exploit:payload <type> <lhost> <lport>`
```markdown
---
name: exploit-payload
description: Generate and explain payloads
argument-hint: <reverse_shell|bind_shell|meterpreter|custom> <lhost> <lport> [--encoder] [--format exe|dll|ps1|py|raw]
---
Generate **$1** payload for **$2:$3**.

Encoder: ${4:-none}
Format: ${5:-raw}

Provide:
1. msfvenom / donut / custom command
2. Payload explanation (stages, communication)
3. AV/EDR evasion techniques (encoding, encryption, obfuscation)
4. Delivery methods (macro, HTA, shortcut, service, scheduled task)
5. Listener setup (Metasploit, netcat, custom C2)
6. Migration/injection techniques
7. Persistence options
```

### `/exploit:post <session_type> <session_id>`
```markdown
---
name: exploit-post
description: Post-exploitation enumeration and persistence
argument-hint: <meterpreter|shell|c2> <session_id> [--module all|enum|persist|creds|pivot]
---
Post-exploitation for **$1** session **$2**.

Module: ${3:-enum}

Enumeration:
- System info (OS, patches, architecture, AV/EDR)
- User/group enumeration, token privileges
- Network config (interfaces, routes, ARP, firewall)
- Running processes, services, scheduled tasks
- Installed software, drivers, kernel modules
- Registry analysis (autostarts, services, credentials)
- Browser credentials, history, cookies
- WiFi profiles, VPN configs
- Cloud credentials (AWS, Azure, GCP CLI configs)

Credential Access:
- LSASS dumping (sekurlsa, mimikatz, pypykatz)
- SAM/SYSTEM extraction
- DPAPI master keys
- Kerberos tickets (tgt, service tickets)
- Browser/email/client credentials
- Vault/keyring secrets
- SSH keys, GPG keys

Persistence:
- Registry run keys, services, WMI, scheduled tasks
- COM hijacking, DLL hijacking, path interception
- SSH authorized_keys, web shells
- Golden/Silver ticket, Skeleton Key
- Cloud persistence (IAM roles, service accounts)

Lateral Movement:
- Pass-the-hash/ticket/key
- SMB/WinRM/SSH/RDP relay
- DCOM, WMI, WinRM, PSRemoting
- Kerberos delegation (unconstrained, constrained)
- Cloud lateral (IAM, metadata service)
```

---

## 4. Pentest Workflow Templates

### `/pentest:scope <client> <target>`
```markdown
---
name: pentest-scope
description: Define pentest scope and rules of engagement
argument-hint: <client_name> <target_scope> [--methodology owasp|ptes|nist|custom]
---
Pentest Scope Definition for **$1**.

Target Scope: **$2**
Methodology: ${3:-ptes}

Rules of Engagement:
- Authorized IP ranges / domains
- Excluded systems / networks
- Testing windows (timezone, maintenance windows)
- DoS/DDoS policy (allowed/not allowed)
- Social engineering scope (phishing, vishing, physical)
- Data handling (PII, credentials, screenshots)
- Communication channels (Slack, email, phone)
- Escalation contacts (client, provider)
- Reporting requirements (format, frequency, language)
- Legal/Compliance (NDA, MSA, insurance)

Deliverables:
- Executive summary
- Technical findings (CVSS, evidence, remediation)
- Risk register
- Attestation letter
- Retest scope
```

### `/pentest:methodology <framework>`
```markdown
---
name: pentest-methodology
description: Display pentest methodology checklist
argument-hint: <owasp|ptes|nist|mitre|custom> [--phase recon|threat_model|vuln_analysis|exploitation|post_exploitation|reporting]
---
**$1** Methodology Checklist

Phase: ${2:-all}

${1 === "owasp" ? `
## OWASP Testing Guide v4.2
### Information Gathering (OTG-INFO)
- [ ] OTG-INFO-001: Conduct Search Engine Discovery
- [ ] OTG-INFO-002: Fingerprint Web Server
- [ ] OTG-INFO-003: Review Webserver Metafiles
- [ ] OTG-INFO-004: Enumerate Applications
- [ ] OTG-INFO-005: Review Webpage Comments/Metadata
- [ ] OTG-INFO-006: Identify Entry Points
- [ ] OTG-INFO-007: Map Execution Paths
- [ ] OTG-INFO-008: Fingerprint Web App Framework
- [ ] OTG-INFO-009: Fingerprint Web App
- [ ] OTG-INFO-010: Map Application Architecture

### Configuration Management (OTG-CONFIG)
- [ ] OTG-CONFIG-001: Test Network Infrastructure Config
- [ ] OTG-CONFIG-002: Test Application Platform Config
- [ ] OTG-CONFIG-003: Test File Extensions Handling
- [ ] OTG-CONFIG-004: Review Old Backup/Unreferenced Files
- [ ] OTG-CONFIG-005: Enumerate Infrastructure/Admin Interfaces
- [ ] OTG-CONFIG-006: Test HTTP Methods
- [ ] OTG-CONFIG-007: Test HTTP Strict Transport Security
- [ ] OTG-CONFIG-008: Test RIA Cross Domain Policy
- [ ] OTG-CONFIG-009: Test File Permission
- [ ] OTG-CONFIG-010: Test for Subdomain Takeover

### Identity Management (OTG-IDENT)
- [ ] OTG-IDENT-001: Test Role Definitions
- [ ] OTG-IDENT-002: Test User Registration Process
- [ ] OTG-IDENT-003: Test Account Provisioning Process
- [ ] OTG-IDENT-004: Test Account Enumeration
- [ ] OTG-IDENT-005: Test Weak Username Policy

... (continue all OWASP categories)
` : ''}

${1 === "ptes" ? `
## PTES (Penetration Testing Execution Standard)
### Pre-engagement Interactions
- [ ] Scope definition
- [ ] Rules of Engagement
- [ ] Legal agreements
- [ ] Communication plan

### Intelligence Gathering
- [ ] Open Source Intelligence (OSINT)
- [ ] Network reconnaissance
- [ ] Application reconnaissance
- [ ] Personnel reconnaissance

### Threat Modeling
- [ ] Identify assets
- [ ] Identify threats
- [ ] Vulnerability analysis
- [ ] Risk assessment

### Vulnerability Analysis
- [ ] Passive analysis
- [ ] Active analysis
- [ ] Validation
- [ ] Prioritization

### Exploitation
- [ ] Exploit development
- [ ] Vulnerability verification
- [ ] Privilege escalation
- [ ] Pivoting

### Post Exploitation
- [ ] Pillaging
- [ ] Persistence
- [ ] Cleanup
- [ ] Reporting

### Reporting
- [ ] Executive summary
- [ ] Technical findings
- [ ] Risk rating
- [ ] Remediation guidance
` : ''}
```

---

## 5. Reporting Templates

### `/report:finding <title>`
```markdown
---
name: report-finding
description: Create structured vulnerability finding
argument-hint: <title> [--cvss 7.5] [--severity critical|high|medium|low|info]
---
# Finding: $1

**CVSS v3.1:** ${2:-7.5} (${3:-High})
**CWE:** ${4:-CWE-XXX}
**Affected Component:** ${5:-Component name}
**Location:** ${6:-URL/Path/IP}

## Description
${7:-Detailed description of the vulnerability, root cause, and conditions.}

## Impact
${8:-Business and technical impact. Data exposure, system compromise, etc.}

## Proof of Concept
\`\`\`
${9:-Step-by-step reproduction with commands/requests}
\`\`\`

## Evidence
${10:-Screenshots, logs, request/response dumps, PCAP references}

## Remediation
${11:-Specific fix: code change, config update, patch, architecture change}

## References
- ${12:-CVE-XXXX-XXXX, OWASP, vendor advisory, etc.}

## Detection
${13:-How to detect this vulnerability (WAF rules, IDS signatures, log patterns)}
```

### `/report:executive <project>`
```markdown
---
name: report-executive
description: Generate executive summary
argument-hint: <project_name> [--findings critical:2,high:5,medium:10]
---
# Executive Summary: $1

**Assessment Period:** ${2:-Date range}
**Scope:** ${3:-Target systems/applications}
**Methodology:** ${4:-PTES / OWASP / Custom}

## Key Metrics
- **Critical:** ${5:-0}
- **High:** ${6:-0}
- **Medium:** ${7:-0}
- **Low:** ${8:-0}
- **Informational:** ${9:-0}
- **Total Findings:** ${10:-0}

## Risk Posture
${11:-Overall risk rating and business impact summary}

## Top Risks
1. **${12:-Finding Title}** (Critical) - ${13:-One-line impact}
2. **${14:-Finding Title}** (High) - ${15:-One-line impact}
3. **${16:-Finding Title}** (High) - ${17:-One-line impact}

## Recommendations
### Immediate (0-30 days)
${18:-Critical/High findings requiring urgent action}

### Short-term (30-90 days)
${19:-Medium findings and architectural improvements}

### Long-term (90+ days)
${20:-Strategic security program improvements}

## Compliance Mapping
${21:-PCI-DSS, ISO 27001, NIST CSF, SOC2 control mappings}
```

---

## Template Variables Reference

| Variable | Description | Example |
|----------|-------------|---------|
| `$1`..`$9` | Positional arguments | `/recon:passive example.com` → `$1=example.com` |
| `$@` / `$ARGUMENTS` | All arguments joined | `example.com --depth deep` |
| `${1:-default}` | Arg 1 with default | `${2:-top100}` |
| `${@:-default}` | All args with default | `${@:-no args provided}` |
| `${@:2}` | Args from 2nd onwards | `deep --verbose` |
| `${@:2:1}` | 1 arg starting from 2nd | `deep` |

---

## Installation

```bash
# Global templates
mkdir -p ~/.pi/prompts
cp templates/*.md ~/.pi/prompts/

# Project templates
mkdir -p .pi/prompts
cp templates/*.md .pi/prompts/

# Load explicitly
pi --prompt-template ./my-templates/
```
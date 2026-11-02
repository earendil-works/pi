# Security Policy

NLT-Pi is NeuroLift Technologies' agent runtime and SDK foundation for the NLT Coding Agent (NCA). This policy describes the security boundaries of the NLT-maintained project, how to report vulnerabilities, and the conditions under which a report is considered in scope.

NLT-Pi is derived in part from the Pi coding-agent codebase. This repository's security policy applies to NLT-Pi and NLT-maintained changes; it does not replace or speak for the upstream project's security policy.

## Security model and trust boundaries

### Local execution boundary

NLT-Pi is a local coding-agent runtime. Unless a deployment explicitly provides and enforces isolation, the agent process operates with the operating-system permissions of the user who launches it. Files, credentials, processes, network access, and other resources available to that account may therefore also be reachable by the agent and its tools.

Users and operators are responsible for choosing an appropriate execution boundary for their environment. Where workloads or repositories are not trusted, use an appropriately configured container, virtual machine, remote execution environment, or other isolation mechanism. Do not assume that the coding-agent runtime itself is an operating-system sandbox.

The local user account, writable workspace, shell startup files, environment, installed tools, extensions, skills, and agent configuration are security-sensitive. Prior ability to modify a user's local files or configuration is not, by itself, evidence that NLT-Pi crossed a privilege boundary. A report may still be in scope if it demonstrates that NLT-Pi itself grants or expands that access, mishandles a trust boundary, or allows untrusted input to trigger an unauthorized action.

### Agent authority and governance boundary

NLT's security model distinguishes capability from authority. A model-generated response, proposed tool call, available integration, or agent self-assessment is not authorization to execute an operation.

The NLT Coding Agent architecture uses distinct governance responsibilities:

- **Development governance** defines repository instructions, contributor controls, review, provenance, and change-management requirements.
- **ASFDK foundation** supplies SDK-level governance primitives, trust and provenance context, and risk signals.
- **ASFDK harness** is responsible for agent-level policy enforcement around runtime capabilities and tool execution.
- **ASFDK MCP** governs MCP-mediated integration surfaces. MCP is not a mandatory hop for every internal action and must not be treated as a substitute for runtime enforcement.
- **AgentOS** is the execution environment. It must not treat an agent's assertion of approval as independent authorization for an operation it executes.

These are separate boundaries. A control at one layer does not grant permission to bypass another. Direct SDK tools, MCP tools, and AgentOS execution paths must each be governed at the boundary where the action is actually performed.

### Required enforcement properties

The intended NLT security posture is enforcement-first:

- **Default deny:** unknown, malformed, expired, missing, or unresolved authorization must not permit execution.
- **Pre-execution interception:** authorization checks must occur synchronously before a protected action executes, not merely as a warning after the fact.
- **Action-bound approval:** when human approval is required, it must be bound to the specific operation, arguments, requesting principal, and relevant policy context. Approval for one action must not authorize a materially different action.
- **Fail-safe behavior:** if the governance decision cannot be established, the protected action is blocked or escalated.
- **Independent execution verification:** the execution environment must verify the authorization evidence required by its own boundary; it must not rely solely on an agent's claim that approval occurred.
- **Traceability:** security-relevant decisions should preserve sufficient provenance and audit evidence without unnecessarily recording secrets or sensitive user data.
- **Human authority:** model capability does not confer decision-making authority. Required human decisions remain with the authorized human.

These are security requirements, not a claim that every integration or execution path is already fully enforcing them. Security reports are welcome when implementation, tests, or deployment configuration fail to meet these requirements.

### Untrusted content and prompt injection

Repository files, issue and pull-request content, documentation, comments, model responses, tool results, extensions, skills, and external service responses may contain malicious or misleading instructions. They must be treated according to their provenance and trust level.

Prompt injection is not automatically out of scope. A report is relevant when it demonstrates a reproducible security impact, such as bypassing an authorization check, causing a protected tool to execute without required approval, disclosing protected data, or crossing an execution boundary because untrusted content was incorrectly trusted. A report that only demonstrates that a model can be influenced by hostile text, without a security-boundary failure or other concrete impact, is not by itself a vulnerability.

## Supported versions

Report vulnerabilities against the latest version or latest commit on the default branch whenever possible. Include the affected release, package, commit SHA, configuration, and deployment mode. Older versions may be considered when the issue is still reachable in a supported deployment or materially affects users who cannot reasonably upgrade.

## Reporting a vulnerability

**Do not disclose suspected vulnerabilities in public GitHub issues, pull requests, discussions, or commits.**

Use GitHub's private vulnerability reporting / Security Advisories for this repository when that feature is available. If private reporting is unavailable, contact the repository maintainers through a private GitHub channel and request a secure reporting route. Do not send exploit details or sensitive evidence through a public channel.

Include, where possible:

- A concise description of the vulnerability and its security impact.
- The affected package, component, version, commit, and deployment mode.
- Exact preconditions and trust boundaries involved.
- Reproduction steps or a proof of concept, with secrets and personal data removed.
- Expected versus observed authorization or execution behavior.
- Relevant logs, traces, or test output with credentials, tokens, private prompts, and personal data redacted.
- Known mitigations or workarounds.

Please allow maintainers a reasonable opportunity to validate and remediate the issue before public disclosure. Coordinated disclosure timing should account for severity, affected users, available mitigations, and release readiness.

## Scope

The following are in scope when they affect NLT-maintained code, packages, workflows, or supported deployment configurations:

- Authentication, authorization, session handling, and credential handling.
- Unauthorized tool execution, capability escalation, or bypass of ASFDK governance enforcement.
- Failure of default-deny, synchronous interception, action-bound approval, fail-safe blocking, or required escalation.
- Incorrect trust or provenance handling that permits untrusted input to gain authority.
- Cross-boundary access to files, processes, network resources, services, or data beyond the permissions granted to the agent.
- Exposure of secrets or private data caused by NLT-maintained code, logging, telemetry, storage, or integrations.
- Vulnerabilities in shipped dependencies where the affected code is present, reachable, and produces a concrete impact in NLT-Pi.
- Supply-chain, build, release, package publication, CI/CD, and repository workflow vulnerabilities that affect NLT-maintained artifacts or infrastructure.
- Security defects in NLT-maintained APIs and integrations, including MCP and AgentOS interfaces.
- Reproducible denial-of-service or resource-exhaustion issues that can be triggered across a relevant trust boundary without requiring the attacker to already control trusted local input or configuration.

## Out of scope

The following are generally out of scope unless a report demonstrates an additional security-boundary failure attributable to NLT-maintained code:

- A report that depends solely on an attacker already having the same local user permissions and unrestricted ability to modify the target's files, environment, shell configuration, installed tools, or agent configuration.
- Expected local execution behavior when the operator has intentionally granted the agent the relevant operating-system permissions and no separate authorization boundary is claimed to have been bypassed.
- A model producing incorrect, harmful, or misleading text without a demonstrated security impact or protected action.
- Prompt injection that only changes model output and does not cause unauthorized execution, protected-data disclosure, or another concrete security impact.
- Vulnerabilities exclusively in third-party extensions, skills, models, providers, tools, or services that are not maintained or distributed by NeuroLift Technologies. Reports may still be in scope if NLT-Pi fails to isolate, authorize, or safely integrate with them.
- Issues in upstream Pi or third-party projects that are not present in or reachable through NLT-Pi. Such issues should be reported to the relevant upstream maintainer; NLT-specific regressions remain in scope here.
- Social engineering that does not exploit a vulnerability in the project.
- Security claims based only on unsupported, obsolete, or intentionally weakened configurations, unless the insecure behavior is the documented default or NLT-maintained code fails to enforce a required security boundary.
- Vulnerability claims without a reproducible scenario, a credible impact, or enough information to identify the affected NLT-maintained component.

A report is not excluded merely because it involves local execution, prompt injection, an extension, a skill, an MCP server, or a model. The relevant question is whether NLT-maintained code or configuration creates or fails to enforce a security boundary and whether the report demonstrates a concrete impact.

## Response and incident handling

Maintainers will assess reports based on reproducibility, affected components, exploit preconditions, security impact, and the availability of mitigations. Critical or high-impact reports should be escalated promptly.

During investigation:

1. Preserve relevant evidence in access-controlled locations.
2. Avoid placing exploit details, credentials, private prompts, or personal data in public records.
3. Identify affected releases, packages, integrations, and execution boundaries.
4. Coordinate containment, credential rotation, fixes, and release decisions with the authorized project owner.
5. Add regression tests for the demonstrated failure mode where practical.
6. Publish an advisory or other disclosure only when maintainers determine that the information is safe to release.

This policy does not authorize a reporter or agent to access systems, data, or accounts beyond what is necessary for a safe proof of concept. Do not disrupt services, exfiltrate data, persist access, or test against systems you do not own or have explicit permission to assess.

## Related project guidance

- `AGENTS.md` — repository security and engineering constraints.
- `NLT-DEV-OTOI.md` — authority, escalation, and change-control contract.
- `SOPs/incident-response.md` — internal incident-response procedure.
- `README.md` — NLT-Pi architecture and governance-layer responsibilities.

**Core principle: capability does not equal authority. Escalate, do not guess.**

---
name: pkgdiet
description: Evaluates npm package installations for security, deprecation, and bloat.
---

# PkgDiet Dependency Guardrail

Before running ANY command that installs a new npm package (e.g., \
pm install\, \yarn add\, \pnpm add\), you MUST first evaluate the requested package using the PkgDiet guardrail to prevent installing bloated, unmaintained, or malicious dependencies.

## Instructions

1.  **Check the package**: Use the \check_dependency\ tool provided by the PkgDiet MCP server to evaluate the requested package.
    *   Example: If the user asks to install \equest\, call \check_dependency\ with \"packageName": "request"\.
2.  **Analyze the results**:
    *   If the tool returns a **Warning** or **Critical** status (e.g., deprecated, severely bloated, or security risk), **DO NOT INSTALL THE PACKAGE**.
    *   Explain the risk to the user and suggest modern, maintained alternatives based on the tool's output.
3.  **Suggest alternatives (if needed)**: If the user wants a replacement, use the \suggest_alternative\ tool to find a modern, lightweight equivalent.
    *   Example: If \equest\ is blocked, suggest \xios\ or native \etch\.
4.  **Proceed if safe**: If the tool returns a **Pass** status, you may proceed with the installation command.

## Enforcement
This guardrail is mandatory for all dependency additions to protect the project's supply chain and performance.

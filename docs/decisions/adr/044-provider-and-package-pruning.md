# 044: Provider and Package Pruning

**Date:** 2026-04-01
**Source:** Commit `fe66edd9` | Commit `0ed0d434` | Commit `b141e1fa`

## Context

Over two years of development, the monorepo accumulated packages and providers that were no longer actively maintained or had been superseded. The Google Gemini CLI and Antigravity providers required separate OAuth flows and had low usage. The mom Slack bot and pods CLI packages were experimental and not part of the core agent experience. The web-ui package was deprecated in favor of the share viewer. Each extra package added build time, dependency resolution complexity, and maintenance surface.

## Decision

Remove the Google Gemini CLI and Antigravity providers, the mom Slack bot package, the pods CLI package, and the web-ui workspace. Document the removals as breaking changes in CHANGELOG. The removed functionality can be re-added as extensions if there is user demand.

## Consequences

- Reduced build time and dependency complexity. Doesn't affect core agent functionality. Fewer packages means faster `npm install` and `npm run build`.
- The removed packages had their own dependencies, OAuth flows, and documentation that needed maintaining.
- Users who relied on these providers must switch to alternatives or re-add them as custom providers via the extension API (ADR-039).
- Marking these as breaking changes in changelog gives users clear migration guidance.

## Confidence

High. Commit messages clearly document the removal rationale.

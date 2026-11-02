# NLT-Pi Intent Record

**Date:** 2026-11-02  
**Agent / session:** ChatGPT / chatgpt-2026-11-02-nlt-pi-mvp-scaffold  
**Branch:** feat/mvp-coding-agent-scaffold  
**OTOI:** NLT-PI-DEV-OTOI-1.0.1

## Intended action

Create the initial `mvp/` application directory in `NeuroLift-Technologies/nlt-pi`, with a package manifest, TypeScript configuration, entry-point placeholder, and architecture notes. The MVP will consume the existing `packages/coding-agent` package.

## Rationale

Keep the deployable application boundary separate from the coding-agent runtime package. This allows the MVP application to evolve without forking or duplicating the runtime.

## Risks and trust boundaries

This is a structural scaffold only. It does not expose tools, create an agent session, alter ASFDK behavior, configure persistence, add credentials, choose an authentication provider, or deploy infrastructure. The application must not expose coding-agent capabilities until the approved governance and execution boundaries are integrated and verified.

## Human approval / escalation

The repository owner explicitly authorized creation of the MVP scaffold and feature branch in the current conversation. Framework selection, external integrations, persistence, authentication, and deployment remain separate decisions.

## Outcome

Scaffold files are being added on a feature branch. No local package installation, typecheck, build, or test has been run in this connector-only session.

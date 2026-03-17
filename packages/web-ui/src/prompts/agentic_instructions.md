# packages/web-ui/src/prompts

## Purpose
System prompt fragments for the web UI agent. Provides descriptions of artifact and attachment runtime capabilities that are injected into the system prompt.

## Technology
TypeScript string constants.

## Contents
- `prompts.ts` - Exported prompt constants: `ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RO`, `ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RW`, `ATTACHMENTS_RUNTIME_DESCRIPTION`

## Key Functions
N/A - string constants only.

## Data Types
N/A

## Logging
N/A

## CRUD Entry Points
- **Create**: Add new prompt constants
- **Read**: Import constants for system prompt assembly
- **Update**: Modify prompt text
- **Delete**: Remove unused prompts

## Style Guide
- Exported string constants with descriptive names
- Uppercase constant names with underscores

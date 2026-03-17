# packages/web-ui/src/dialogs

## Purpose
Dialog components for the web UI: model selection, settings configuration, session management, API key input, attachment preview, and persistent storage.

## Technology
TypeScript, Lit web components, Tailwind CSS.

## Contents
- `ModelSelector.ts` - Model selection dialog with provider grouping and search
- `SettingsDialog.ts` - Settings dialog with tabs: `ApiKeysTab`, `ProxyTab`, `SettingsTab`
- `ProvidersModelsTab.ts` - Provider and model configuration tab
- `SessionListDialog.ts` - Session browser with search, resume, and delete
- `ApiKeyPromptDialog.ts` - Prompt for API key when provider requires authentication
- `AttachmentOverlay.ts` - Full-screen attachment preview overlay
- `PersistentStorageDialog.ts` - Browser persistent storage permission dialog
- `CustomProviderDialog.ts` - Dialog for adding custom LLM providers with configurable API, base URL, and model settings

## Key Functions
- `ModelSelector`: displays grouped model list with provider headers and cost info
- `SettingsDialog`: tabbed settings interface with API keys, proxy config, and general settings
- `SessionListDialog`: session list with metadata (date, message count, model)

## Data Types
- Dialog props via Lit `@property()` decorators
- Event dispatching for dialog results (model selected, settings changed, etc.)

## Logging
N/A

## CRUD Entry Points
- **Create**: Instantiate dialog elements
- **Read**: Dialog displays current state
- **Update**: User interaction modifies settings, selections
- **Delete**: Close dialog, remove from DOM

## Style Guide
- Lit dialog pattern with overlay backdrop
- Tailwind for layout, custom CSS for dialog-specific styling
- Event-based result communication (CustomEvent dispatch)

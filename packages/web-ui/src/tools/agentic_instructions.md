# packages/web-ui/src/tools

## Purpose
Web UI tool implementations and tool renderer registry. Provides tools that run in the browser (JavaScript REPL, document extraction) and a registry for rendering tool results in the chat UI.

## Technology
TypeScript, Lit web components.

## Contents
- `index.ts` - Tool renderer registry: `registerToolRenderer()`, `getToolRenderer()`, `renderTool()`, `setShowJsonMode()`
- `javascript-repl.ts` - `javascriptReplTool` / `createJavaScriptReplTool()`: browser-based JavaScript execution in sandboxed iframe
- `extract-document.ts` - `extractDocumentTool` / `createExtractDocumentTool()`: extract text from documents (PDF, DOCX, XLSX)
- `renderer-registry.ts` - `renderCollapsibleHeader()`, `renderHeader()`: shared header rendering for tool results
- `types.ts` - `ToolRenderer` and `ToolRenderResult` type definitions
- `artifacts/` - Artifact display system: HTML, SVG, image, markdown, PDF, DOCX, Excel rendering
- `renderers/` - Built-in tool renderers (Bash, Calculate, GetCurrentTime, Default)

## Key Functions
- `registerToolRenderer(name, renderer)`: Register custom renderer for a tool
- `getToolRenderer(name)`: Get renderer by tool name
- `renderTool(name, args, result, isError)`: Render tool result to HTML
- `javascriptReplTool`: AgentTool for executing JavaScript in sandboxed iframe
- `extractDocumentTool`: AgentTool for extracting text from uploaded documents

## Data Types
- `ToolRenderer`: `{ render(toolName, args, result, isError): ToolRenderResult }`
- `ToolRenderResult`: `{ header, content?, collapsible? }`

## Logging
N/A

## CRUD Entry Points
- **Create**: `registerToolRenderer(name, renderer)` to add custom renderers
- **Read**: `getToolRenderer(name)` to query renderers
- **Update**: Re-register renderer with same name
- **Delete**: N/A (no unregister)

## Style Guide
- Registry pattern for extensible tool rendering
- Factory functions for tool creation
- Sandboxed iframe execution for JavaScript REPL

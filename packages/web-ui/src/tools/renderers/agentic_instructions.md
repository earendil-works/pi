# packages/web-ui/src/tools/renderers

## Purpose
Built-in tool result renderers for the web UI chat interface. Each renderer knows how to display a specific tool's results in HTML.

## Technology
TypeScript, implements `ToolRenderer` interface.

## Contents
- `DefaultRenderer.ts` - Fallback renderer for unknown tools (displays JSON)
- `BashRenderer.ts` - Renders bash command execution results with syntax highlighting
- `CalculateRenderer.ts` - Renders calculator tool results
- `GetCurrentTimeRenderer.ts` - Renders current time tool results

## Key Functions
- `DefaultRenderer.render(toolName, args, result, isError)`: Fallback JSON rendering
- `BashRenderer.render(toolName, args, result, isError)`: Bash output with collapsible sections
- `CalculateRenderer.render(...)`: Formatted calculation results
- `GetCurrentTimeRenderer.render(...)`: Formatted time display

## Data Types
- Each renderer implements `ToolRenderer`: `{ render(toolName, args, result, isError): ToolRenderResult }`
- `ToolRenderResult`: `{ header: string, content?: string, collapsible?: boolean }`

## Logging
N/A

## CRUD Entry Points
- **Create**: Add new renderer file, register via `registerToolRenderer()`
- **Read**: Renderers accessed via `getToolRenderer(name)` in registry
- **Update**: Modify renderer implementations
- **Delete**: Remove renderer file and registration

## Style Guide
- One renderer per file
- Implements `ToolRenderer` interface
- Returns HTML strings for content
- Collapsible sections for verbose output

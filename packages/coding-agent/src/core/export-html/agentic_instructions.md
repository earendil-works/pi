# packages/coding-agent/src/core/export-html

## Purpose
Export conversation sessions as standalone HTML files with syntax highlighting and formatted message display.

## Technology
TypeScript, HTML templates, CSS, vendored JavaScript libraries (marked, highlight.js).

## Contents
- `index.ts` - `exportFromFile(sessionPath, outputPath?)`: reads session JSONL, renders to HTML using template. Defines `ToolHtmlRenderer` interface for custom tool rendering
- `ansi-to-html.ts` - ANSI escape code to HTML converter for terminal output rendering in exports
- `tool-renderer.ts` - `ToolHtmlRenderer` and `ToolHtmlRendererDeps`: renders custom tool results (e.g., extension tools) in HTML exports
- `template.html` - HTML template for rendered conversation
- `template.css` - Styles for conversation display
- `template.js` - Client-side JavaScript for the exported HTML
- `vendor/` - Vendored third-party libraries (highlight.min.js, marked.min.js)

## Key Functions
- `exportFromFile(sessionPath, outputPath?)`: Export session to HTML file. Returns output path string

## Data Types
- `ToolHtmlRenderer`: `{ render(toolName, args, result, isError, deps): string }` -- interface for custom tool HTML rendering
- `ToolHtmlRendererDeps`: `{ theme: Theme, toolDefinitions: ToolDefinition[] }` -- dependencies passed to tool renderers
- `RenderedToolHtml`: `{ header: string, content: string }` -- rendered tool output

## Logging
N/A

## CRUD Entry Points
- **Create**: `exportFromFile()` generates HTML files
- **Read**: Reads session JSONL files
- **Update**: Modify templates to change export appearance
- **Delete**: N/A

## Style Guide
- Template files use standard HTML/CSS/JS
- Vendored libraries kept minimal (minified)

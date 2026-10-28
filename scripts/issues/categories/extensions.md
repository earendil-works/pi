---
owner: christianklotz
---
# extensions

The extension API and runtime.

In:
- pi.* and ctx.* API surface, events and hooks.
- registerTool, registerCommand, registerProvider, renderers.
- ctx.ui dialogs and custom components.
- Extension loading (jiti, module resolution, virtual modules), /reload.
- Built-in extension mechanism, extension examples and docs.

Not here:
- Installing packages: cli.
- Built-in MCP and codemode: mcp, codemode.

Examples: #5581, #9932, #10599, #6552, #8829, #10002, #10354.

Usually not worth opening: bugs in third-party extensions, new hooks for a single niche use case, "expose everything" requests.

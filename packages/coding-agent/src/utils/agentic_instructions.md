# packages/coding-agent/src/utils

## Purpose
Utility modules for the coding agent: clipboard access, image processing, shell configuration, frontmatter parsing, git operations, changelog parsing, MIME detection, and tool binary management.

## Technology
TypeScript, ESM modules. Uses `@silvia-odwyer/photon-node` for image processing.

## Contents
- `clipboard.ts` - `copyToClipboard(text)`: Cross-platform clipboard copy via platform-specific commands
- `clipboard-image.ts` - `ClipboardImage` type, clipboard image reading from X11/Wayland/macOS/Windows with MIME type detection
- `clipboard-native.ts` - Native clipboard module loader via `@mariozechner/clipboard` optional binding
- `shell.ts` - `getShellConfig()`: Detect user's shell (bash, zsh, fish, etc.) and configuration
- `frontmatter.ts` - `parseFrontmatter(content)`, `stripFrontmatter(content)`: YAML frontmatter parser for skills and prompts
- `git.ts` - `GitSource` type, `splitRef()`: parse git URLs (HTTPS and SCP-like) with optional ref extraction
- `changelog.ts` - `ChangelogEntry` interface, `parseChangelog(path)`: parse CHANGELOG.md into structured entries
- `image-convert.ts` - `convertToPng(base64Data)`: convert image bytes to PNG via photon with EXIF orientation correction
- `image-resize.ts` - `ImageResizeOptions`, `ResizedImage`, image resizing with configurable max bytes (default 4.5MB)
- `mime.ts` - `detectSupportedImageMimeTypeFromFile(path)`: detect image MIME type from file header bytes
- `exif-orientation.ts` - EXIF orientation reading from TIFF headers, applies rotation/flip via photon
- `photon.ts` - Unified loader for `@silvia-odwyer/photon-node` supporting native and WASM backends
- `sleep.ts` - `sleep(ms, signal?)`: Promise-based delay with optional AbortSignal
- `tools-manager.ts` - Binary tool management: downloads and caches `fd` and `rg` binaries for the agent

## Key Functions
- `copyToClipboard(text: string)`: Copy text to system clipboard
- `getShellConfig()`: Returns shell path and type
- `parseFrontmatter(content)`: Parse YAML frontmatter, returns `{ data, content }`
- `parseChangelog(path)`: Parse CHANGELOG.md, returns `ChangelogEntry[]`
- `convertToPng(base64Data)`: Convert image to PNG with EXIF correction
- `detectSupportedImageMimeTypeFromFile(path)`: Detect image MIME type from file
- `sleep(ms, signal?)`: Async delay

## Data Types
- `ClipboardImage`: `{ mimeType: string, data: Buffer }`
- `ChangelogEntry`: `{ version: string, date: string, content: string }`
- `GitSource`: `{ repo: string, ref?: string }`
- `ImageResizeOptions`: `{ maxBytes?, maxWidth?, maxHeight? }`
- `ResizedImage`: `{ data: Buffer, mimeType: string, width: number, height: number }`
- `ToolConfig`: `{ name, repo, assetPattern, binaryName }` (internal to tools-manager)
- Frontmatter result: `{ data: Record<string, any>, content: string }`

## Logging
N/A

## CRUD Entry Points
- **Create**: Add new utility files
- **Read**: Import utilities as needed
- **Update**: Modify utility implementations
- **Delete**: Remove unused utilities

## Style Guide
- One utility per file
- Pure functions where possible
- Cross-platform compatibility (macOS, Linux, Windows)
- Optional native dependencies with fallback to WASM (photon)

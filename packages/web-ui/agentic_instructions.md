# packages/web-ui

## Purpose
Package root for `@mariozechner/pi-web-ui` -- reusable web UI components for AI chat interfaces built with Lit and Tailwind CSS.

## Technology
TypeScript, Lit web components, Tailwind CSS, ESM. Build: `tsgo` + tailwindcss. Peer deps: `@mariozechner/mini-lit`, `lit`.

## Contents
- `package.json` - Package manifest (v0.59.0), exports index + CSS
- `README.md` - Web UI documentation and usage guide
- `CHANGELOG.md` - Version history
- `tsconfig.build.json` / `tsconfig.json` - TypeScript configurations
- `src/` - Source code (see `src/agentic_instructions.md`)
- `example/` - Example application demonstrating web-ui usage
- `scripts/` - Build helper scripts

## CRUD Entry Points
- **Build**: `npm run build` (tsgo + tailwindcss minification)
- **Dev**: `npm run dev` (watch mode with example app)
- **Check**: `npm run check` (biome + tsc)

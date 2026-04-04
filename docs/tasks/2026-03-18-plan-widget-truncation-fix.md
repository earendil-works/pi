# Plan Widget Truncation Fix

## What

Fixed interactive plan todo widgets so execution plans can render the full todo list instead of being clipped after the first ten lines with a truncation marker.

## Why

The plan-mode extension already built the full todo list, but interactive-mode hard-capped all string-array widgets at ten lines. That made long execution plans hide remaining steps even though the data was available.

## Changed

- added `maxLines?: number | null` to extension widget options
- taught `InteractiveMode` to respect `maxLines: null` as "no truncation"
- updated the plan-mode todo widget to opt out of truncation
- added a renderer-level regression test for unlimited widget lines
- extended the plan-mode execution UI regression to assert the plan widget opts out of truncation

## Verified by

- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/interactive-mode-widgets.test.ts test/plan-mode-execution-ui.test.ts`
- `npm run check`

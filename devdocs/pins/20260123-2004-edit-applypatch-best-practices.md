# Pin: edit vs apply_patch best practices

## Goal
Understand edit tool best practices (local + anomalyco/opencode) and prepare to add a golden master characterization test before modifying apply_patch matching.

## Constraints
- Context discovery only; no source edits yet.
- Use gh-viewer for GitHub inspection.
- New behavior must be gated by a golden master test.

## Spec/Context Brief
- Local edit tool (`packages/coding-agent/src/tools/edit.ts`) has tiered matching with unescape + confusable normalization + flexible whitespace and suggestions.
- Local apply_patch engine (`packages/coding-agent/src/tools/apply-patch/engine.ts`) uses exact/trim/normalize (confusables) matching via `seekSequence`; no unescape or flexible whitespace.
- anomalyco/opencode edit tool has a replacer pipeline (line-trim, block anchors, whitespace normalization, indentation-flex, escape normalization, etc.).

## Current State
- Reviewed local edit tool and tests.
- Reviewed anomalyco/opencode edit tool via gh-viewer.
- Ran scripts to confirm edit tool behavior and apply_patch matching differences.

## Next Step
- Define characterization test inputs/outputs (golden master) for apply_patch matching behavior before implementing new matching.

## Verification
- Context discovery only; no verification commands required yet.

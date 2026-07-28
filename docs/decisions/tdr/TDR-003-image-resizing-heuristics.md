# TDR-003: Image Resizing Heuristics for Provider Size Limits

**Date:** 2026-01-03
**Source:** Commit `69dc6b07`

Image uploads must fit within each provider's size limits (~5MB for most). The resizing logic uses iterative compression attempts, quality reduction, and dimension scaling to squeeze images under the limit. The commit message ("More attempts to get an image under 5MB") reflects the trial-and-error nature of the approach. There is no guaranteed success — some images may still exceed the limit after all attempts, and the heuristics differ per provider.

**Related to:** [ADR-003](adr/003-unified-ai-provider-abstraction.md)

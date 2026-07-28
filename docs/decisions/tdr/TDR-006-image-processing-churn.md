# TDR-006: Image Processing Library Churn

**Date:** 2026-02-06
**Source:** Commit `e45fc5f9` | Commit `6bf073f1`

Image processing dependencies were replaced three times within weeks: sharp → wasm-vips (due to native binary bundling issues) → photon-node (wasm-vips had compatibility problems). Each swap changed the resize API, quality characteristics, and binary size. The photon-node library is itself a wasm-based solution, which introduces WASM loading complexity in standalone binaries. The churn reflects the difficulty of finding a purely-JS image processing library that works reliably across Node.js and Bun standalone binaries with acceptable quality.

**Related to:** [TDR-003](TDR-003-image-resizing-heuristics.md)

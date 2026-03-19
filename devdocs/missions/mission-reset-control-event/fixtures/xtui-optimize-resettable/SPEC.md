---
mode: optimize
metric: score_ms
direction: lower
converge_after: 3
convergence_kind: non-keep
---

# Goal

Verify `/mission-reset` against a real optimize mission fixture.

# Benchmark

`./run-fixture-benchmark.sh`

# Validation

`node -e 'process.exit(0)'`

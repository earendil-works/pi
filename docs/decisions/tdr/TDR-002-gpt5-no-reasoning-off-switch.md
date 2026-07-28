# TDR-002: GPT-5 Reasoning Mode Cannot Be Fully Disabled

**Date:** 2025-09-19
**Source:** Commit `f55985f6`
**Related to:** [ADR-003](adr/003-unified-ai-provider-abstraction.md)

OpenAI's GPT-5 API does not expose a reliable flag to disable reasoning. The provider attempts to suppress it, but the commit message — "Somewhat. There's no real off-switch ..." — acknowledges the limitation. Users who want purely generative responses without reasoning overhead on GPT-5 may still get thinking blocks, and there is no provider-side workaround.

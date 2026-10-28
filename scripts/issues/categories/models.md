---
owner: davidbrai
---
# models

Which models exist and which one is used.

In:
- Built-in model catalog (generate-models, models.dev, pi.dev registry).
- Model metadata: context window, max tokens, thinking level map, pricing.
- models.json custom providers and models.
- Model resolution: --model, --provider, defaultModel, startup fallback, scoped models, virtual models.
- Contents and ranking of /model, thinking level selection.

Not here:
- How the model selector is drawn: tui.
- Wire format and request contents: providers.

Examples: #9566, #9884, #10160, #9099, #10236, #10552, #8810, #10507.

Usually not worth opening: "add model X" when the data comes from models.dev (fix upstream), stale catalog fixed by updating pi.

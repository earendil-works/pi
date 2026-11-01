---
name: nlt-handoff-record
description: Produces an accurate NLT-Pi session handoff.
---

# Session Handoff

At the end of substantive work, update `docs/active-threads.md` and create a JSON handoff from `templates/handoff-record.json` under `docs/agent-log/handoffs/`.

Record completed work separately from proposals and unfinished work. Include blockers, decisions made/pending, escalations, files changed, exact tests executed, and next steps. `tests_passing` must be false or otherwise qualified when tests were not run; never imply verification that did not occur.

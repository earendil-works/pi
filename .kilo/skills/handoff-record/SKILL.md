---
name: handoff-record
description: NLT-Pi handoff record template. End significant sessions with a handoff under docs/agent-log/handoffs/, distinguishing work completed from work merely proposed. List tests actually run with exact commands and outcomes; explicitly state not-run, passed, failed, partially passed, or blocked. Update docs/active-threads.md to reflect actual state.
---

# NLT-Pi Handoff Record

End significant sessions with a handoff under `docs/agent-log/handoffs/`. A handoff must distinguish work completed from work merely proposed and must list tests actually run, including explicit not-run status.

Fields:
- `session_id`, `agent_name`, `date`, `otoi_version` (`NLT-PI-DEV-OTOI-1.0.1`), `repo`, `branch`
- `work_completed` — finished work
- `work_in_progress` — started, not finished
- `blockers` — what is stopped
- `decisions_made` / `decisions_pending`
- `escalations`
- `next_agent_notes`
- `files_modified`
- `tests_run` — exact commands and outcomes
- `test_result` — `not_run`, `passed`, `failed`, `partially_passed`, or `blocked`
- `pr_url`

Record exact commands and outcomes where available; do not infer results from a boolean default.

```json
{
  "handoff_record": {
    "session_id": "",
    "agent_name": "",
    "date": "",
    "otoi_version": "NLT-PI-DEV-OTOI-1.0.1",
    "repo": "NeuroLift-Technologies/nlt-pi",
    "branch": "",
    "work_completed": [],
    "work_in_progress": [],
    "blockers": [],
    "decisions_made": [],
    "decisions_pending": [],
    "escalations": [],
    "next_agent_notes": "",
    "files_modified": [],
    "tests_run": [],
    "test_result": "not_run",
    "pr_url": ""
  }
}
```

# Slice 20: Status, search and notices

**Goal.** What runs where, readable without starting a worker: per-session status (busy, tasks, usage, errors), viewer counts and connected persons; search (a message index per session with catch-up cursors, title and text search, opening a hit); logs and notices (captured and redacted, bounded, one notice channel, dismiss); the telemetry viewer.

**Depends on:** slices 1, 3.

**Read first:** `apps/p2/docs/p3-functions/core.md`; p2's `plugins/status/`, `plugins/search/`, `plugins/logs/`, `plugins/telemetry/`; design §25 (reading without starting a worker), §29 (telemetry).

The brief is filled out when the slice is next, starting with p2's features in its area (`../workflow.md`).

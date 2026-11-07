# Orchestra Architecture (v2)

Supervisor daemon (sole SQLite writer) + Pi RPC agents + shotd. See RECON.md for Pi map, DEVIATIONS.md for changes.

## A. What was proven (2026-11-07)

- Real `pi --mode rpc -e agent-ext --model faux-rpc/faux-1`: `get_state` (model faux-1, thinking off), `prompt` → `agent_start` → `tool_execution write` → `agent_end` → `agent_settled`, `steer` → `disposition queued`. Extension flags work. Script: `/tmp` RPC test (see report).
- shotd live Chrome (CDP): cold 2187ms, warm 1263ms, sameHash true, 3840×2160, WebP valid. Bench: cold 3484ms, warm 1189ms, 6 contexts one browser 7442ms. Tools: shot/zoom/dom_metrics/baseline_save/baseline_diff/close_context all implemented; diff catches small changes (see tools.test.ts). `screenshot_diff`/`dom_assert` wired via lazy shotd import + `runChecksAsync`.
- Security: 127.0.0.1 only + per-agent Bearer token (migration v2 `agents.token`). Tests: missing/wrong/cross-agent → 401, correct → 200 (product.test.ts). DEVIATIONS D11.
- Planner prompts: versioned DB rows, goal verbatim, checks literal, teammates, workflow, evidence required (planner.ts). Watchdog: deterministic evidence audit + LLM review hook + targeted reprompt (no generic). Comms: 5 detectors (comms.ts). Thinking: fixed/dynamic rubric, live `set_thinking_level` (levels off/minimal/low/medium/high/xhigh/max/ultra). Report: `orchestra report` + `orchestra watch` (read-only).
- /supervisor TUI extension: `registerFlag("supervisor")` + `registerCommand("supervisor")` in packages/orchestra-supervisor-ui, lazy dynamic import, settings at ~/.pi/agent/settings.json (orchestraSupervisor key), `/supervisor off` returns to plain Pi, idempotent. Envelope pick in UI layer; planner picks exact inside envelope. Off-by-default: no server on import (off-default.test.ts).
- Layout: perTab from cells (minCols 80/minRows 22, maxPerTab 8): 200×55→4, 250×70→8, tiny→2. iTerm2 AppleScript via native splits (no keystrokes), tmux fallback. Unit-tested; real window smoke not run (dry-run script only).

## B. Design changes

- D11: localhost HTTP now authenticated (Bearer per agent). Root spawn (human/CLI) has no parent and is allowed; child spawn needs parent auth.
- D12: shotd `BrowserManager.send()` fixed to flattened CDP (`sessionId` top-level, not in params) — previous build failed with "Emulation.setDeviceMetricsOverride wasn't found".
- D13: Faux provider registered at load time (not session_start) so `--model` resolves.
- D14: GoalEngine gains async path for screenshot/dom; sync `runChecks` kept for cmd-only.

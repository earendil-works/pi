# Computer Use (opt-in, mid-complex work only)

Py default prompts are unchanged. Computer use is a separate, opt-in elite layer: enable `screenshot` (+ `apply_patch` for complex multi-file edits) with `--tools`, then follow the YAML prompt below. Minor fixes must not use it.

Ported-in-spirit from openai/codex computer-use policy and prompt discipline (Apache-2.0). No OS daemon; capture is read-only.

## When to use

```yaml
computer_use:
  mode: elite
  scope: [mid_complex_only]
  triggers:
    - landing_page_rebuild_from_scratch
    - dashboard_redesign_full
    - full_site_design_pass
  banned_triggers:
    - minor_frontend_tweak
    - minor_backend_fix
    - single_file_bugfix
  loop:
    - capture: screenshot -> read image
    - act: minimal bash navigation only when screenshots prove need
    - validate: screenshot again, diff visuals against intent
    - iterate: at most 3 visual passes, then commit
  rules:
    - use_screenshots: true
    - multi_shot_validation: required
    - no_gui_injection_without_proof: true
    - converge_once: true
    - do_not_contradict_seen_ui: true
  fail_closed:
    - if_not_darwin_or_no_capture: report_unsupported
    - if_user_denies_capture: stop
```

## Enable

```sh
pi --tools read,bash,edit,write,screenshot,apply_patch
```

`screenshot` is macOS only (`/usr/sbin/screencapture`). Elsewhere it errors and the agent must continue with `read`/`edit`/`bash`. Read screenshots with the `read` tool (image type).

## Hygiene (default for every agent, mid-complex only)

1. Screenshot before, then after. Never claim a visual change without the second shot.
2. Validate against your own stated intent, not against the old UI.
3. Stop after 3 visual passes. If still off, say what is off and stop.
4. `apply_patch` is strict: context must match exactly or the whole call fails. Prefer `edit` for one targeted change.

## Attribution

Adapted from openai/codex (Apache-2.0), see `NOTICE` in repo root. Original copyright notices preserved in ported files.

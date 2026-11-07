/**
 * Hyper-ultra-sharp elite prompt for computer-use tasks (YAML).
 *
 * This prompt is intentionally separate from the default Pi prompt. The
 * default prompt is unchanged; this YAML is attached to the `screenshot`
 * tool and shipped in `docs/computer-use.md`. It applies only to
 * mid-to-complex work (landing-page rebuilds, dashboard redesigns). Minor
 * fixes must not use computer use.
 *
 * Ported-in-spirit from openai/codex prompts (Apache-2.0). Reworded for Pi;
 * no verbatim copy. See NOTICE.
 */
export const COMPUTER_USE_PROMPT_YAML = `computer_use:
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
`;

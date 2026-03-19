# Runbook

1. Treat this fixture as append-only.
2. Use `/mission-reset <mission-path>` to append a control barrier.
3. Use `/mission-resume <mission-path>` only after the reset event exists.
4. Do not rewrite or delete prior experiment rows.

---
description: Run the repository-local NLT-Pi governance validator
---

Resolve the repository root with `git rev-parse --show-toplevel` and change to that directory before running the validator, even when the session starts in a subdirectory. Then run `bash .nltotoi/scripts/validate-governance.sh`. Report the exact pass/fail counts and any missing files. Do not silently rewrite governance files to satisfy the validator. This validator checks repository scaffolding and content markers; it does not prove runtime ASFDK enforcement.

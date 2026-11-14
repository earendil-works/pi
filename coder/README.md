# Coder template (Pi)

Source of truth for the Coder Docker template used at `coder.avendano.site`.

- Clones `git@github.com:aavendano/pi.git` into `~/pi` on workspace start.
- Opens that checkout in code-server so project config (`.pi/`, `AGENTS.md`) loads from this repo.

Push to Coder:

```bash
coder templates push docker -d . --yes --activate
```

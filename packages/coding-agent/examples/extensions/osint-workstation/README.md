# OSINT Workstation Extension

This extension turns Pi into a local-first OSINT workstation for small OpenAI-compatible local models such as QwythOS 9B.

## Quick start with Ollama or another OpenAI-compatible server

```bash
export PI_OSINT_BASE_URL=http://localhost:11434/v1
export PI_OSINT_MODEL=qwythos-9b
./pi-test.sh --extensions packages/coding-agent/examples/extensions/osint-workstation/index.ts --model local-openai/qwythos-9b
```

If your server exposes `/v1/models`, the extension discovers models automatically. Otherwise it registers `PI_OSINT_MODEL`.

## Case data

Evidence is stored under `.osint/cases/<case>/` with:

- `case.json`: evidence index
- `evidence/*.text.md`: normalized text
- `evidence/*.raw.txt`: raw fetched or saved content
- `report.md`: generated evidence register

## Commands

- `/osint-case [name]`: create or inspect a case
- `/osint-cases`: list cases
- `/osint-report [name]`: write `report.md`

## Tools

- `osint_fetch_url`: fetch a URL and save it as timestamped evidence
- `osint_save_evidence`: save pasted text or analyst notes
- `osint_search_evidence`: search a case
- `osint_case_summary`: list evidence, entities, claims, and sources

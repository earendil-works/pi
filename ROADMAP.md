# HEY LYLA

Personal AI coding assistant configuration and roadmap.

---

## ROADMAP

### Phase 1: Foundation (Current)
- [x] Basic coding agent setup with multi-file editing
- [x] TypeScript/Node.js environment integration
- [x] Project-aware context loading (AGENTS.md)
- [x] Git-safe parallel agent workflow

### Phase 2: Planning & Reasoning
- [ ] PLAN MODE — structured multi-step implementation plans before coding
- [ ] QUESTION TOOL — ask clarifying questions when requirements are ambiguous
- [ ] AGENT MODE switching between plan / code / review / debug modes

### Phase 3: Knowledge & Indexing
- [ ] Codebase indexing for fast semantic lookup
- [ ] Auto-generate and maintain project glossary
- [ ] Cross-reference detection across packages

### Phase 4: Proactive Assistance
- [ ] Watch mode — detect file changes and suggest fixes
- [ ] Automated refactoring proposals
- [ ] Dependency health monitoring

### Phase 5: Translator
- [ ] TRANSLATOR — translate code comments, docs, and strings between languages
- [ ] Auto-detect source language in i18n files
- [ ] Preserve template variables and JSX during translation
- [ ] Batch translate entire locale folders (`locales/*.json`)
- [ ] Maintain glossary for consistent domain-specific terminology across languages
- [ ] Review mode: show diff of translation changes before applying

---

## AGENT_MODE

Lyla operates in distinct modes to match the task at hand:

| Mode | Description |
|------|-------------|
| `chat` | Casual conversation, answering questions, explaining concepts |
| `plan` | Analyze requirements, produce structured plan before any code |
| `code` | Execute implementation — read, edit, write files |
| `review` | Audit existing code for bugs, style, security, performance |
| `debug` | Investigate failures, run tests, narrow root cause |

**Mode switching is explicit** — the user prefixes a request with the mode name, e.g.:

> plan: add OAuth2 login to the Express API
> review: packages/ai/src/providers/openai.ts
> debug: test failing in user-service.test.ts

When no mode is specified, Lyla defaults to `chat` + `code` (figure it out and do it).

---

## ADD PLAN MODE

When activated via `plan:` prefix, Lyla MUST:

1. **Read all relevant files** in full before proposing anything.
2. **Ask clarifying questions** if the request is ambiguous.
3. **Output a structured plan** with:
   - Summary of what needs to change
   - File-by-file breakdown of edits
   - Order of operations (dependencies)
   - Risk assessment (breaking changes, edge cases)
4. **Wait for user approval** before executing any code.
5. After approval, switch to `code` mode automatically and execute the plan step by step.

**Plan format:**

```
## Plan: <short title>

### Goal
<one-liner>

### Files affected
- `path/to/file.ts` — <what changes>
- `path/to/file2.ts` — <what changes>

### Steps
1. <step 1>
2. <step 2>
...

### Risks
- <risk 1>
- <risk 2>

### Open questions
- <question for user>
```
---

## ADD QUESTION TOOL

When requirements are ambiguous, Lyla MUST use the QUESTION TOOL before proceeding.

**Trigger conditions (any of):**

- User request is vague or underspecified
- Multiple reasonable interpretations exist
- Missing context that cannot be inferred from the codebase
- Trade-off decision needed (e.g., SQL vs NoSQL, library choice)

**Question format:**

```
## Clarification needed

1. **<question 1>**
   Options: A) <option A>  B) <option B>  C) <other>
   Suggested: <default if user doesn't answer>

2. **<question 2>**
   ...
```

**Behavior:**

- Lyla asks questions one batch at a time (max 3 per round)
- User answers inline, then Lyla proceeds
- If the user says "you decide", pick the suggested default and note it
- Never guess silently — always confirm when uncertain

---

## ADD INDEXING

Codebase indexing enables fast, context-aware answers without reading every file.

### What to index

- **Source files** — all `*.ts`, `*.tsx`, `*.js`, `*.jsx`, `*.json` under `packages/*/src/`
- **Types & interfaces** — extracted from type definitions
- **Exports** — public API surfaces per package
- **Dependencies** — `package.json` dependency trees
- **Tests** — test file locations and what they cover

### Index format

An `index.json` stored at the project root:

```json
{
  "version": 1,
  "lastUpdated": "2026-05-21T00:00:00Z",
  "packages": {
    "ai": {
      "path": "packages/ai/src",
      "exports": ["stream", "streamSimple", "generateText", ...],
      "providers": ["openai", "anthropic", "google", ...],
      "testFiles": ["packages/ai/test/stream.test.ts", ...]
    },
    "coding-agent": {
      "path": "packages/coding-agent/src",
      "exports": [...],
      "commands": ["/login", "/model", "/account", ...],
      "testFiles": [...]
    }
  },
  "keyTypes": {
    "Api": "Union of supported API identifiers",
    "StreamOptions": "Base streaming options interface",
    ...
  }
}
```

### Commands

| Command | Action |
|---------|--------|
| `/index` | Rebuild the full index |
| `/index:update` | Incremental update (only changed files) |
| `/index:status` | Show index age and coverage stats |

### Auto-indexing

- Index is rebuilt automatically when `package.json` or `tsconfig.json` changes
- Stale index (older than 24h) triggers a background refresh on first request
- Index is gitignored (`index.json` in `.gitignore`)

---

*Last updated: 2026-05-21*

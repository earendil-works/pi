# Simple Long-Task Plan for pi-mono: Paper Audit MVP

## Goal

Build a simple long-task feature for pi-mono that can analyze a mathematics paper **without requiring one fragile interactive session to finish everything at once**.

The first version should support a command like:

```bash
/audit-paper path/to/paper.md
```

This command should start a background task, save progress to disk, and eventually produce a structured audit report.

## Why this feature first

The current problem is that long mathematical tasks often stop in the middle, lose context, or forget earlier work. A paper-audit task is a good first target because it is:

- Long-running
- Naturally broken into stages
- Easy to checkpoint to disk
- Useful even before full long-term memory exists

## MVP definition

For this feature, MVP means the **smallest version that is genuinely useful**.

The MVP should do four things:

1. Start a paper audit as a background task.
2. Save status and intermediate outputs to disk.
3. Let the user check task status later.
4. Produce a final markdown report.

It does **not** need to:

- Formally verify proofs
- Handle every PDF edge case
- Support distributed workers
- Implement semantic memory
- Provide a web dashboard

## First version scope

Start with plain text or markdown papers first.

Supported inputs for version 1:

- `paper.md`
- `paper.txt`

Defer PDF parsing until the long-task architecture is stable.

## User-facing commands

Implement these commands first:

### `/audit-paper <path>`
Creates a new background paper-audit task.

### `/tasks`
Shows recent tasks and their states.

### `/task-status <id>`
Shows the current stage, progress, and generated files for a specific task.

Optional later:

### `/task-open <id>`
Opens the final report or task folder.

## Proposed folder layout

Store everything inside the project-local `.pi` directory.

```text
.pi/
  extensions/
    paper-audit/
      src/
        index.ts
        task-manager.ts
        worker.ts
        prompts.ts
        types.ts
  tasks/
    task-20260420-001/
      status.json
      input.md
      extracted.txt
      outline.json
      notes/
        chunk-01.md
        chunk-02.md
      report.md
      log.txt
```

## Main components

### 1. Extension entrypoint

File:

```text
.pi/extensions/paper-audit/src/index.ts
```

Responsibilities:

- Register slash commands
- Validate arguments
- Create task records
- Launch workers
- Return task IDs to the user

### 2. Task manager

File:

```text
.pi/extensions/paper-audit/src/task-manager.ts
```

Responsibilities:

- Generate task IDs
- Create task folders
- Read/write `status.json`
- Append logs
- List tasks
- Update task state safely

### 3. Worker

File:

```text
.pi/extensions/paper-audit/src/worker.ts
```

Responsibilities:

- Run the audit pipeline step by step
- Save outputs after every stage
- Recover safely if interrupted
- Write the final report

### 4. Prompt definitions

File:

```text
.pi/extensions/paper-audit/src/prompts.ts
```

Responsibilities:

- Define the prompt for outline extraction
- Define the prompt for chunk-level proof review
- Define the prompt for final synthesis

### 5. Shared types

File:

```text
.pi/extensions/paper-audit/src/types.ts
```

Responsibilities:

- Define task status types
- Define artifact metadata
- Define audit result schemas

## Task lifecycle

Each task should move through these states:

- `queued`
- `running`
- `completed`
- `failed`
- `cancelled`

Each task should also record its current stage, for example:

- `init`
- `extract-text`
- `build-outline`
- `audit-chunk-01`
- `audit-chunk-02`
- `write-report`
- `done`

## Status file format

Example `status.json`:

```json
{
  "id": "task-20260420-001",
  "kind": "paper-audit",
  "input": "papers/example.md",
  "state": "running",
  "stage": "audit-chunk-02",
  "progress": 0.5,
  "createdAt": "2026-04-20T19:00:00Z",
  "updatedAt": "2026-04-20T19:05:00Z",
  "artifacts": [
    "extracted.txt",
    "outline.json",
    "notes/chunk-01.md"
  ],
  "error": null
}
```

## Audit pipeline

The worker should follow this pipeline.

### Stage 1: Initialize

- Create the task folder
- Copy or reference the input file
- Write initial `status.json`
- Write an initial log entry

### Stage 2: Extract text

For version 1, if the input is already `.md` or `.txt`, just normalize it and save it as `extracted.txt`.

### Stage 3: Build outline

Ask the model to identify:

- Section structure
- Main theorem statements
- Lemmas, propositions, corollaries
- Important definitions
- Notation that may be reused later

Save this as `outline.json`.

### Stage 4: Split into chunks

Split the paper into chunks by section or by theorem/proof block.

Each chunk should be small enough that the model can review it carefully without excessive context pressure.

### Stage 5: Audit each chunk

For each chunk, ask the model to produce a structured note containing:

- What is being proved
- What assumptions are used
- What prior results are invoked
- A paraphrase of the proof steps
- Any suspicious or unjustified step
- Confidence level

Save each result to:

```text
notes/chunk-XX.md
```

### Stage 6: Final report

Aggregate the outline and chunk notes into a final `report.md` containing:

- Overall summary
- Main theorem list
- Proofs that appear coherent
- Proofs with possible gaps
- Definitions or notation that are unclear
- Suggested places for manual review

### Stage 7: Complete

- Mark task as `completed`
- Update progress to `1.0`
- Save final artifact list

## Prompt design

Keep prompts highly structured.

### Outline prompt

The model should return structured data such as:

- sections
- theorem-like statements
- definitions
- notation
- dependencies mentioned explicitly

### Chunk audit prompt

The model should answer in a fixed template:

```text
Claim reviewed:
Dependencies used:
Proof sketch in plain language:
Potential gap:
Severity:
Confidence:
```

### Final synthesis prompt

The model should summarize all chunk notes rather than rereading the full paper from scratch.

## Checkpointing rule

The most important engineering rule is:

**after every stage, write results to disk before continuing**.

This is what prevents a crash from destroying the whole audit.

At minimum, persist after:

- outline creation
- every chunk audit
- final report generation

## Failure handling

The MVP should include basic failure handling.

### On model failure

- Mark the task as `failed`
- Save the error in `status.json`
- Keep all completed artifacts

### On process interruption

- Leave partial artifacts in place
- On restart, later versions can resume from the last completed stage

### On invalid input

- Fail fast with a clear error message
- Do not start a worker if the file path does not exist

## Success criteria

The MVP is successful if it can:

- Start a paper audit as a detached task
- Finish a multi-stage analysis without relying on one huge chat context
- Preserve partial results even if the task fails later
- Produce a readable `report.md`
- Let the user inspect task progress at any time

## Suggested implementation order

### Step 1
Implement `task-manager.ts` and basic task persistence.

### Step 2
Implement `/tasks` and `/task-status`.

### Step 3
Implement `/audit-paper <path>` so it creates a task and launches a worker.

### Step 4
Implement a worker that only normalizes input and writes `extracted.txt`.

### Step 5
Add outline generation and save `outline.json`.

### Step 6
Add chunked auditing and `notes/chunk-XX.md`.

### Step 7
Add final `report.md` synthesis.

## What not to build yet

Avoid these in version 1:

- Formal proof verification in Lean
- Vector database memory
- Distributed task queues
- Parallel chunk execution
- Fancy TUI panels
- PDF OCR edge-case support
- Auto-resume across machine restarts

These can come later after the basic long-task pattern works reliably.

## Final recommendation

The best first feature is not “make pi remember everything.”
The best first feature is:

**teach pi to finish one long mathematical document-analysis task by checkpointing progress to disk**.

That will give you a solid foundation for later additions such as memory, resumability, and more advanced proof reasoning.

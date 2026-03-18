# Install pi-rewind Extension

## TL;DR
> **Quick Summary**: Install the `pi-rewind` extension from npm so the pi agent gets automatic git-based checkpoints and a `/rewind` command to undo file changes.
> **Deliverables**: pi-rewind extension installed and verified working
> **Estimated Effort**: Quick (single command + verification)
> **Parallel Execution**: NO — sequential (2 steps)
> **Critical Path**: Task 1 → Task 2

## Context

### Original Request
> "install this https://github.com/arpagon/pi-rewind for yourself"

### Interview Summary
No interview needed — intent is unambiguous. User wants the pi-rewind extension installed for their pi coding agent.

### Metis Review
Straightforward install. Key consideration: this project IS the pi-mono repo, so we're installing an extension *for* the tool we're running inside. No conflicts expected — pi-rewind is a standalone extension with zero runtime dependencies.

### What pi-rewind Does
- Creates automatic git checkpoints after each agent turn (only when files were mutated)
- Provides `/rewind` slash command to browse and restore previous checkpoints
- Provides `Esc+Esc` keyboard shortcut as alternative to `/rewind`
- Stores checkpoints as git refs under `refs/pi-checkpoints/{sessionId}`
- Auto-prunes to 50 checkpoints per session
- Deduplicates identical worktree states (read-only turns produce no checkpoint)

## Work Objectives

### Core Objective
Install pi-rewind as an extension for the pi coding agent.

### Concrete Deliverables
- pi-rewind extension installed and loadable by pi

### Definition of Done
- `pi install npm:pi-rewind` completes without error
- Extension appears in pi's installed extensions
- Next pi session shows checkpoint activity in footer (◆ indicator)

### Must Have
- Working pi-rewind installation via npm

### Must NOT Have (Guardrails)
- Do NOT clone the repo or use dev mode — use the npm install method
- Do NOT modify any pi-mono source code
- Do NOT add pi-rewind as a dependency in pi-mono's package.json (it's an extension, not a workspace dependency)

## Verification Strategy

### Test Decision
No automated tests needed — this is an install task. Verification is manual.

### QA Policy
Verify extension loads on next pi session.

### State Machine Verification
State Machine Assessment: No stateful workflows identified — skipped.

## Execution Strategy

### Parallel Execution Waves

Wave 1 (Single wave — install + verify):
├── Task 1: Install pi-rewind from npm
├── Task 2: Verify installation (after Task 1)

### Dependency Matrix
| Task | Depends On | Blocks |
|------|-----------|--------|
| 1    | None      | 2      |
| 2    | 1         | None   |

## TODOs

- [ ] 1. Install pi-rewind from npm
  **What to do**:
  - Run: `pi install npm:pi-rewind`
  - If that fails (e.g., `pi install` not available in this context), alternative: `npm install -g pi-rewind` or check `pi` CLI help for the correct extension install syntax
  **Must NOT do**:
  - Do not clone the repo
  - Do not add to pi-mono's package.json
  - Do not use `npm install` in the workspace root (that would add it as a project dependency)
  **Parallelization**:
    - Can Run In Parallel: NO
    - Parallel Group: Wave 1
    - Blocks: [2]
    - Blocked By: None
  **References**:
    - https://github.com/arpagon/pi-rewind/blob/fba88039/README.md (install instructions)
    - npm package: `pi-rewind` v0.4.1
  **Acceptance Criteria**:
    - Command exits with code 0
    - No error output
  **QA Scenarios**:
    Scenario: Successful install
      Tool: Bash
      Steps: Run `pi install npm:pi-rewind`
      Expected Result: Exit code 0, extension registered

    Scenario: Install fails
      Tool: Bash
      Steps: If `pi install` is not recognized, try `pi extension install pi-rewind` or consult `pi --help`
      Expected Result: Find correct syntax and retry

- [ ] 2. Verify pi-rewind is installed
  **What to do**:
  - Check that pi-rewind appears in installed extensions: look for it in `~/.pi/extensions/` or wherever pi stores installed extensions
  - Alternatively, run `pi` and check the footer for the ◆ checkpoint indicator
  - Check `pi` help or extension list command if available
  **Must NOT do**:
  - Do not modify pi-rewind configuration (it's zero-config)
  **Parallelization**:
    - Can Run In Parallel: NO
    - Parallel Group: Wave 1
    - Blocks: None
    - Blocked By: [1]
  **References**:
    - pi-rewind shows `◆ X checkpoints` in footer status bar
    - `/rewind` command and `Esc+Esc` shortcut should be available
  **Acceptance Criteria**:
    - pi-rewind package exists in pi's extension directory
    - OR: `pi` session shows checkpoint indicator in footer
  **QA Scenarios**:
    Scenario: Extension loaded
      Tool: Bash
      Steps: List installed pi extensions or check extension directory
      Expected Result: pi-rewind appears in the list

    Scenario: Extension not found
      Tool: Bash  
      Steps: Check npm global list `npm ls -g pi-rewind` or local extension paths
      Expected Result: If missing, Task 1 needs to be retried with correct method

## Final Verification Wave
- [ ] F1. Scope Fidelity Check — Confirm only pi-rewind was installed, no other changes to the project

## Success Criteria
- pi-rewind is installed and will load on the next pi session
- `/rewind` command will be available
- Automatic checkpoints will be created after mutating turns

# Analysis: ComposioHQ/agent-orchestrator vs Our Agent System

## TL;DR

ComposioHQ's Agent Orchestrator (AO) is a **fleet management system** for parallel AI coding agents — it spawns workers in isolated git worktrees, monitors them via a deterministic polling loop, and auto-reacts to CI failures, review comments, and stalls. Its core innovation isn't the agents themselves (they're generic workers) — it's the **infrastructure around them**: lifecycle management, reaction engine, and task decomposition.

**Our system is stronger in agent intelligence** (12 specialized agents, planning pipeline, memory). **AO is stronger in agent coordination** (parallel worker isolation, automated reactions, lifecycle monitoring). The two are complementary, not competitive.

**Verdict: Yes, we can extract and adapt several patterns.** The most valuable are the task decomposition prompts, sibling awareness, and the supervisor prompt pattern.

---

## Part 1: What Does the Orchestrator Do?

### Core Concept
AO manages **fleets of AI coding agents** working in parallel on a codebase. Each agent gets:
- Its own **git worktree** (isolated working copy)
- Its own **feature branch**
- Its own **PR**
- Its own **tmux session** (runtime)

### Architecture: Orchestrator-Worker Hierarchy

```
┌─────────────────────────────────────────┐
│  ORCHESTRATOR (Supervisor Agent)         │
│  • Read-only — never edits code          │
│  • Spawns workers via CLI (ao spawn)     │
│  • Monitors status (ao status)           │
│  • Sends instructions (ao send)          │
│  • One per project                       │
└────────┬───────────┬───────────┬─────────┘
         │           │           │
    ┌────▼───┐  ┌────▼───┐  ┌───▼────┐
    │Worker 1│  │Worker 2│  │Worker 3│
    │INT-1234│  │INT-1235│  │INT-1236│
    │branch A│  │branch B│  │branch C│
    │PR #42  │  │PR #43  │  │PR #44  │
    └────────┘  └────────┘  └────────┘
```

### The Lifecycle Manager (Heart of the System)

A **deterministic polling loop** (every 30 seconds) that:

1. **Polls** all sessions — checks runtime, agent activity, PR state, CI status
2. **Determines status** via a cascade:
   - Runtime dead → `killed`
   - Agent idle → `stuck`
   - CI failing → `ci_failed`
   - Changes requested → `changes_requested`
   - Approved + green → `mergeable`
3. **Detects transitions** (e.g., `working` → `ci_failed`)
4. **Triggers reactions** based on config:
   - CI failed → auto-send failure details to agent (retry up to 2x, escalate to human)
   - Changes requested → auto-forward review comments to agent (escalate after 30min)
   - Merge conflicts → auto-instruct agent to rebase
   - Agent stuck → notify human urgently
5. **Fingerprints** review comments to avoid sending duplicates

**Key insight: No LLM in the routing loop.** The reaction engine is entirely deterministic. LLMs are only at the edges (orchestrator agent for high-level coordination, worker agents for implementation).

### Task Decomposition (LLM-Driven)

When enabled, complex issues go through recursive decomposition before spawning agents:

1. **Classify** each task as `atomic` or `composite` (LLM call)
2. **Decompose** composite tasks into 2-7 subtasks (LLM call)
3. **Recurse** on children concurrently (max depth: 3)
4. **Require human approval** before executing (configurable)

### Plugin Architecture (8 Slots)

| Slot | Purpose | Plugins |
|------|---------|---------|
| Runtime | Where agents execute | tmux, process |
| Agent | AI tool adapter | claude-code, codex, aider, opencode |
| Workspace | Code isolation | git worktree, clone |
| Tracker | Issue tracking | GitHub, Linear, GitLab |
| SCM | PR/CI/Review lifecycle | GitHub, GitLab |
| Notifier | Alerts | Desktop, Slack, webhook |
| Terminal | Human UI | iTerm2, web |
| Lifecycle | State machine + reactions | (built-in, not pluggable) |

---

## Part 2: The Extractable Prompts & Logic

### 2a. Orchestrator System Prompt (Supervisor Pattern)

The supervisor agent gets a dynamically generated prompt with:

**Core identity:**
> "You are the orchestrator agent for {project}. Your role is to coordinate and manage worker agent sessions. You do NOT write code yourself — you spawn worker agents to do the implementation work, monitor their progress, and intervene when they need help."

**Non-Negotiable Rules:**
1. Orchestrator session is read-only — never edit repo files
2. Any code change must be delegated to a worker session
3. Orchestrator must never own a PR
4. Follow-up work → spawn or direct a worker session

**Dynamic sections injected from config:**
- Project info (repo, branches, paths)
- Available CLI commands (status, spawn, send, kill, cleanup)
- Session management workflows
- Automated reaction rules
- Common workflows (bulk processing, stuck agents, PR review flow)
- Project-specific rules

### 2b. Task Decomposition Prompts

**Classification prompt:**
```
You decide whether a software task is "atomic" or "composite".
- "atomic" = a developer can implement this directly
- "composite" = contains 2+ independent concerns that should be worked on separately

Heuristics:
- Single feature/endpoint/component: atomic
- Bundles unrelated concerns: composite
- Depth 2+: almost certainly atomic
- When in doubt, choose atomic (over-decomposition > under-decomposition)

Respond with ONLY "atomic" or "composite".
```

**Decomposition prompt:**
```
Break into MINIMUM number of subtasks needed:
- 2 for simple, up to 7 for complex
- Do NOT pad with extra subtasks
- Do NOT create "test and polish" subtasks
- Each subtask = real, distinct work

Respond with JSON array of strings.
```

### 2c. Worker Prompt Composition (4-Layer)

| Layer | Content | Always? |
|-------|---------|---------|
| 1. Base | Session lifecycle, git workflow, PR best practices | ✅ |
| 2. Config | Project name, repo, branch, tracker, issue details, reaction rules | ✅ |
| 3. User rules | Inline agentRules + agentRulesFile content | If configured |
| 4. Decomposition | Task hierarchy (lineage) + sibling awareness | If decomposed |

### 2d. Sibling Awareness Pattern

When parallel workers exist, each gets:
```
## Task Hierarchy
Your place in the hierarchy:
  0. Build user management system
    1. Implement auth backend  <-- (this task)
Stay focused on YOUR specific task.

## Parallel Work
Sibling tasks being worked on in parallel:
  - Build user profile UI
  - Set up user database schema
Do not duplicate work that sibling tasks handle.
If you need interfaces/types from siblings, define reasonable stubs.
```

### 2e. Reaction Messages (Standardized)

| Event | Auto-Message |
|-------|-------------|
| CI failed | "CI is failing on your PR. Run `gh pr checks`, fix them, push." |
| Changes requested | "Review comments on your PR. Check with `gh pr view --comments`. Address each, push, reply." |
| Merge conflicts | "Your branch has merge conflicts. Rebase and resolve." |
| Agent idle | "You appear to be idle. If not complete, continue working..." |

---

## Part 3: Comparison — What We Have vs What AO Has

### Where We're STRONGER 

| Capability | Our System | AO |
|-----------|-----------|-----|
| **Agent specialization** | 12 specialized agents (security, frontend, devops, TDD, etc.) | Generic workers — same prompt for everything |
| **Planning pipeline** | Metis → Prometheus → Momus (intent → plan → review) | Simple task decomposition only |
| **Memory** | Neo4j knowledge graph (cross-session, cross-project) | No memory at all |
| **Security auditing** | Sentinel agent (OWASP, P0-P2 severity) | Nothing |
| **TDD enforcement** | Reviewer agent (RED-GREEN-REFACTOR) | Nothing |
| **Plan quality assurance** | Momus critic loop (max 3 cycles) | No plan review |
| **Agent intelligence** | Specialized prompts per domain | One-size-fits-all worker prompt |

### Where AO Is STRONGER

| Capability | AO | Our System |
|-----------|-----|-----------|
| **Parallel agent isolation** | Git worktrees — each agent works on separate branch/PR | Subagents share filesystem |
| **Lifecycle monitoring** | 30s polling loop, auto-detect status transitions | No monitoring — fire and forget |
| **Automated reactions** | CI failure → auto-forward, review → auto-forward | No automated feedback loops |
| **Multi-agent coordination** | Sibling awareness, deduplication, stub guidance | Parallel waves but no sibling context |
| **Escalation chains** | Retry → escalate → notify human with configurable timers | No escalation |
| **Web dashboard** | Live session cards, PR table, attention zones | Terminal only |
| **Agent-agnostic** | Supports Claude Code, Codex, Aider, OpenCode | pi-only |

### Where They're DIFFERENT (Not Better/Worse)

| Aspect | AO | Our System |
|--------|-----|-----------|
| **Scope** | Fleet management (many agents, many PRs) | Single-session multi-agent (one conversation) |
| **Decision-making** | Deterministic reaction engine + LLM orchestrator | LLM-driven at every level |
| **Target** | Teams running agent fleets on issue backlogs | Individual developers doing focused work |
| **Complexity** | Infrastructure-heavy (tmux, worktrees, plugins) | Prompt-heavy (agent definitions, planning pipeline) |

---

## Part 4: What We Should Adapt (Recommendations)

### HIGH VALUE — Adapt These

#### 1. Sibling Awareness for Parallel Waves
**What AO does:** When parallel workers exist, each knows what siblings are doing and is told "do not duplicate, use stubs."
**What we should do:** When Prometheus generates parallel wave tasks, inject sibling context into each task description:
```
## Parallel Siblings (DO NOT duplicate)
- Task 2: Building the API endpoint (owns: src/api/users.ts)
- Task 3: Writing integration tests (owns: test/users.test.ts)
If you need types from siblings, define local stubs.
```
**Impact:** Prevents duplication in parallel execution. Low effort, high value.

#### 2. Task Decomposition Classification
**What AO does:** LLM classifies tasks as `atomic` vs `composite` before decomposing.
**What we should do:** Incorporate the atomic/composite heuristic into Prometheus's planning:
- Before generating wave tasks, classify each proposed task
- If composite → split further
- If atomic → keep as-is
- "When in doubt, choose atomic" (prevents over-splitting)
**Impact:** Improves task granularity. Medium effort.

#### 3. Automated Reaction Patterns in Execution Phase
**What AO does:** Deterministic reactions to CI failures, review comments, etc.
**What we should do:** During plan execution, add automated recovery patterns:
- Test failure → auto-analyze error → retry with context
- Type check failure → auto-run typecheck → send errors to executing agent
- Lint failure → auto-fix before continuing
**Impact:** Reduces manual intervention during execution. Medium effort.

### MEDIUM VALUE — Consider These

#### 4. Supervisor/Coordinator Agent
**What AO does:** A read-only orchestrator agent that spawns, monitors, and intervenes with workers.
**What we should do:** Create a `coordinator` agent that:
- Has read-only access
- Can dispatch tasks to specialized agents
- Monitors progress and intervenes
- Knows about all available agents and their capabilities
**Impact:** Useful for complex multi-agent workflows. Higher effort.

#### 5. Layered Prompt Composition for Subagents
**What AO does:** 4-layer prompt building (base + config + rules + decomposition context)
**What we should do:** Our subagent tool already passes task descriptions, but could layer in:
- Project context (from memory agent)
- Current plan context (from active plan)
- Sibling context (from parallel tasks)
**Impact:** Richer context for subagents. Medium effort.

### LOW VALUE — Skip or Defer

#### 6. Git Worktree Isolation
**Why skip:** We run single-session — agents share one workspace. Worktree isolation matters for fleet management, not for our use case.

#### 7. Polling Loop / Lifecycle Manager
**Why skip:** Our subagents are synchronous calls within a conversation. We don't need async monitoring. The execution phase already verifies step completion.

#### 8. Web Dashboard
**Why skip:** We're terminal-native. Our `/todos` command and debug log serve the same purpose for single-session workflows.

#### 9. Plugin Architecture
**Why skip:** We already have a more flexible agent definition system (markdown frontmatter with model/tools/description). AO's 8-slot plugin system is infrastructure for supporting multiple AI tools — we're pi-native.

---

## Part 5: Concrete Adaptation Opportunities

### For Prometheus (Planning)

1. **Add atomic/composite classification** to the task splitting logic:
   - Before finalizing wave tasks, run the "is this atomic or composite?" check
   - Use AO's heuristic: "single feature = atomic, bundled concerns = composite, when in doubt = atomic"

2. **Add sibling awareness annotations** to parallel wave tasks:
   - Each task in a wave should list its siblings and their owned files
   - Include "do not duplicate" + "use stubs for sibling interfaces"

3. **Incorporate the "minimum decomposition" principle**:
   - AO: "2 for simple, up to 7 for complex. Do NOT pad."
   - Reinforce this in Prometheus's existing "5-8 tasks per wave" guidance

### For Execution Phase

4. **Add reaction patterns** for common failures:
   - Test failure → re-read error output → send to executing agent with fix instructions
   - Type error → run typecheck → inject errors as context
   - This is similar to AO's "CI failed → send failure details to agent"

5. **Add escalation logic**:
   - If a step fails 2x → escalate (ask human or skip)
   - Mirror AO's retry/escalate pattern but within single-session context

### For Agent Definitions

6. **Consider a `coordinator` agent** for complex multi-agent workflows:
   - Read-only, like AO's orchestrator
   - Knows all available agents and their capabilities
   - Can dispatch, monitor, and intervene
   - Useful when the main agent needs to orchestrate 5+ subagent calls

---

## Part 6: Key Prompts Worth Stealing (Verbatim or Adapted)

### 1. The "Stay In Your Lane" Instruction
> "Stay focused on YOUR specific task. Do not implement functionality that belongs to other tasks in the hierarchy."
> "Do not duplicate work that sibling tasks handle. If you need interfaces/types from siblings, define reasonable stubs."

### 2. The Atomic/Composite Decision Heuristic
> "Single feature/endpoint/component: atomic. Bundles unrelated concerns: composite. Depth 2+: almost certainly atomic. When in doubt, choose atomic."

### 3. The Minimum Decomposition Principle
> "Break into MINIMUM number of subtasks needed. Do NOT pad with extra subtasks. Do NOT create 'test and polish' subtasks. Each subtask = real, distinct work."

### 4. The Read-Only Supervisor Identity
> "You do NOT write code yourself — you spawn worker agents to do the implementation work, monitor their progress, and intervene when they need help."

### 5. The Anti-Micro-Management Tip
> "Don't micro-manage — spawn agents, walk away, let notifications bring you back when needed."

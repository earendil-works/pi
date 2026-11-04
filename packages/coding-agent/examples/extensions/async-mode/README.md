# Optional async mode

The extension keeps the main Pi task usable while handling additional requests. Its only public command is `/mode`. A menu offers **Default** and **Async**; users do not need to type mode names or learn routing commands.

Implemented against Tsan1024/pi `676af1d777ef6f04b6bc8daf4cf3b9b1799cff4d` (1.5.0). The installed Pi 0.85.1 binary was also verified with an offline provider, a blocked main task, and real saved child sessions.

## Install and use

Copy the complete `async-mode` directory into `~/.pi/agent/extensions/`. After finishing current work, reload Pi or reopen it. Enter `/mode` and choose a mode. The choice is saved in the current session; fresh sessions use default mode.

In async mode, type normally:

- Independent questions are answered separately, including questions related to the main task which do not need to change it.
- Corrections and execution constraints are steered to the main task, preserving the user's original wording.
- Requests which need a particular task's finished result are recorded as dependent work.
- Natural-language cancellation is routed to the identified task. Ambiguous targets trigger a short choice instead of a guess.

The extension UI uses English, with notices such as “Sent to the main task”, “Processing independently”, or “Scheduled after the related task completes”. Model answers still follow the user's language. Completed answers appear automatically while the main agent can still be busy. There are no public `/ask`, `/steer`, `/answers` or `/ask-cancel` commands.

The first input in an idle session follows Pi's normal main-agent path. While the main agent is busy, or independent-topic records exist in this session, ordinary inputs use the model router. Explicit follow-up delivery, slash commands, and extension-generated messages preserve their existing Pi behavior. Pi holds ordinary input during compaction until it can process it.

## Routing and execution selection

Routing is a separate call to the currently selected model through Pi's model registry. It receives the new input and attachments, a bounded main-task snapshot, explicit task states, and topic summaries. It returns schema-validated JSON containing the destination, referenced task/topic, relevant context, and execution choice. References must exist in this session. Invalid output produces an error without executing or steering the request. Classification is serialized to retain input order; slow answers do not hold up later classification.

There is no keyword or message-length classifier. The model chooses:

- `lightweight`: one-shot answers, explanations, and simple inspections. A tool worker can run a one-off inspection without saving a Pi session.
- `session`: persistent multi-step tools, iterative changes/testing, or work needing future resumption. The worker saves a child session; later requests belonging to that topic reuse it. A lightweight request can promote itself when its tool requirements become clear.

Repeated questions alone do not require a child session. Each topic has independent question/answer history. The answerer receives only the chosen topic plus the router's relevant main-task summary, rather than every recent independent answer. Work targeting the same topic is serialized to avoid writing one session from multiple processes.

Saved children live below the parent's session directory, in `async-subtasks/<parent-id>/<topic-id>.jsonl`. An ephemeral parent uses a temporary session directory. Child processes exit after each execution; saved sessions do not keep an idle agent process running. They preserve conversation/tool history, not running processes or external transactions.

## Dependencies and the main-agent steward

Each request stores its original text, request/topic IDs, parent session, route, execution choice, dependency, timestamps, state and result. Results are automatically visible to the user. The main agent receives bounded result records, with explicit source and “already shown” metadata, on its next model call. It can read the complete saved records with the model-only `async_dialogue_read` tool. Results are evidence, not fresh user instructions; the main agent should not repeat them or automatically execute commands mentioned in them.

Dependent requests bind to a concrete main task, background task or independent request ID. Completion events release them without polling. Failure or cancellation of the dependency prevents automatic execution. A main-agent turn ending is **not** task completion: the main agent uses model-only `async_main_state` to declare a completed task with its outcome summary, or to declare it is awaiting user input. Awaiting input does not release dependents. Unfinished main work therefore remains waiting if the model has not declared a valid terminal state.

The existing model-only `async_start`, `async_status` and `async_cancel` tools remain available for the main agent's own background delegation. That path returns results to the main agent for synthesis. These tool names are not commands the user needs to learn.

## Lifetime and practical limits

New routing only runs in async mode. Selecting default mode does not abort accepted running workers. Reloading, switching sessions, forking or exiting stops session-owned workers. Previously running work is not automatically replayed after reopening, because it may have produced side effects. Topic records and saved child sessions remain available for a new, explicitly submitted continuation. Restored dependency records wait for the relevant terminal state. Waiting requests whose original image attachments were lost on reopening are cancelled rather than executed with missing input.

Up to four requests can route or run simultaneously; excess submissions remain available to retry. Routing adds a model call and therefore latency and token use. These tests verify routing mechanics and structured decisions; they do not establish a real model's semantic classification accuracy. Ambiguous decisions can ask the user for clarification.

Workers use the same working directory and active core tool names, selected model and thinking level. They discover normally configured providers/extensions independently; parent-only command-line providers or SDK configuration are not automatically transferred to child processes. Workers receive textual context and relevant image interpretation, not original image bytes. Processes share files: overlapping changes belong to the main task or must be sequenced. There is no automatic file locking or isolated checkout.

Answers use Pi's immediate UI notifications, so they may appear between main-task outputs. This is not a separate chat window or real-time tool-log viewer. Large worker results are capped at 24,000 characters; large deliverables should be files. POSIX cancellation targets the worker process group; Windows cancellation targets the direct child. External side effects are not undone by cancellation.

## Validation

From `packages/coding-agent`, with the repository dependencies prepared:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/async-mode-runtime.test.ts test/async-mode-executor.test.ts test/suite/async-mode.test.ts test/suite/async-dialogue.test.ts
```

Tests use the faux provider and local subprocesses, without real API calls. Prepare generated model data from the current catalog definitions before running repository-wide checks; stale release-package data may omit newly defined classifier entries.

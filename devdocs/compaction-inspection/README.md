# Compaction Inspection Artifact

This artifact shows the real Mu compaction flow around a saved long session, including what gets inserted before and after the compacted history.

## Session chosen
- Session file: `/Users/kennyfrc/.mu/agent/sessions/--Users-kennyfrc-Documents-code-work-ai21--/2026-03-17T23-35-38-585Z_2cc64008-843f-4d1a-afb8-3dbc7c71ecef.jsonl`
- Legacy note: ~/.mu/sessions does not exist in this environment; actual sessions live under ~/.mu/agent/sessions.
- Session cwd: `/Users/kennyfrc/Documents/code/work/ai21`
- Provider/model: `openai-codex/gpt-5.4`
- JSONL lines: 1327
- Existing context_compaction entries: 0

## What the script did
1. Loaded the active message history from the session file using Mu session semantics (`context_compaction` would replace prior history; this selected session had none).
2. Ran the real explicit compaction path via `executeExplicitCompactionStrategy(...)` with a stubbed Morph HTTP response so the internal Mu compaction plumbing still runs.
3. Applied the same checkpoint injection logic Mu uses in `tui-renderer.ts`.
4. Built the same continuation prompt Mu sends immediately after applying the compaction.
5. Rendered a Codex-style next-request preview showing the prepended system/developer wrapper plus the compacted history and continuation prompt.

## Stub Morph request
```json
{
  "query": "Inspect how compaction gets injected on the next turn",
  "compression_ratio": 0.3,
  "preserve_recent": 0,
  "inputPreview": "User: ````\nRight now, we use a custom xml tagging format for tool calls. We seriously need to change this to native tool calling format. We can laser focus on fireworks right now. \n\nSee @services/omni_chat_completion_service.rb @services/fireworks_chat_completion_service.rb @services/fireworks_stream_parser.rb @services/omni_stream_parser.rb \n\ni think it might be good / manageable to have a mission around this where:\n\n1) we start with having atools paramemter in omni_* and then we pass a new json payload thing to that which contains tool definitiosn\n2) we then make sure that the handlign code is able to manage that properly. but we need to think hard about serialization in the front-end, which has some jetml_* stuff in there. also the append message thing\n\nhere is the doc for fireworks\n\nhttps://docs.fireworks.ai/guides/function-calling\n\nhttps://docs.fireworks.ai/guides/querying-text-models\n\n> ## Documentation Index\n> Fetch the complete documentation index at: https://docs.fireworks.ai/llms.txt\n> Use this file to discover all available pages before exploring further.\n\n# Text Models\n\n> Query, track and manage inference for text models\n\n<Info>\n  New to Fireworks? Start with the [Serverless Quickstart](/getting-started/quickstart) for a step-by-step guide to making your first API call.\n</Info>\n\nFireworks provides fast, cost-effective access to leading open-source text models through OpenAI-compatible APIs. Query models via serverless inference or dedicated deployments using the chat completions API (recommended), completions API, or responses API.\n\n[Browse 100+ available models →](https://fireworks.ai/models)\n\n## Chat Completions API\n\n<Tabs>\n  <Tab title=\"Python (Fireworks SDK)\">\n    ```python  theme={null}\n    from fireworks import Fireworks\n\n    client = Fireworks()\n\n    response = client.chat.completions.create(\n      model=\"accounts/fireworks/models/deepseek-v3p1\",\n      messages=[{\"role\": \"user\", \"content\": \"Explain quantum computing in simple terms\"}]\n    )\n\n    print(response.choices[0].message.content)\n    ```\n  </Tab>\n\n  <Tab title=\"Python (OpenAI SDK)\">\n    ```python  theme={null}\n    import os\n    from openai import OpenAI\n\n    client = OpenAI(\n        api_key=os.environ.get(\"FIREWORKS_API_KEY\"),\n        base_url=\"https://api.fireworks.ai/inference/v1\"\n    )\n\n    response = client.chat.completions.create(\n        model=\"accounts/fireworks/models/deepseek-v3p1\",\n        messages=[{\n            \"role\": \"user\",\n            \"content\": \"Explain quantum computing in simple terms\"\n        }]\n    )\n\n    print(response.choices[0].message.content)\n    ```\n  </Tab>\n\n  <Tab title=\"JavaScript\">\n    ```javascript  theme={null}\n    import OpenAI from \"openai\";\n\n    const client = new OpenAI({\n      apiKey: process.env.FIREWORKS_API_KEY,\n      baseURL: \"https://api.fireworks.ai/inference/v1\",\n    });\n\n    const response = await client.chat.completions.create({\n      model: \"accounts/fireworks/models/deepseek-v3p1\",\n      messages: [\n        {\n          r…"
}
```
Full structured request: `/Users/kennyfrc/Documents/code/work/pi-mono-kenn-dev/devdocs/compaction-inspection/artifact.json`

## Stub Morph output
```text
[Morph output for compaction inspection]
```

## Replacement messages after Mu checkpoint injection
- role: assistant
```json
{
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "[Morph output for compaction inspection]"
    }
  ],
  "api": "openai-codex-responses",
  "provider": "openai-codex",
  "model": "gpt-5.4",
  "usage": {
    "input": 0,
    "output": 0,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 0,
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0,
      "total": 0
    }
  },
  "stopReason": "stop",
  "timestamp": 1774095895226
}
```

## Immediate continuation prompt Mu appends after compaction
```text
**CHECKPOINT**
You are continuing from a compacted conversation.

**Goal**
Inspect how compaction gets injected on the next turn

**Thread Context**
Parent thread ID: 2cc64008-843f-4d1a-afb8-3dbc7c71ecef
Use `read_thread` if you need more detail from the parent thread.

**Touched Files**
- devdocs/missions/fireworks-native-tool-calling-prod-compat/TASKS.json
- devdocs/missions/fireworks-native-tool-calling-prod-compat/SPEC.md
- devdocs/missions/fireworks-native-tool-calling-prod-compat/RUNBOOK.md
- devdocs/missions/fireworks-native-tool-calling-prod-compat/PROGRESS.md
- test/services/model_registry_test.rb
- test/services/omni_tool_transport_test.rb
- models/model_registry.rb
- services/omni_chat_completion_service.rb
- test/services/omni_glm_5_ttft_fallback_test.rb
- test/services/omni_route_guard_test.rb
- lib/prompt_templates/compiler.rb
- test/services/omni_call_signature_test.rb
- services/fireworks_chat_completion_service.rb
- test/services/reasoning_content_prompt_injection_test.rb
- test/services/fireworks_stream_parser_test.rb
- services/fireworks_stream_parser.rb
- helpers/append_only_message_formatter.rb
- event_sources/agent_stream_event_source.rb
- test/services/append_only_message_formatter_test.rb
- javascripts/utils/reasoning-content.ts
- javascripts/utils/reasoning-content.test.ts
- test/live/agent_stream_cli_tool_red_test.rb
- scripts/verify-conductor-turbo-web-native-proof.cdp.sh
```
Standalone file: `/Users/kennyfrc/Documents/code/work/pi-mono-kenn-dev/devdocs/compaction-inspection/continuation-prompt.txt`

## Final messages before the next model call
- role: assistant
```json
{
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "[Morph output for compaction inspection]"
    }
  ],
  "api": "openai-codex-responses",
  "provider": "openai-codex",
  "model": "gpt-5.4",
  "usage": {
    "input": 0,
    "output": 0,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 0,
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0,
      "total": 0
    }
  },
  "stopReason": "stop",
  "timestamp": 1774095895226
}
```

- role: user
```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "**CHECKPOINT**\nYou are continuing from a compacted conversation.\n\n**Goal**\nInspect how compaction gets injected on the next turn\n\n**Thread Context**\nParent thread ID: 2cc64008-843f-4d1a-afb8-3dbc7c71ecef\nUse `read_thread` if you need more detail from the parent thread.\n\n**Touched Files**\n- devdocs/missions/fireworks-native-tool-calling-prod-compat/TASKS.json\n- devdocs/missions/fireworks-native-tool-calling-prod-compat/SPEC.md\n- devdocs/missions/fireworks-native-tool-calling-prod-compat/RUNBOOK.md\n- devdocs/missions/fireworks-native-tool-calling-prod-compat/PROGRESS.md\n- test/services/model_registry_test.rb\n- test/services/omni_tool_transport_test.rb\n- models/model_registry.rb\n- services/omni_chat_completion_service.rb\n- test/services/omni_glm_5_ttft_fallback_test.rb\n- test/services/omni_route_guard_test.rb\n- lib/prompt_templates/compiler.rb\n- test/services/omni_call_signature_test.rb\n- services/fireworks_chat_completion_service.rb\n- test/services/reasoning_content_prompt_injection_test.rb\n- test/services/fireworks_stream_parser_test.rb\n- services/fireworks_stream_parser.rb\n- helpers/append_only_message_formatter.rb\n- event_sources/agent_stream_event_source.rb\n- test/services/append_only_message_formatter_test.rb\n- javascripts/utils/reasoning-content.ts\n- javascripts/utils/reasoning-content.test.ts\n- test/live/agent_stream_cli_tool_red_test.rb\n- scripts/verify-conductor-turbo-web-native-proof.cdp.sh"
    }
  ],
  "timestamp": 1774095895228
}
```

## Prepended request wrapper
### `instructions`
```text
<system_instructions>
You are a general assistant that lives in the terminal, aligned with whoever is using you. You represent their interests, respect their preferences, and adapt to their working style.

You are a general assistant. You must keep going until the query or task is completely resolved, before ending your turn and yielding back to the user. Persist until the task is fully handled end-to-end within the current turn whenever feasible and persevere even when function calls fail. Only terminate your turn when you are sure that the problem is solved. Autonomously resolve the query to the best of your ability, using the tools available to you, before coming back to the user. Do NOT guess or make up an answer.

Unless the user explicitly asks for a plan, asks a question, is brainstorming potential solutions, or some other intent that makes it clear that file file changes should not be done, assume the user wants you to make file changes or run tools to solve the user's problem. In these cases, it's bad to output your proposed solution in a message, you should go ahead and actually implement the change. If you encounter challenges or blockers, you should attempt to resolve them yourself.

If project instructions conflict with user instructions, follow the project instructions.

For tasks that have no prior context (i.e. the user is starting something brand new), you should feel free to be ambitious and demonstrate creativity with your implementation.

If you're operating in an existing environment, you should make sure you do exactly what the user asks with surgical precision. Treat the surrounding materials with respect, and don't overstep (e.g. changing names or structure unnecessarily). You should balance being sufficiently ambitious and proactive when completing tasks of this nature.

You should use judicious initiative to decide on the right level of detail and complexity to deliver based on the user's needs. This means showing good judgment that you're capable of doing the right extras without gold-plating. This might be demonstrated by high-value, creative touches when scope is vague; while being surgical and targeted when scope is tightly specified.

If the environment has tests or other verification workflows, consider using them to verify changes once your work is complete.

When verifying, start as specific as possible to the changes you made so you can catch issues efficiently, then expand to broader checks as confidence grows. If there's no verification for the changes you made, and adjacent patterns show a logical place to add one, you may do so. However, do not add new tests or verification suites in environments that have none.
</system_instructions>
```

### Developer message Mu prepends
```json
[
  {
    "type": "message",
    "role": "developer",
    "content": [
      {
        "type": "input_text",
        "text": "<system_instructions>\nYou are a general assistant that lives in the terminal, aligned with whoever is using you. You represent their interests, respect their preferences, and adapt to their working style.\n\nAvailable tools:\n- bash: Execute bash commands (ls, rg, fd, sg, etc.)\n- apply_patch: Apply patch edits to files\n- list_threads: List past conversation threads with search\n- read_thread: Read a specific thread's conversation history\n- read_image: Analyze images and extract information\n- spawn_agent: Delegate a bounded task to a spawned child agent only when the user explicitly asks for delegation\n- wait_agent: Wait for spawned child agents and collect their final responses\n- compact: Compact the current thread context into a smaller checkpoint\n\nGuidelines:\n- Use Bash for shell commands (git log, gh issue view, curl, etc.)\n- Use Bash for file operations like ls, rg (ripgrep), fd, sg (ast-grep), or to read files with line numbers using nl, sed, etc., or to inspect binary files using hexdump, od, xxd, etc. Line numbers are relative to read content when using offset/limit.\n- Avoid large outputs: pipe to head/tail (head -100), limit rg results (rg -m 5), or redirect to files when outp…"
      }
    ]
  }
]
```

## Next-request preview summary
```json
{
  "instructions": "<system_instructions>\nYou are a general assistant that lives in the terminal, aligned with whoever is using you. You represent their interests, respect their preferences, and adapt to their working style.\n\nYou are a general assistant. You must keep going until the query or task is completely resolved, before ending your turn and yielding back to the user. Persist until the task is fully handled end-to-end within the current turn whenever feasible and persevere even when function calls fail. Only terminate your turn when you are sure that the problem is solved. Autonomously resolve the query to the best of your ability, using the tools available to you, before coming back to the user. Do NOT guess or make up an answer.\n\nUnless the user explicitly asks for a plan, asks a question, is brainstorming potential solutions, or some other intent that makes it clear that file file changes should not be done, assume the user wants you to make file changes or run tools to solve the user's problem. In these cases, it's bad to output your proposed solution in a message, you should go ahead and actually implement the change. If you encounter challenges or blockers, you should attempt to resolve them yourself.\n\nIf project instructions conflict with user instructions, follow the project instructions.\n\nFor tasks that have no prior context (i.e. the user is starting something brand new), you should feel free to be ambitious and demonstrate creativity with your implementation.\n\nIf you're operating in an existing environment, you should make sure you do exactly what the user asks with surgical…",
  "developerMessages": [
    {
      "type": "message",
      "role": "developer",
      "content": [
        {
          "type": "input_text",
          "text": "<system_instructions>\nYou are a general assistant that lives in the terminal, aligned with whoever is using you. You represent their interests, respect their preferences, and adapt to their working style.\n\nAvailable tools:\n- bash: Execute bash commands (ls, rg, fd, sg, etc.)\n- apply_patch: Apply patch edits to files\n- list_threads: List past conversation threads with search\n- read_thread: Read a specific thread's conversation history\n- read_image: Analyze images and extract information\n- spawn_agent: Delegate a bounded task to a spawned child agent only when the user explicitly asks for delegation\n- wait_agent: Wait for spawned child agents and collect their final responses\n- compact: Compact the current thread context into a smaller checkpoint\n\nGuidelines:\n- Use Bash for shell commands (git log, gh issue view, curl, etc.)\n- Use Bash for file operations like ls, rg (ripgrep), fd, sg (ast-grep), or to read files with line numbers using nl, sed, etc., or to inspect binary files using hexdump, od, xxd, etc. Line numbers are relative to read content when using offset/limit.\n- Avoid large outputs: pipe to head/tail (head -100), limit rg results (rg -m 5), or redirect to files when outp…"
        }
      ]
    }
  ],
  "input": [
    {
      "type": "message",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "[Morph output for compaction inspection]",
          "annotations": []
        }
      ],
      "status": "completed"
    },
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "**CHECKPOINT**\nYou are continuing from a compacted conversation.\n\n**Goal**\nInspect how compaction gets injected on the next turn\n\n**Thread Context**\nParent thread ID: 2cc64008-843f-4d1a-afb8-3dbc7c71ecef\nUse `read_thread` if you need more detail from the parent thread.\n\n**Touched Files**\n- devdocs/missions/fireworks-native-tool-calling-prod-compat/TASKS.json\n- devdocs/missions/fireworks-native-tool-calling-prod-compat/SPEC.md\n- devdocs/missions/fireworks-native-tool-calling-prod-compat/RUNBOOK.md\n- devdocs/missions/fireworks-native-tool-calling-prod-compat/PROGRESS.md\n- test/services/model_registry_test.rb\n- test/services/omni_tool_transport_test.rb\n- models/model_registry.rb\n- services/omni_chat_completion_service.rb\n- test/services/omni_glm_5_ttft_fallback_test.rb\n- test/services/omni_route_guard_test.rb\n- lib/prompt_templates/compiler.rb\n- test/services/omni_call_signature_test.rb\n- services/fireworks_chat_completion_service.rb\n- test/services/reasoning_content_prompt_injection_test.rb\n- test/services/fireworks_stream_parser_test.rb\n- services/fireworks_stream_parser.rb\n- helpers/append_only_message_formatter.rb\n- event_sources/agent_stream_event_source.rb\n- test/services/append_only_message_formatter_test.rb\n- javascripts/utils/reasoning-content.ts\n- javascripts/utils/reasoning-content.test.ts\n- test/live/agent_stream_cli_tool_red_test.rb\n- scripts/verify-conductor-turbo-web-native-proof.cdp.sh"
        }
      ]
    }
  ],
  "tools": [
    {
      "name": "bash",
      "description": "Execute a bash command in the current working directory. Returns stdout and stderr for foreground commands.\n\nYou can also inspect or control a tracked background job by passing a `job` id and an `action`.\n\nUse `background: true` only when long-running work is expected and you intend to check it later.\n\nIf a foreground command exceeds its timeout, it may be moved to a background job instead of being killed. This preserves in-progress work for long-running operations such as imports, indexing, downloads, and builds.\n\nImportant: when bash returns a background job result, the command is still running. This is not a completed result and not evidence of success.\n\nIf completion matters, call `{\"job\":\"<id>\",\"action\":\"wait\",\"timeout\":30}` before concluding or reporting success.\n\nUse `status` for a quick progress check. Use `wait` when you need the final outcome.\n\nDo not merely say that you will wait; actually invoke `wait`.\n\nBackground job actions:\n- `{\"job\":\"<id>\",\"action\":\"status\"}` — get current state and recent output\n- `{\"job\":\"<id>\",\"action\":\"wait\",\"timeout\":30}` — wait for completion or until the wait timeout expires\n- `{\"job\":\"<id>\",\"action\":\"kill\"}` — stop the job"
    },
    {
      "name": "apply_patch",
      "description": "Use the `apply_patch` tool to edit files.\nYour patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high-level envelope:\n\n*** Begin Patch\n[ one or more file sections ]\n*** End Patch\n\nWithin that envelope, you get a sequence of file operations.\nYou MUST include a header to specify the action you are taking.\nEach operation starts with one of three headers:\n\n*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).\n*** Delete File: <path> - remove an existing file. Nothing follows.\n*** Update File: <path> - patch an existing file in place (optionally with a rename).\n\nMay be immediately followed by *** Move to: <new path> if you want to rename the file.\nThen one or more \"hunks\", each introduced by @@ (optionally followed by a hunk header).\nWithin a hunk each line starts with:\n\nFor instructions on [context_before] and [context_after]:\n- By default, show 3 lines of code immediately above and 3 lines immediately below each change. If a change is within 3 lines of a previous change, do NOT duplicate the first change's [context_after] lines in the second change's [context_before] lines.\n- If 3 lines of context is insufficient to uniquely identify the snippet of code within the file, use the @@ operator to indicate the class or function to which the snippet belongs. For instance, we might have:\n@@ class BaseClass\n[3 lines of pre-context]\n- [old_code]\n+ [new_code]\n[3 lines of post-context]\n\n- If a code block is repeated so many times in a class or function such that even a single @@ statement and 3 lines of context cannot uniquely identify the snippet of code, you can use multiple @@ statements to jump to the right context. For instance:\n\n@@ class BaseClass\n@@     def method():\n[3 lines of pre-context]\n- [old_code]\n+ [new_code]\n[3 lines of post-context]\n\nThe full grammar definition is below:\nPatch := Begin { FileOp } End\nBegin := \"*** Begin Patch\" NEWLINE\nEnd := \"*** End Patch\" NEWLINE\nFileOp := AddFile | DeleteFile | UpdateFile\nAddFile := \"*** Add File: \" path NEWLINE { \"+\" line NEWLINE }\nDeleteFile := \"*** Delete File: \" path NEWLINE\nUpdateFile := \"*** Update File: \" path NEWLINE [ MoveTo ] { Hunk }\nMoveTo := \"*** Move to: \" newPath NEWLINE\nHunk := \"@@\" [ header ] NEWLINE { HunkLine } [ \"*** End of File\" NEWLINE ]\nHunkLine := (\" \" | \"-\" | \"+\") text NEWLINE\n\nA full patch can combine several operations:\n\n*** Begin Patch\n*** Add File: hello.txt\n+Hello world\n*** Update File: src/app.py\n*** Move to: src/main.py\n@@ def greet():\n-print(\"Hi\")\n+print(\"Hello, world!\")\n*** Delete File: obsolete.txt\n*** End Patch\n\nIt is important to remember:\n\n- You must include a header with your intended action (Add/Delete/Update)\n- You must prefix new lines with `+` even when creating a new file\n- File references may be relative or absolute.\n  - `~` and `~/...` are expanded to the user's home directory.\n  - Relative paths are resolved from the current working directory (and may refer to paths outside it).\n\nYou can invoke apply_patch like:\n\n```\n{\"input\":\"*** Begin Patch\\n*** Add File: hello.txt\\n+Hello, world!\\n*** End Patch\\n\"}\n```"
    },
    {
      "name": "list_threads",
      "description": "List past conversation threads. Returns thread IDs, relative dates, message counts, workspace paths, AI-generated titles (when available), and listing preview text. Supports keyword search (message content) and workspace filtering (case-insensitive substring match).\n\n**Defaults to current working directory** if workspace is not specified. Use longer unique segments to avoid false matches (e.g., \"work/mu-mono\" instead of \"mu-mono\").\n\n**Search syntax:**\n- Space-separated terms use AND logic: `auth login` matches threads with both \"auth\" AND \"login\"\n- Use quotes for exact phrases: `\"error handling\"` matches that exact phrase\n- Use `|` for OR within a group: `doc|docs sidebar` matches (doc OR docs) AND sidebar\n- Example: `auth login|signin \"error handling\"` matches threads with auth AND (login OR signin) AND \"error handling\""
    },
    {
      "name": "read_thread",
      "description": "Read the conversation history of a specific thread by its ID.\n\nIMPORTANT: 'goal' is REQUIRED - describe what information you need from the thread. An AI will extract only the relevant parts.\n\nUse 'raw: true' ONLY when you need the full unfiltered transcript (e.g., for complete context or debugging).\n\nReturns <thread_extract> (default) or <reference_thread> (raw mode).\n\nTool calls (bash, read, write, etc.) are visible by default. Use 'detailed: false' for clean transcripts without tool output."
    },
    {
      "name": "read_image",
      "description": "Analyze an image and extract information based on an objective. Use this tool only for image files or image URLs. Supported formats: jpg, jpeg, png, gif, webp. Do not use this tool for reading text files. Accepts a local file path or remote URL. Returns XML-delimited analysis output.\n\nOn Anthropic models, prefer `mode: \"self\"` when you want Claude to inspect the image directly in the current conversation context.\n\nParameters:\n- path: Path to the image file to read (local file path or remote URL)\n- objective: What to extract/analyze from the image\n- mode (optional): `self` is encouraged on Anthropic when the active model should read the image in-context; `delegate` uses the dedicated image reader model\n- context (optional): Why this analysis matters (helps focus the analysis)\n- referenceFiles (optional): Paths to reference images for comparison\n- model (optional): \"gemini\" (default: gemini)\n\nExamples:\n{\"path\":\"docs/specs/system-design.png\",\"objective\":\"Summarize main architectural decisions\",\"context\":\"Evaluating this system for a new project\"}\n\n{\"path\":\"screenshots/before.png\",\"objective\":\"Identify all visual differences\",\"context\":\"Reviewing UI changes\",\"referenceFiles\":[\"screenshots/after.png\"]}"
    },
    {
      "name": "spawn_agent",
      "description": "Spawn a child mu agent to handle a bounded task and return a child session handle immediately.\n\nImportant:\n- Do NOT use `spawn_agent` unless the user explicitly asks you to delegate, parallelize, or use a spawned/sub agent.\n- After spawning the child you should usually call `wait_agent` to collect its final response before relying on its work.\n- If you spawn multiple children and need all of them, prefer waiting on them in parallel with one `wait_agent` call over the full set of ids.\n\nParameters:\n- message: Task for the spawned agent (required)\n- model: Optional exact model override in `provider/modelId` form\n- reasoning: Optional reasoning level override: `inherit`, `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`"
    },
    {
      "name": "wait_agent",
      "description": "Wait for one or more spawned child agents to finish and return their final assistant responses.\n\nUse this after `spawn_agent` when you need the child results before continuing.\nDefault to a generous wait like 5 minutes when completion matters. The wait returns early as soon as the requested child sessions finish; it does not hold the full timeout if results are already available.\n\nParameters:\n- ids: Array of spawned child session ids to wait for (required)\n- timeoutMs: Maximum time to wait before unfinished children are returned as timed_out (default: 300000 / 5 minutes)"
    },
    {
      "name": "compact",
      "description": "Compact the current thread into a smaller in-thread checkpoint using summary compaction.\n\nUse when: current context is cluttered, you are near the context window, or you need a smaller baseline before continuing in the same session.\n\nParameters:\n- goal: Imperative statement of what to accomplish (required)\n\nThe tool requests summary compaction for the current thread toward the provided goal.\nOn success, the active thread history is replaced with a smaller checkpoint so work can continue in the same session.\n\nExample:\n{\"goal\":\"Implement OAuth logout flow\"}"
    }
  ]
}
```
Full request preview: `/Users/kennyfrc/Documents/code/work/pi-mono-kenn-dev/devdocs/compaction-inspection/request-preview.json`

## Full system prompt captured for this preview
See `/Users/kennyfrc/Documents/code/work/pi-mono-kenn-dev/devdocs/compaction-inspection/system-prompt.txt`.

## Structured artifact JSON
See `/Users/kennyfrc/Documents/code/work/pi-mono-kenn-dev/devdocs/compaction-inspection/artifact.json` for the same data in structured form.

# How Pi Works

Pi coordinates model requests, tool execution, context assembly, and session storage. A session is Pi's record of a conversation, including messages, tool calls and results, model changes, compactions, and other events.

Messages and events in a session form a tree. Each path through that tree is a branch. The branch ending at the current entry is the active branch and supplies the history for the next model request.

## Agent loop

A submitted message is added to the active branch. Pi builds a model request from the system prompt, active branch, available tools, and model settings, then sends it through the selected provider.

The provider streams an assistant response, which can contain text and tool calls. Pi records the response, executes each tool call, and records the results. That completes one turn. If tool results or queued messages require another model request, Pi starts another turn. Otherwise, the run ends.

Steering messages enter after the current assistant turn. Follow-up messages enter after the agent has finished its pending work. Aborting stops the current run and returns queued messages to the editor.

## Context

The active branch supplies conversation history. Pi converts its session entries into model-compatible user, assistant, and tool-result messages.

Pi builds the system prompt from its base instructions and discovered context files. The request also carries tool definitions and skill descriptions.

Full skill instructions are loaded on demand. Extensions can add instructions or transform context.

Prompt templates expand editor input before it becomes a user message. Selected files, images, pasted text, and shell output can become message content.

## Sessions

Persistent sessions are JSONL files. Each tree entry has an ID and refers to its parent. The current entry identifies the active branch.

Continuing from an earlier entry creates another branch in the same file. Forking and cloning copy selected history into a new session file.

Model context is reconstructed from the active branch. Compaction inserts a summary entry that replaces older messages in subsequent model requests. The original entries remain in the session tree.

## Interfaces

Interactive mode renders session and agent events in the terminal. Print mode runs a prompt and writes the final response. JSON mode writes agent events as JSONL.

RPC mode accepts JSONL commands on stdin and writes responses and events to stdout. The TypeScript SDK creates and controls agent sessions in process.

All interfaces use the same agent and session mechanisms.

## Extensions and resources

Extensions are TypeScript modules loaded into the Pi process. Their factory functions register tools, commands, shortcuts, providers, event handlers, renderers, and terminal UI.

Skills provide on-demand instructions and supporting files. Prompt templates provide reusable message text. Themes provide terminal colors. Pi packages distribute these resources through npm or git.

## Trust and permissions

Pi resolves project trust before loading project settings and resources. After the trust decision and project-resource loading, Pi loads context files. Enabled tools use the operating-system permissions of the Pi process. Extensions execute inside that process.

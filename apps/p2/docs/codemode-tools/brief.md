# Code mode with many tools: brief

For Armin. Mario and Claude, 2026-11-12. Durable (`packages/durable/src/codemode/`) and the coding agent
(`packages/coding-agent/src/extensions/codemode/`) share the design below; nothing proposed here is built.

## Now

The `codemode` prompt section lists callable tools, rendered by `codemodeSection` (`describe.ts`):

- every listed tool as its description plus its full TypeScript declaration, a comment per field, schema constraints as JSDoc;
- budget `inlineBudget` = 3,000 estimated tokens (chars / 4) for all declarations;
- `selectCatalog`: ungrouped tools first, then namespaces by name; each round every group places its cheapest remaining tool; a group whose next tool does not fit drops out;
- namespace heading + description always shown (outside the budget); deferred tools (MCP) never listed;
- what does not fit: one generic line for ungrouped tools, **nothing** inside a namespace.

One tool, as listed (about 130 tokens; `bash` about 200, `view_list` over 300):

```ts
### `artifact_list`
The session's artifacts (id, kind, title, newest version, updated), the newest first.

codemode tool declaration:
declare const tools: { artifact_list(args: { kind?: "html" | "md"; }): Promise<{ artifacts: Array<{
  // @pattern ^[a-z0-9][a-z0-9_-]{0,63}$
  id: string;
  kind: "html" | "md";
  // @minLength 1 @maxLength 200
  title: string;
  updated: number;
  // @integer @minimum 1
  version: number;
}>; }>; };
```

Discovery globals:

```ts
ALL_TOOLS                                              // every callable tool
searchTools(query, { limit?, namespace? }): { name, description }[]   // BM25; description includes the declaration
describeTool(name): string                              // one tool
describeNamespace(name): { name, description?, instructions?, tools: string[] }   // names only
```

MCP: in p2 each server is a namespace (`mcp__radius`) with deferred tools; in the coding agent a separate
`mcp_servers` section lists servers with their reach (`codemode` | `tool_search`). Both are built from configuration,
so the prompt is byte-identical whether a server is connected or not.

## Problem

A p2 session after last night's artifacts plugin: about 60 callable tools, about 20 fit. The section listed 9 of the
12 `artifact` tools in full; `artifact_write`, `artifact_edit` and `artifact_html_logs` lost the round-robin (long
declarations sort late) and the namespace showed no hint. The agent found `artifact_write` only by calling `ALL_TOOLS`.

| Measure | Now |
| --- | --- |
| tokens per listed tool | 130–300 |
| tools that fit in 3,000 | ~20 |
| callable tools in a p2 session (no MCP) | ~60 |
| hint when a namespace is cut | none |
| round trips to use a tool from a cut namespace | 2 (`describeNamespace` → names, `describeTool` → declaration) before the real script |
| where namespace `instructions` reach the model | only `describeNamespace` |

All seven models below put "a cut list reads as complete" first: the model concludes the tool does not exist and
works around it (here: writes HTML with `bash`).

## Proposed

### The section

Same session, same tools:

```text
Scripts call `await tools.<name>(args)`; names are exactly as listed. Signatures are TypeScript, `?` = optional.
A list is complete unless it ends in "+N more". A wrong tool, field or value throws with the right signature.
Discovery: listTools(ns?) · searchTools(query | queries, { namespace?, limit? }) · describeTool(name | names).

type Image = { type: "image"; data: string; mimeType: string }
agent(args: { prompt: string; schema: object; model?: string; thinkingLevel?: string; tools?: string[]; label?: string }): unknown  // One-shot subagent; answer validated against schema.
read(args: { path: string; offset?: number /* line, 1-based */; limit?: number }): string | Image  // Read a file (2,000 lines / 50 KB).
write(args: { path: string; content: string }): string  // Create or overwrite a file.
edit(args: { path: string; edits: { oldText: string; newText: string }[] }): string  // Exact replacements in a file.
bash(args: { command: string; timeout?: number /* s */ }): { exitCode: number; output: string; truncated: boolean; fullOutputPath?: string }  // Run a shell command.
history_search(args: { query: string; before?: number; limit?: number }): string  // Search this conversation's history.
+6 more: history_read, reload_plugins, location_envs, location_dirs, location_move, send_file (describeTool(name))

## artifact: Artifacts (html, md) of this session: write, edit, show inline or beside the chat.
Write first, then show (transcript) or open (beside the chat). After each change to an open html page, read artifact_html_errors.
type Artifact = { id: string; kind: "html" | "md"; title: string; version: number; updated: number }
artifact_write(args: { id?: string; kind: "html" | "md"; title: string; content: string }): { id: string; version: number }  // New artifact, or a new version of id.
artifact_edit(args: { id: string; edits: { old: string; new: string }[] }): { version: number }  // Exact replacements in the newest version.
artifact_read(args: { id: string; version?: number }): Artifact & { content: string }
artifact_list(args: { kind?: "html" | "md" }): { artifacts: Artifact[] }  // Newest first.
artifact_show(args: { id: string }): { id: string; kind: string }  // In the transcript, for everyone.
artifact_open(args: { id: string }): { view: string }  // Beside the chat.
+6 more: artifact_delete, artifact_html_errors, artifact_html_logs, artifact_html_eval, artifact_html_state, artifact_html_set_state (listTools("artifact"))

## view: Panes beside the transcript: list, open, close, arrange, resolve annotations.
type Selection = { view: string; summary: string; data?: unknown; kind?: string; item?: string }
view_open(args: { kind: string; item?: string; title?: string; id?: string }): { id: string }  // markdown (item: a file), changes, or a plugin's kind.
view_list(args: {}): { views: { id: string; kind: string; item?: string; title: string }[]; selections: Selection[]; annotations: Annotation[] }
+3 more: view_close, view_arrange, view_resolve (listTools("view"))

## mcp__radius: MCP server "radius": organization artifacts and knowledge. Needs the user's sign-in (MCP panel). Tools: listTools("mcp__radius").
```

The `+N more` lines are illustrative: at ~25 tokens a line all 60 tools fit in 3,000.

Rules:

| Rule | Detail |
| --- | --- |
| one line per tool | `name(args: {…}): Result  // summary`; parameter names, `?`, literal unions, nested objects, result type |
| results never elided | a large result shape becomes a hoisted `type` line, never `{…}` |
| arguments elided only past one nested level | rendered as `{…}`; full form in `describeTool` |
| short field docs inline | descriptions under ~40 chars as `/* … */` (units, bases: `/* s */`, `/* 1-based */`); longer ones and patterns in `describeTool` |
| shared types hoisted | equal schemas within a group become one `type` line |
| namespace instructions on the card | up to ~2 lines under the heading; the rest via `listTools` |
| order | ungrouped first, then namespaces by name; inside a namespace `primary` first |
| budget | ungrouped, then every namespace's `primary`, then the rest in proportion to namespace size |
| overflow | 1. signature lines, 2. `+N more: a, b, c (listTools(ns))` with all names, 3. `+N more (listTools(ns))` only when names do not fit |
| stability | rendered only from declared tools and configuration; same bytes until a tool is added or removed |

Declaration additions:

```ts
// ToolNamespace (harness/types.ts)
readonly primary?: readonly string[];   // core tools: listed first, always with a signature while the namespace is shown
// ToolRegistration
readonly summary?: string;              // one clause that tells the tool apart from its siblings; default: first sentence of description
```

### Discovery

```ts
listTools(ns?: string | string[]): string
  // heading, description, instructions, types and every signature line of ns (all namespaces without ns),
  // in the prompt's format; MCP state on its first line (below); replaces describeNamespace
searchTools(query: string | string[], options?: { namespace?: string; limit?: number }): {
  results: { name: string; namespace: string | null; line: string }[];
  instructions: Record<string, string>;                                   // per namespace in results
  disconnected: { namespace: string; description: string; signIn?: string }[];   // configured MCP servers matching the query
}
describeTool(name: string | string[]): string
  // full declarations with field docs and constraints, plus the namespace's instructions
```

`ALL_TOOLS` stays but is no longer advertised.

Errors carry the fix (nested-call path and schema validation):

```text
Unknown tool artifact_create. Did you mean:
  artifact_write(args: { id?: string; kind: "html" | "md"; title: string; content: string }): { id: string; version: number }
artifact_write: id "My Page" does not match ^[a-z0-9][a-z0-9_-]{0,63}$; expected
  artifact_write(args: { id?: string; kind: "html" | "md"; title: string; content: string }): { id: string; version: number }
```

Typical cold use: two scripts (discover, work). Listed tools: one.

### MCP

Before (p2):

```text
## mcp__radius
Tools of the MCP server "radius" (find them with searchTools()). It needs the user's sign-in: if it has no tools, ask
the user to sign in from the MCP panel in p2's sidebar or at /mcp/sign-in/radius on p2.
```

Before (coding agent):

```text
MCP servers whose tools are not declared to you. Call the tools of `codemode` servers from codemode scripts.
- mcp__github (codemode): GitHub issues, pull requests and repositories
- mcp__linear (tool_search): Linear issues and projects
```

After (both):

```text
## mcp__radius: MCP server "radius": organization artifacts and knowledge. Needs the user's sign-in (MCP panel). Tools: listTools("mcp__radius").
## mcp__github: MCP server "github": issues, pull requests, repositories. Tools: listTools("mcp__github").
```

- card from configuration only (name, configured description, static sign-in hint); tools stay deferred, never named in the prompt;
- tool keys are `tools.mcp__<server>__<tool>`, exactly as `listTools` prints them; the preamble says names are exactly as listed;
- `listTools("mcp__radius")` first line: `not connected: needs sign-in (MCP panel)` | `connected, no tools` | `connected, 47 tools`, then the lines; never an empty result;
- `searchTools` returns matching disconnected servers in `disconnected`;
- `describeTool` on a disconnected server's tool returns the not-connected line, not "unknown tool";
- coding agent: `mcp_servers` folds into these cards for code-mode servers; `tool_search` for sessions without code mode stays.

## What seven models said

Same brief (current design + this proposal or its first draft) to each, answering as the model that uses it. Raw
answers: `/tmp/tools-design-*.md` (first four), `/tmp/tools-review-radius-*.md` (Radius models), on slayer.

| | GPT-6 Astra | GPT-6.1 Sol | Gemini Pro | Opus 5.5 | Kimi K3 | GLM 5.3 | DeepSeek V4.1 Flash |
| --- | --- | --- | --- | --- | --- | --- | --- |
| silent truncation is the worst failure | yes | yes | yes | yes | yes | yes | yes |
| one line with full types for every listed tool | no: pinned contracts + name/purpose | no: pinned contracts + name/purpose | yes | yes | yes | yes | yes |
| discovery returns contracts, not names | yes | yes | yes | yes | yes | yes | yes |
| author-declared priority instead of round-robin | yes | yes | yes | yes | yes | yes | yes |
| never elide result types | yes | yes | yes | yes | yes | yes | yes |
| namespace instructions in the prompt / with every contract | with contracts | with contracts | short, inline | with contracts | on the card | with search | on the card |
| errors carry the right signature | — | nearest matches | yes | yes | yes, incl. constraints | yes, incl. constraints | yes |
| freeze section per conversation, changes as a note | — | — | — | yes | yes | yes | yes |
| disconnected MCP servers visible to search | yes | yes | yes | yes | yes | yes | yes |
| TypeScript over JSON Schema | yes | yes | yes (3–4× fewer tokens) | yes (3–5×) | yes (3–5×) | yes | yes |

Points taken into the proposal from the Radius round: results never elided (all three), instructions on the card
(Kimi, DeepSeek), short field docs inline for units and bases (Kimi, GLM), constraint violations carry the fix (Kimi,
GLM), plain-object `searchTools` result with `disconnected` (all three), `listTools` replaces `describeNamespace` (GLM),
explicit MCP tool keys (Kimi), three MCP states (DeepSeek).

Sol and Astra's objection to one-liners: a shortened line looks like a complete contract while hiding constraints.
The other five answer it with an asymmetry: a hidden constraint fails loudly and one retry fixes it (if the error
carries the constraint); a missing signature fails silently or costs a round trip.

## Open

- **Freeze the section per conversation** and announce reloads as `[tools changed] added: …; removed: …` (five of
  seven for; GLM: at the start of the next user message). Today a plugin reload changes the section.
- **Budget**: keep 3,000 fixed (GLM) or pick it per model at conversation start (DeepSeek, Kimi: 3,000 below 100k
  context, 6,000 above).
- **`summary`**: optional with first-sentence default (GLM), or required for namespaces over ~4 tools and linted to
  differ from siblings (DeepSeek).
- **Coding agent**: same change, `mcp_servers` folded into cards.

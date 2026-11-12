---
title: Code mode with many tools
cover: Code Mode / Many Tools
kicker: A design proposal · for Armin · 2026-11-12
subtitle: What the model sees of the tools it can script, why it breaks past a few dozen tools, and what we want instead
stats:
  - 3,000 | tokens for every declaration today
  - ~150–300 | tokens per tool, as declared now
  - ~25 | tokens per tool, as proposed
  - 4 | models from 3 families asked
note: |
  Based on `packages/durable/src/codemode/{describe,codemode}.ts` at `origin/main` (after 5e24c6b1f, namespaces
  declared by extensions), `packages/coding-agent/src/extensions/{codemode,mcp,tool-search}/`, the prompt of a p2
  session after the artifacts deploy, and answers from GPT-6 Astra, GPT-6.1 Sol, Gemini Pro and Claude Opus 5.5 to
  the same brief. Nothing in the suggested state is built. Mario and I want your read on it before we build it in
  Durable, and then in the coding agent, which has the same design.
colophon: Code mode with many tools · first edition · 2026-11-12 · Durable and coding agent at origin/main
---

# Before we begin {.preface}

Last night p2 gained an artifacts plugin with twelve tools, all callable only from code mode, grouped in a namespace
called `artifact`. The first thing the agent tried was to write an artifact. The prompt listed nine of the twelve
tools with full declarations; `artifact_write`, the tool that creates an artifact, was not among them, and nothing said
anything was missing. The agent found it only because it suspected a gap and called `ALL_TOOLS`. A model that trusts
the list would have concluded that artifacts cannot be created and written an HTML file with `bash` instead.

This is not a bug in one plugin. Code mode lists tools under a fixed budget of 3,000 estimated tokens, each tool as a
full TypeScript declaration with a doc comment per field. That fits about twenty tools. Past that, whatever loses the
budget round disappears silently. p2 sessions now have about sixty callable tools; with a few MCP servers, hundreds.

## Seven things to know

:::findings
1. **The listing is a prompt section, not the tool description.** The code mode tool's description is fixed; the
   `codemode` section lists callable tools and changes only when tools are added or removed.
2. **Each tool costs 150–300 tokens there.** Full declarations with per-field comments and schema constraints.
3. **What does not fit vanishes without a trace.** Inside a namespace there is no hint; ungrouped tools get one
   generic line.
4. **Discovery returns text, not contracts.** `searchTools` returns descriptions and `describeNamespace` returns
   names, so finding a tool usually costs a second round trip before the real script.
5. **Round trips cost more than tokens.** A cached prompt token costs about a tenth of an uncached one; a round trip
   costs a model turn. All four models we asked said so first.
6. **Proposal: one line per tool, full types, no comments.** About 25 tokens a tool, so a hundred tools fit; field
   docs on demand; an explicit "+N more" when anything is left out; key tools first.
7. **MCP stays cache-stable.** A server is a namespace card built from configuration, identical whether connected
   or not; its tools are found through discovery calls that return signatures.
:::

## Words used throughout

**Code mode** is the tool through which the model runs a JavaScript script that calls other tools as `await
tools.<name>(args)`. A **callable tool** is one scripts may call (`callers` includes `"tools"`). The **codemode
section** is the system prompt section listing callable tools. A **namespace** groups tools: since 5e24c6b1f an
extension declares `namespace: { name, description, instructions? }` and its tools belong to it. A **deferred** tool is
callable but never listed, only found by search (MCP tools, which appear when a server connects). The **budget** is
`inlineBudget`, 3,000 estimated tokens (characters / 4) for the listed declarations. A **round trip** is one model turn
spent on a script whose only purpose is to learn something before the real script.

# What the model sees now {#current lede="The codemode section today, verbatim, and the rules that build it."}

The model sees two things about code mode. The code mode tool's description is fixed for every conversation: the
sandbox, the globals, the discovery functions. The codemode section, rendered by `codemodeSection` in
`packages/durable/src/codemode/describe.ts`, lists the callable tools. The coding agent has the same design in
`packages/coding-agent/src/extensions/codemode/tool.ts`, with the same default budget and the same round-robin.

## One tool, as listed

Every listed tool is its description followed by its full declaration, with a comment per field and the schema's
constraints as JSDoc tags:

```text
### `artifact_list`
The session's artifacts (id, kind, title, newest version, updated), the newest first.

codemode tool declaration:
```

```ts
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

That is about 130 tokens for a small tool. `bash` with its result type is about 200; `view_list`, whose result
carries annotations, is over 300.

## The whole section, as a p2 session sees it

Abridged only where marked; this is the section of the session that wrote this book:

```text
Tools scripts can call (`await tools.<name>(args)`):

Some tools are not listed: find them with `searchTools()`.

### `agent`        … full declaration …
### `read`         … full declaration …
### `write`        … full declaration …
### `bash`         … full declaration …
### `reload_plugins`, `history_search`, `location_envs`, `location_dirs`, `location_move`, `send_file`  … each in full …
    (edit, history_read, ports, rename_session and others: not listed)

## artifact
Artifacts (html, md) of this session: write, edit, show inline or beside the chat.

### `artifact_list`, `artifact_read`, `artifact_show`, `artifact_open`, `artifact_delete`,
    `artifact_html_errors`, `artifact_html_eval`, `artifact_html_state`, `artifact_html_set_state`  … each in full …
    (artifact_write, artifact_edit, artifact_html_logs: not listed, no hint)

## mcp__radius
Tools of the MCP server "radius" (find them with searchTools()). It needs the user's sign-in: if it has no tools, ask
the user to sign in from the MCP panel in p2's sidebar or at /mcp/sign-in/radius on p2.

## view
Views: panes beside the transcript every viewer of the session sees …: list, open, close, arrange, resolve annotations.

### `view_list`, `view_open`, `view_close`, `view_arrange`, `view_resolve`  … each in full …
```

## How the budget is spent

`selectCatalog` groups tools: ungrouped tools first, then namespaces by name. In each round every group places its
cheapest remaining tool; a group whose next tool does not fit drops out while the others go on. Headings and
namespace descriptions are outside the budget. Deferred tools are left out entirely.

The round-robin is fair between groups and blind to importance. `artifact_write` takes more tokens than
`artifact_show`, so it comes late in its group's queue, and the budget ran out first.

## Discovery today

Scripts have four globals for what the section does not list:

```ts
ALL_TOOLS: { name: string; ... }[]                       // every callable tool
searchTools(query, { limit?, namespace? }): { name, description }[]   // BM25; description = description + declaration
describeTool(name): string                               // description + declaration
describeNamespace(name): { name, description?, instructions?, tools: string[] }   // names only
```

`searchTools` does return declarations inside its text, so search is one round trip. `describeNamespace` returns
names, so browsing a namespace is two: names, then `describeTool` per tool.

## MCP today

In p2 each MCP server is an extension whose namespace is the server (`mcp__radius`); its tools are deferred, so its
heading and description are listed and none of its tools. The description says how to reach them and carries the
sign-in hint. The coding agent instead has a separate `mcp_servers` section listing every configured server with its
reach (`codemode` or `tool_search`) and a one-line summary from its configured description or the server's
`instructions` once connected; without code mode, `tool_search` loads matching tools into the model's tool list for
the next call.

Both keep the prompt byte-stable when a server connects: what is listed comes from configuration, never from what is
connected. That property is worth keeping in any change.

# Where it breaks {#problems lede="Five failures, each seen in practice or named by every model we asked."}

All four models we asked put the same failure first, and it is the one we hit.

## A cut list looks complete

When a namespace shows nine tools in full detail, the model reads them as the namespace's API. It does not suspect a
tenth. The generic line "Some tools are not listed" appears only for ungrouped tools, at the top, far from the
namespace. Gemini's trace of the same case: it would conclude the nine are complete, skip search, and try to make
`artifact_edit` create an artifact. Opus: "When a list is cut without saying so, I am wrong with full confidence.
That is worse than having no list at all."

## Twenty tools is not many

At 150–300 tokens a tool, 3,000 tokens list about twenty. A p2 session has about sixty callable tools before MCP. The
comments that fill each declaration (`// Path to the file to read (relative or absolute)`, `// @minLength 1`) are
what makes the budget small, and the model needs few of them to call a tool correctly: names, optionality, literal
unions and the result shape carry almost all of it.

## Importance is invisible

The round-robin cannot know that `artifact_write` matters more than `artifact_html_set_state`. Nothing in a
namespace's declaration says which tools are the core.

## Discovery costs round trips

Every discovery call that returns names forces another script before the work. `describeNamespace` returns names;
`describeTool` takes one name at a time. A model that needs three tools from a namespace spends two round trips before
the one that does the job. All four models put round trips above tokens: a cached prompt token costs about a tenth of
an uncached one and adds no latency; a round trip costs a full model turn.

## Instructions are easy to miss

A namespace's `instructions` (the how-to: write before show, check errors after each edit) come only from
`describeNamespace`. A model that finds a tool by search never sees them.

# What other models want {#survey lede="Four models from three families, one brief, mostly the same answer."}

We gave GPT-6 Astra, GPT-6.1 Sol, Gemini Pro and Claude Opus 5.5 the current design and two proposals (one line per
tool; or namespaces only, then a call to list a namespace's tool names) and asked for the ideal design at 10, 100,
1,000 and 10,000 tools, from the side of the model that uses it. The full answers are in
`/tmp/tools-design-*.md` on slayer.

## Where all four agree

- **Never truncate silently.** Every list says whether it is complete; anything left out ends with "+N more" and the
  call that lists it.
- **Discovery returns contracts, not names.** A names-only step is dead weight: names do not separate similar tools,
  so a describe round trip follows anyway. The list call should return signature lines.
- **Priority, not round-robin.** The author declares the core tools of a namespace; they are always listed. Core tools
  and the session's own namespaces get a reserved share that MCP servers cannot eat.
- **Result types matter as much as arguments.** Chaining calls in one script depends on `r.id` versus
  `r.artifact.id`.
- **The prompt is a function of configuration only.** No connection state, no live counts, no usage-based ordering.
- **TypeScript, not JSON Schema.** `title?: string` puts optionality on the field; literal unions are written out.

## Good ideas from one or two

- **Errors as discovery** (Opus, Gemini): an unknown tool or field throws with the nearest correct signatures, so a
  wrong guess costs one retry with the fix in hand.
- **Namespace instructions travel with every contract** (Sol, Astra, Gemini): search and describe include the
  instructions of each namespace they return tools from.
- **Batched discovery** (all but Gemini, which wants it too in another form): `describeTool(["a", "b"])`,
  `searchTools(["send mail", "gmail draft"])`.
- **Shared types once per namespace** (Gemini): `type Artifact = {…}` once, instead of the same object in every line.
- **Do not advertise `ALL_TOOLS`** (Sol, Astra, Gemini): it invites substring filtering instead of search.

## Where they disagree

Opus and Gemini want one-line signatures for every listed tool. Sol and Astra warn that a shortened signature looks
like a complete contract while hiding constraints; they would list complete contracts for a few pinned tools and only
name and purpose for the rest. Our proposal keeps full types on the line and drops only comments and constraints,
which answers most of the warning; the rest is an open question below.

# The suggested section {#suggested lede="One line per tool with full types, tiers instead of silence, discovery that returns signatures."}

The section keeps its place and role. What changes is what each tool costs, what happens when the budget runs out, and
what discovery returns.

## One tool, as proposed

```text
artifact_list(args: { kind?: "html" | "md" }): { artifacts: Artifact[] }  // The session's artifacts, newest first.
```

Rendered from the schema: parameter names, `?` for optional, literal unions, nested objects and the result type in
full (shared types hoisted, below); then the tool's `summary`, or the first sentence of its description. Field
comments and constraints (`@pattern`, `@maxLength`) are left out; `describeTool` has them. Depth past one nested
level, or a union of more than six members, renders as `{…}` with the full form in `describeTool`, so one tool cannot
eat the budget.

## The whole section, as proposed

The same session, same tools:

```text
Scripts call `await tools.<name>(args)` and return a value. Signatures are TypeScript; `?` marks an optional field.
A list is complete unless it ends in "+N more". A wrong tool name or field throws with the right signature.
Discovery: listTools(ns) → signature lines · searchTools(query | queries, { namespace?, limit? }) → signature lines
and namespace instructions · describeTool(name | names) → full declarations with field docs.

agent(args: { prompt: string; schema: object; model?: string; thinkingLevel?: string; tools?: string[]; label?: string }): unknown  // One-shot subagent; its answer is validated against schema.
read(args: { path: string; offset?: number; limit?: number }): string | Image  // Read a file (2,000 lines / 50 KB).
write(args: { path: string; content: string }): string  // Create or overwrite a file.
edit(args: { path: string; edits: { oldText: string; newText: string }[] }): string  // Exact replacements in a file.
bash(args: { command: string; timeout?: number }): { exitCode: number; output: string; truncated: boolean; fullOutputPath?: string }  // Run a shell command.
history_search(args: { query: string; before?: number; limit?: number }): string  // Search this conversation's history.
+6 more: history_read, reload_plugins, location_envs, location_dirs, location_move, send_file (describeTool(name))

## artifact: Artifacts (html, md) of this session: write, edit, show inline or beside the chat.
type Artifact = { id: string; kind: "html" | "md"; title: string; version: number; updated: number }
artifact_write(args: { id?: string; kind: "html" | "md"; title: string; content: string }): { id: string; version: number }  // New artifact, or a new version of id.
artifact_edit(args: { id: string; edits: { old: string; new: string }[] }): { version: number }  // Exact replacements in the newest version.
artifact_read(args: { id: string; version?: number }): Artifact & { content: string }
artifact_list(args: { kind?: "html" | "md" }): { artifacts: Artifact[] }  // Newest first.
artifact_show(args: { id: string }): { id: string; kind: string }  // In the transcript, for everyone.
artifact_open(args: { id: string }): { view: string }  // Beside the chat.
+6 more: artifact_delete, artifact_html_errors, artifact_html_logs, artifact_html_eval, artifact_html_state, artifact_html_set_state (listTools("artifact"))

## view: Panes beside the transcript: list, open, close, arrange, resolve annotations.
view_open(args: { kind: string; item?: string; title?: string; id?: string }): { id: string }  // markdown (item: a file), changes, or a plugin's kind.
view_list(args: {}): { views: { id: string; kind: string; item?: string; title: string }[]; selections: {…}[]; annotations: {…}[] }
+3 more: view_close, view_arrange, view_resolve (listTools("view"))

## mcp__radius: MCP server "radius": organization artifacts and knowledge. Tools: listTools("mcp__radius").
```

The "+N more" lines here are only for illustration: at about 25 tokens a line, every one of these sixty tools fits in
3,000 tokens with room to spare. They appear when the budget is genuinely exceeded.

## Tiers instead of silence

When tools do not fit, each group degrades in three steps:

1. **Signature lines** for as many tools as fit, the group's key tools first.
2. **Names** for the rest: `+6 more: a, b, c (listTools("artifact"))`. A name costs two to five tokens and tells the
   model the tool exists.
3. **A count** when even the names do not fit: `+40 more (listTools("mcp__github"))`.

Headings and descriptions of every namespace are placed first, outside the budget. The counts and names come from
the declared tools, so they change only when tools are added or removed by configuration or a reload, as today.

## Priority

A namespace declares its key tools; tools may declare a short `summary` that separates them from their siblings:

```ts
// packages/durable/src/harness/types.ts (proposed additions)
export type ToolNamespace = {
	readonly name: string;
	readonly description: string;
	readonly instructions?: string;
	/** The namespace's core tools, listed first and always with their signature while the namespace is shown. */
	readonly primary?: readonly string[];
};

// on a tool registration
readonly summary?: string;   // one clause that tells it apart from its siblings; default: first sentence of description
```

The budget is spent in this order: the ungrouped tools (the core: `read`, `edit`, `bash`), then every namespace's
primary tools, then the rest in proportion to each namespace's size instead of one tool per round.

## Shared types

A namespace whose tools pass the same object around gets it once as a `type` line under its heading, rendered from
schemas that are equal (`artifact_read` and `artifact_list` both return the artifact summary). This halves the
artifact namespace's lines and tells the model which results feed which arguments.

## Discovery that returns signatures

```ts
listTools(ns: string): string
  // every tool of ns as signature lines, primary first, with the namespace's types; the same format as the prompt
searchTools(query: string | string[], options?: { namespace?: string; limit?: number }):
  { name: string; namespace: string | null; line: string }[] & { instructions: Record<string, string> }
  // BM25 over names, summaries, descriptions, parameter names and namespace descriptions; several queries merged;
  // the instructions of every namespace a result comes from
describeTool(name: string | string[]): string
  // full declarations with field comments, constraints and the namespace's instructions; several at once
describeNamespace(ns: string): { description: string; instructions: string; lines: string }
  // instructions plus every signature line
```

A typical cold use is then two scripts, never three: one that searches or lists and returns signatures, and the one
that does the work. When the model already knows the namespace, it can list and work in one script, since the
signatures arrive as data it can read in the next turn anyway.

`ALL_TOOLS` stays available but is no longer advertised in the tool description.

## Errors that carry the fix

```text
Unknown tool artifact_create. Did you mean:
  artifact_write(args: { id?: string; kind: "html" | "md"; title: string; content: string }): { id: string; version: number }
artifact_write: unknown field "text"; expected
  artifact_write(args: { id?: string; kind: "html" | "md"; title: string; content: string }): { id: string; version: number }
```

The script's error already reaches the model; adding the nearest signatures turns a failed guess into a retry with
the answer attached.

# MCP, before and after {#mcp lede="Servers stay cards built from configuration; their tools come through discovery."}

The cache rule decides this chapter: nothing that depends on whether a server is connected may enter the prompt.

## Before, in p2

```text
## mcp__radius
Tools of the MCP server "radius" (find them with searchTools()). It needs the user's sign-in: if it has no tools, ask
the user to sign in from the MCP panel in p2's sidebar or at /mcp/sign-in/radius on p2.
```

Its tools are deferred: never listed, found only by `searchTools`, which returns descriptions with declarations
inside.

## Before, in the coding agent

```text
MCP servers whose tools are not declared to you. Call the tools of `codemode` servers from codemode scripts.
- mcp__github (codemode): GitHub issues, pull requests and repositories
- mcp__linear (tool_search): Linear issues and projects
```

Plus the `tool_search` tool for servers not reached through code mode, which loads matching tools into the model's
tool list for the next call.

## After

```text
## mcp__radius: MCP server "radius": organization artifacts and knowledge. Needs the user's sign-in (MCP panel). Tools: listTools("mcp__radius").
## mcp__github: MCP server "github": issues, pull requests, repositories. Tools: listTools("mcp__github").
```

- **The card is built from configuration**: the server's name, its configured description (or the first line of its
  `instructions`, once known and then fixed for the configuration), and a static sign-in hint when the server uses
  OAuth. It is byte-identical whether the server is connected or not.
- **Its tools stay deferred**: never in the prompt, not even by name, since their names arrive with the connection.
- **`listTools("mcp__radius")`** returns the server's signature lines when connected, and `not connected: sign in from
  the MCP panel` when not, never an empty list that reads as "no tools".
- **`searchTools`** covers connected servers' tools and returns their signature lines, with the server's instructions.
- **The coding agent's `mcp_servers` section** becomes these cards in the codemode section. `tool_search` for
  sessions without code mode stays as it is.

# Open Questions {.epilogue lede="What we would like your view on before building it."}

The proposal changes one renderer and the discovery globals in Durable, adds `primary` and `summary` to the
declarations, and then needs the same change in the coding agent, whose code mode has the same design. It does not
change how scripts run.

## Needs a decision

- **One-line signatures for every listed tool, or complete contracts for a few pinned tools and name plus purpose for
  the rest?** Opus and Gemini want the first, Sol and Astra the second. We lean to the first with full types on the
  line; the risk is a constraint the line hides (a slug pattern, 1-based indices). A middle way: keep field comments
  under about 40 characters inline.
- **Freeze the section per conversation?** Opus suggests rendering it once and announcing later tool changes as a
  transcript note (`[tools changed] added: …`), so a plugin reload mid-conversation never breaks the prefix cache.
  Today a reload changes the section.
- **Errors with signatures**: in Durable's nested-call path for unknown tools, and in schema validation for unknown
  fields. Both are trust-boundary checks that exist; only the message changes.
- **The budget**: keep 3,000 with the cheaper lines, or make it proportional to the model's context.
- **Same change in the coding agent**, with its `mcp_servers` section folded into the cards, or keep that section
  there.

# Reference {.appendix}

## Files

| What | Where |
| --- | --- |
| Section renderer, budget, round-robin | `packages/durable/src/codemode/describe.ts` (`codemodeSection`, `selectCatalog`) |
| Discovery globals | `packages/durable/src/codemode/codemode.ts` (`searchTools`, `describeTool`, `describeNamespace`) |
| Namespaces by extension | `packages/durable/src/harness/types.ts` (`Extension.namespace`, `ToolNamespace`), 5e24c6b1f |
| p2's MCP extensions | `apps/p2/plugins/mcp/tools.ts` |
| Coding agent's code mode | `packages/coding-agent/src/extensions/codemode/tool.ts` |
| Coding agent's MCP and tool search | `packages/coding-agent/src/extensions/mcp/index.ts`, `extensions/tool-search/tool.ts` |
| The four models' answers | `/tmp/tools-design-*.md` on slayer |

## Glossary

- **Budget**: `inlineBudget`, estimated tokens (characters / 4) for listed tools; default 3,000.
- **Callable tool**: a tool scripts may call (`callers` includes `"tools"`).
- **Card**: a namespace's heading line with its description, always listed.
- **Deferred tool**: callable, never listed; found by discovery.
- **Primary tools**: a namespace's declared core tools, always listed with signatures (proposed).
- **Round trip**: a model turn spent only to learn something before the real script.
- **Signature line**: one tool as `name(args: {…}): Result  // summary`.

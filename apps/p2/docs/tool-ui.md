# A tool's UI: how a plugin shows its tool

For plugin authors. A plugin that gives the agent a tool also decides how the tool's calls look, in the web chat
and in the TUI. p2's core knows no tool by name: everything here is a registration of the plugin that owns the tool,
keyed by the tool's name. A tool without any registration still shows, with the generic look described below.

Paths are relative to `apps/p2`. Plugins import p2 only through `@p2/app/v1` and its per-kind modules
(`/worker`, `/web`, `/tui`); see `docs/handoff.md` and Chord's plugin guide (`packages/chord/docs/
plugin-authoring.md`) for plugins in general, `.pi/skills/p2-ui.md` for p2's UI rules.

## The parts

| Facet | File | Registers | Says |
| --- | --- | --- | --- |
| worker | `tool.ts`, `worker.ts` | the tool in `Extensions` | what the model sees and what a call does |
| web | `activity.tsx`, `web.tsx` | a `ToolActivity` in `ToolActivities` | how a call looks in the chat |
| TUI | `tui.ts` | `ToolRenderers` in `TuiToolRenderers` | how a call looks in the terminal |

The tool definition carries no display fields: no label, icon, verb or renderer. What a call looks like is decided
from three things only: the call's arguments, its result's text, and its result's `details` (see
[Details](#details-what-the-ui-reads)).

## The example: `word_count`

A complete plugin, `plugins/word-count/`: a tool that counts the words and lines of a text. Its files are below as
they are in `test/fixtures/plugins/word-count/`, which `test/p2/tool-ui-example.test.ts` checks (this document shows
them verbatim), runs and renders: the tool counts, the wheel's summary reads "Counted words in 2 texts", the step
list shows each call's text and state (✗ "empty text" for the failed one), a step opens the tool's own detail, and
the TUI draws its card.

A plugin is a directory with a `package.json` and its facet files; p2 finds it by listing `plugins/*`, there is no
manifest.

```json plugins/word-count/package.json
{
	"name": "word-count",
	"private": true,
	"type": "module"
}
```

### The tool (worker)

`tool.ts` defines the tool with Durable's `defineTool`: `name`, `description` and `parameters` (a JSON Schema built
with `@earendil-works/pi-schema`) are what the model sees; `execute` does the work. Its result has `output` (the text
the model reads, and the chat's output block) and `details` (JSON for the UI, see below). A thrown error becomes a
failed call whose output is the error's message.

```ts plugins/word-count/tool.ts
// The `word_count` tool: what the model sees (name, description, parameters) and what it does. Nothing here says how
// a call looks: that is the web and TUI facets' business.
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";

/** What a call's result keeps for the UI, beside the text the model reads: the counts. */
export type WordCountDetails = { words: number; lines: number };

export function countWords(text: string): WordCountDetails {
	return { words: text.split(/\s+/).filter(Boolean).length, lines: text.split("\n").length };
}

export const wordCountExtension = defineExtension({
	name: "p2-word-count",
	tools: [
		defineTool({
			name: "word_count",
			description: "Count the words and lines of a text.",
			parameters: obj({ text: str() }),
			replay: "safe",
			execute: async (args) => {
				if (!args.text.trim()) throw new Error("Nothing to count: the text is empty.");
				const details = countWords(args.text);
				return {
					output: [{ type: "text", text: `${details.words} words, ${details.lines} lines` }],
					details,
				};
			},
		}),
	],
});
```

`worker.ts` offers it: the session worker's `Extensions` registry, keyed by the extension's name.

```ts plugins/word-count/worker.ts
// The worker facet: offers the tool to every conversation of the session.
import { contribute, defineFacet } from "@p2/app/v1";
import { Extensions } from "@p2/app/v1/worker";
import { wordCountExtension } from "./tool.ts";

export default defineFacet((host) => {
	contribute(host, "p2.word-count-tool", (self) => {
		self.contribute(Extensions, { [wordCountExtension.name]: wordCountExtension });
	});
});
```

### The chat (web)

`activity.tsx` describes the tool's calls; `web.tsx` contributes that to `ToolActivities` under the tool's name. One
contribution may cover several tools (`plugins/coding-tools/activity.tsx`: bash, read, write, edit).

```tsx plugins/word-count/activity.tsx
// How `word_count` calls show in the chat: on the wheel, in a run's summary, in the step list and in the detail.
import {
	DetailNote,
	DetailProse,
	detailsOf,
	failureOf,
	firstLine,
	InputOutput,
	Interrupted,
	type Step,
	stringOf,
	type ToolActivity,
	type ToolView,
} from "@p2/app/v1/web";

/** The counts a finished call's result keeps (`details`), if it has them. */
function counts(tool: ToolView): string | undefined {
	const { words, lines } = detailsOf(tool);
	return typeof words === "number" && typeof lines === "number" ? `${words} words, ${lines} lines` : undefined;
}

/** The text's first line, short: what a call is about. */
const excerpt = (tool: ToolView) => firstLine(stringOf(tool.args.text)).slice(0, 40);

function WordCountDetail({ step }: { step: Step }) {
	return (
		<>
			<InputOutput
				input={<DetailProse text={stringOf(step.tool.args.text)} />}
				output={<DetailNote testId="word-count">{failureOf(step) ?? counts(step.tool) ?? "Counting…"}</DetailNote>}
			/>
			<Interrupted step={step} />
		</>
	);
}

export const wordCountActivity: ToolActivity = {
	describe: (step) => ({
		label: { kind: "read", verb: "Counted words in", object: excerpt(step.tool), style: "words" },
		description: failureOf(step) ?? counts(step.tool),
	}),
	running: (step) => ({ kind: "read", verb: "Counting words in", object: excerpt(step.tool), style: "words" }),
	argument: excerpt,
	failure: (tool) => (tool.output.startsWith("Nothing to count") ? "empty text" : undefined),
	summary: (count) => (count === 1 ? "counted words in a text" : `counted words in ${count} texts`),
	Detail: WordCountDetail,
};
```

```tsx plugins/word-count/web.tsx
// The web facet: contributes the tool's look, keyed by its name.
import { contribute, defineFacet } from "@p2/app/v1";
import { ToolActivities } from "@p2/app/v1/web";
import { wordCountActivity } from "./activity.tsx";

export default defineFacet((host) => {
	contribute(host, "p2.web-word-count", (self) => {
		self.contribute(ToolActivities, { word_count: wordCountActivity });
	});
});
```

#### Where a call shows up

- **The wheel** (the activity row): one row per run of consecutive calls. While the agent works it faces the newest
  call in the present tense (`running`, else `describe`'s label); when the run ends it rolls to a summary built from
  each tool's `summary` phrase, counted ("Counted words in 2 texts"; a failed call is red on the wheel, and the
  activity list says how it failed). While active, the latest thought appears above a non-thinking step, clamped
  to three lines; it is not repeated when thinking is the current step.
- **The step list** (a tap on the wheel opens that block's right-hand panel, or a sheet on phones): one row per
  call with the tool's name, its `argument`, and its state (✓ and its time; ✗ and the `failure` word; ● running).
  The panel has no tab or conversation-wide list: select another block in the transcript to switch it.
- **The detail** (a step expands it inline): the body is the tool's `Detail`. Several steps can remain expanded;
  expanding one does not navigate away from the list or add a history entry. Back closes the panel.
- **Results**: what `hasResult` places, drawn by `Result`, after the turn's answer or in place.
- **A script's calls**: when another tool calls this one (a code mode script), its entry in the caller's timeline
  uses `describe`, its detail `CallInput` and `CallDetail`.

#### `ToolActivity`, field by field

Every field is optional (`src/web/activity/model.ts`); each one left out falls back as the last column says.

| Field | Gets | Returns | When you need it | Without it |
| --- | --- | --- | --- | --- |
| `describe` | the `Step` (`step.tool`: name, args, status, output, details, calls, durationMs; `step.status`) | `{ label, description?, mono? }` | always, for words that read like an action | the tool's name and its first short string argument, the generic icon, monospace |
| `running` | the `Step` | a `Label` in the present tense | calls that take a while (the wheel shows it while it runs) | `describe`'s label |
| `argument` | the `ToolView`, the session's cwd | the row's main argument | the first string argument is not the telling one, or paths should be relative | the first short string argument |
| `failure` | the `ToolView` of a failed call | a short word ("exit 1"), or undefined | a tool whose failures have a short name | "failed" |
| `summary` | how many of this tool's calls a run had | the phrase, singular and plural ("ran a command", "ran 3 commands") | always: it is the wheel's summary | "used `name`", "used `name` N times"; tools sharing one function count together (write and edit: "edited 2 files") |
| `hasResult` | the `ToolView` | `"after"`, `"inline"` or `false` | the call made something for the person (a file, a link, an artifact) | nothing shown besides the call |
| `Result` | `{ tool, inline }` | a component | with `hasResult` | — |
| `Detail` | `{ step }` | a component | the generic detail does not say enough (a diff, a terminal, a link) | Input: the arguments as JSON; Output: the output (and images) |
| `nestedCalls` | the `ToolView` | the calls this call made (`NestedCall[]`) | the tool runs other tools and keeps their final list in its `details` (code mode) | `tool.calls`: Durable's live nested slots, then the last list seen |
| `repeated` | a count of identical calls in a row, how many failed | the entry's description ("20 runs, 1 failed") | a tool with nested calls | the repeated tool's own summary ("Ran 20 commands · 1 failed") |
| `CallInput` | `{ call: NestedCall }` | a component | other tools call this one and its input reads better than JSON (a command line) | the arguments as JSON |
| `CallDetail` | `{ call: NestedCall }` | a component below a script's call's input and output | a script's call of this tool made something to open (`plugins/agent`: its conversation) | nothing |

A `Label` is `{ kind, verb?, object?, style?, extra? }`: `kind` picks the icon from the activity's vocabulary
(`command`, `search`, `read`, `edit`, `script`, `agent`, `artifact`, `file`, `port`, `message`, `handoff`, `tool`);
`verb` and `object` are the words ("Counted words in" + the text); `style` sets the object as a file name, code or
the agent's words; `extra` follows after a dot ("Ran a script · 3 calls"). `description` is the step's second line
(a result, why it failed). Helpers for writing them come with the type from `@p2/app/v1/web`: `stringOf`,
`detailsOf`, `failureOf` (a failed call's first output line), `firstLine`, `lastLine`, `fileName`, `plainText`,
`sentence`, `parsedArgs`, `relativePath`.

A `Detail` is built from the detail parts (`src/web/activity/Detail.tsx`): `InputOutput` (the two labelled
sections), `DetailSection`, `CommandBlock`, `OutputBlock`, `CodeBlock`, `DiffBlock`, `LinesBlock`, `FilePath`,
`DetailImages`, `DetailProse`, `DetailNote`, `DetailLink`, `Interrupted` (a call a restart cut short), and
`NestedCalls` (a call's own calls as a timeline: the newest eight, the rest behind "Show all N tool calls";
each call expands its own detail inline). A detail shows everything at once and follows a running call live.

#### Results: after the answer or in place

`hasResult(tool)` says whether a call made something for the person, and where `Result` shows it:

- `"after"`: after the turn's answer, with the turn's other results (`plugins/send-file`: the sent file's card;
  `plugins/ports`: the opened port's links; `plugins/artifacts`: a version's card).
- `"inline"`: in place, right after the call's wheel; the run of calls splits around it, so the calls after it get a
  wheel of their own (`plugins/artifacts` for an artifact made with `inline: true`: its card and the artifact
  itself).

Decide from the finished call (`tool.status === "done"` and the `details` it needs): a running call has no result
yet, and the run splits only once the result is there.

How much of a turn the chat shows is the owner's settings.json `detail` (1 to 4, default 2); a result in place
follows it:

- **2** (the default) and **3**: right after the wheel with its call; the calls after it, and at 2 the thinking
  after it, go on the next wheel, which is the row that waited there while the agent worked.
- **4** (no wheels, each call its own row): right after its call's row.
- **1** (one wheel per turn, only the answer and its results in the transcript): with the results after the answer,
  still drawn in full (an inline artifact shows itself there); the turn's wheel is not split.

#### Calls of other tools

A tool that runs other tools (code mode's scripts) gets their calls as `tool.calls`, from Durable's live nested
slots while it runs (with depth, status, running output). If the tool keeps a final list in its result's `details`,
`nestedCalls` reads it once settled; `plugins/codemode/nested.ts` does that for `details.calls` and renames code
mode's internal tools to their script names. Its `Detail` shows them with `NestedCalls`; `repeated` words a group
of identical calls in a row.

### The terminal (TUI)

`tui.ts` registers pi's renderer contract for the tool in `TuiToolRenderers` (`src/tui/tools/types.ts`), keyed by
the tool's name.

```ts plugins/word-count/tui.ts
// The TUI facet: the tool's card in the terminal transcript.
import { Text } from "@earendil-works/pi-tui";
import { contribute, defineFacet } from "@p2/app/v1";
import { getTextOutput, lineText, record, str, type ToolRenderers, TuiToolRenderers } from "@p2/app/v1/tui";

export const wordCountRenderers: ToolRenderers = {
	renderCall: (args, theme) =>
		new Text(
			`${theme.fg("toolTitle", theme.bold("word_count"))} ${theme.fg("muted", lineText(str(args.text) ?? ""))}`,
			0,
			0,
		),
	renderResult: (result, _options, theme, context) => {
		const details = record(result.details);
		const counts =
			typeof details?.words === "number" ? `${details.words} words, ${details.lines} lines` : getTextOutput(result);
		return new Text(theme.fg(context.isError ? "error" : "toolOutput", counts), 0, 0);
	},
};

export default defineFacet((host) => {
	contribute(host, "p2.tui-word-count", (self) => {
		self.contribute(TuiToolRenderers, { word_count: wordCountRenderers });
	});
});
```

| Field | Gets | Draws | Without it |
| --- | --- | --- | --- |
| `renderCall` | the arguments, the theme, the context | the card's head | the tool's name and its arguments (pi's generic card) |
| `renderResult` | the result (`content`, `details`), `{ expanded, isPartial }`, the theme, the context | the card's body | the output's first 10 lines, all when expanded |
| `renderShell` | — | `"self"`: the renderer draws its own frame; `"default"`: in the card's box | the box |
| `nestedCalls` | the `ToolView` | the calls this call made, for `context.calls` | `tool.calls` |

The context (`ToolRenderContext`) has `cwd`, `expanded` (Ctrl+O), `isPartial`, `isError`, `durationMs`, `calls`,
`state` (the card's own state across renders), `lastComponent` (to update instead of rebuilding) and `invalidate()`.
Helpers come from `@p2/app/v1/tui`: `str`, `num`, `record`, `getTextOutput`, `lineText`, `safeText`,
`shortenPath`, `moreLinesHint`, `renderDiff`, `VisualLinePreview`, `Theme` (`Theme.language(path)` for highlighting),
and `createShellRenderers(prompt)`, the card of a tool that runs `args.command` (bash and PowerShell use it).
Resolvers (`TuiToolRendererResolvers`) wrap every tool's renderers: `plugins/quiet-tools` draws one line per call
until expanded, from the tool's first string argument unless it knows the tool; a resolver keeps the registered
`nestedCalls`.

### Details: what the UI reads

A result has two parts: `output`, the text the model reads, and `details`, JSON the model never sees. Put into
`details` what the UI needs and should not parse out of text: counts, a diff (`edit`), a file's identity
(`send_file`), an artifact's version (`artifact`), the list of a script's calls (`codemode`). Both UIs get it as
`tool.details` (web) and `result.details` (TUI); read it defensively (`detailsOf`, `record`), it is whatever the tool
wrote, also in old transcripts. A running call has no `details` yet (`tool.status` is `pending` or `running`); a
failed one usually has none. Arguments come as the model wrote them (`tool.args`), validated against `parameters`
before `execute` ran.

## Other places a plugin may show things

Briefly; each is a keyed registry a facet contributes to (`docs/plugin-hooks.md` lists them all):

- **Web slots** (`Slots`, `src/runtime/web-core.ts`): components by slot name, e.g. `composer:<name>` (chips beside
  the composer, a `SlotList` by prefix), `sidebar-actions:<name>`, `session-actions`, `session-options`,
  `envs-actions:<name>`, `chat-attribution`, `chat-content`, `chat-bottom` (the terminal below the chat).
- **Composer expanders** (`ComposerExpanders`, `src/runtime/composer.ts`): rewrite the composer's text before it is
  sent (the prompt plugin expands `/template` and `/skill:`).
- **Sheets**: a component in a slot opens a route layer with `openLayer({ kind: "sheet", name, locator })` and
  renders `Sheet` while `useSheet(name)` is its own (`.pi/skills/p2-ui.md`, Back navigation).
- **Viewers**: `OpenViewer` with a `ViewerItem` (an artifact, a file) from a `Result` or `Detail`.
- **Transcript entries** (`TranscriptEntries`, the chat plugin's contract): what a plugin adds to the display of its
  entry kind's messages (the message it answers, a note), in the chat and the TUI.
- **TUI**: `TuiCommands` (slash commands), `TuiSlots` (status lines, footer parts), `TuiEntryRenderers`,
  `TuiSettingFields` (`/settings` rows).

## Testing a tool's UI

- **Words and summaries** (unit, no browser): build a `ToolActivityTable` with your contribution and call
  `chatItems`, `summary`, `describe`, `stepState` from `src/web/activity/model.ts` (`test/p2/activity-model.test.ts`).
  A plugin's own React modules need a browser.
- **The chat** (browser, component fixture): a fixture under `test/fixtures/` renders a conversation view with
  `TranscriptFixture` and your contribution (`test/fixtures/word-count.ts`); the test loads it with
  `browser.loadFixture`, shows a view built from entries (an assistant message with the tool call, the tool result),
  then checks the wheel (`[data-testid=activity]`), opens the step list (`[data-testid=step]`) and a detail. Add your
  contribution to `PLUGIN_TOOLS` in `test/fixtures/transcript.ts` so the other fixtures show it too.
- **End to end** (browser, real server): `startFixture({ web: true })` with the fake provider; add a prompt to
  `plugins/models/fake.ts` that makes the faux model call your tool (`SCRIPTED`, or a pattern like
  `artifact <json>`), send it through the `Chat` contract and wait for the result, then open the session in the
  browser (`test/p2/ui-inline-artifacts.test.ts`).
- **The TUI** (Node 26): draw a transcript with `transcriptComponent(transcript, false, expanded, { renderers })`
  from `src/tui/messages.ts` and match the stripped lines; add your renderers to `PLUGIN_TUI_RENDERERS` in
  `test/fixtures/tui-tools.ts`.
- Browser tests run with `CHROMIUM_BIN` set (`.pi/skills/p2-ui.md`, Tests).

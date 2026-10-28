/**
 * What the model reads about code mode, copied from the coding agent's code mode: the tool's fixed description (the
 * script environment and its globals), and the `codemode` prompt section, which lists the tools scripts can call as
 * TypeScript declarations, grouped by namespace and limited to a token budget. Tools that do not fit are found with
 * `searchTools()`. The section renders from the conversation's callable tools, so it changes with them; the tool's
 * description never does.
 */
import type { CodemodeJsonSchema } from "@earendil-works/pi-codemode";
import { renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import type { ToolRegistration } from "../harness/types.ts";
import { MODELS_DESCRIPTION } from "./models.ts";

/** A group of tools named by a common prefix, such as an MCP server's `mcp__github__`. */
export type CodemodeNamespace = {
	readonly name: string;
	readonly description?: string;
	readonly instructions?: string;
	/** Tool names starting with it belong to the namespace; the longest matching prefix wins. */
	readonly prefix: string;
};

/** Default token budget of the tool declarations in the `codemode` section, as in the coding agent. */
export const DEFAULT_CODEMODE_INLINE_BUDGET = 3000;
/** Characters per token when estimating the cost of a tool section. */
const CHARS_PER_TOKEN = 4;

const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };

const DESCRIPTION_INTRO = `Run JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level \`await\` and \`return\` work. No Node, file system, network, or timers.
- \`await tools.<name>({ ...args })\` resolves to a string, or an object if the tool's declaration says so, and rejects with an Error on failure. A tool whose declaration returns an object resolves on failure too when it returned that object; check its fields. Calls still running when the script ends are cancelled.
- The script survives a restart: it resumes where it was, without running finished calls again.
- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\``;

/** The code mode tool's description: the script environment and its globals, the same for every conversation. */
export function codemodeDescription(models: boolean): string {
	const globals = [
		"Globals:",
		"- `text(value)`, `image(dataUrlOrImageBlock)`, `console.log(...)`, and top-level `return` add output; `exit()` ends the script. With several text items, each starts with a `==> text N/M <==` line, and `console` lines follow the other output in one `<console_output>` block. `image()` also saves the image to a temp file and the result names its path.",
		"- `store(key, value)` and `load(key)` keep JSON values across codemode calls.",
		"- `ALL_TOOLS`, `await searchTools(query, { limit?, namespace? })`, `await describeTool(name)`, `await describeNamespace(name)`: find tools the `codemode` section does not list.",
	];
	return [
		DESCRIPTION_INTRO,
		globals.join("\n"),
		...(models ? [MODELS_DESCRIPTION] : []),
		"The `codemode` section of the system prompt lists the tools scripts can call, by namespace, as far as space allows.",
	].join("\n\n");
}

/** What a script sees of a tool: its declaration. Tools without an output schema resolve to their text output. */
export function declarationOf(tool: ToolRegistration): {
	name: string;
	description: string;
	inputSchema: CodemodeJsonSchema;
	outputSchema: CodemodeJsonSchema;
} {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters as CodemodeJsonSchema,
		outputSchema: (tool.structuredOutputSchema as CodemodeJsonSchema | undefined) ?? TEXT_OUTPUT_SCHEMA,
	};
}

/** `toolSample` of a tool: its description and TypeScript declaration. */
export function sampleOf(tool: ToolRegistration): string {
	return renderToolSample(declarationOf(tool));
}

/** The namespace of a tool: the one with the longest prefix its name starts with. */
export function namespaceOf(name: string, namespaces: readonly CodemodeNamespace[]): CodemodeNamespace | undefined {
	let found: CodemodeNamespace | undefined;
	for (const namespace of namespaces) {
		if (name.startsWith(namespace.prefix) && (found === undefined || namespace.prefix.length > found.prefix.length)) {
			found = namespace;
		}
	}
	return found;
}

/** `### \`id\` (\`raw name\`)` followed by the tool's description and declaration. */
function renderToolSection(tool: ToolRegistration): string {
	const id = toCodemodeIdentifier(tool.name);
	const heading = id === tool.name ? `### \`${id}\`` : `### \`${id}\` (\`${tool.name}\`)`;
	return `${heading}\n${sampleOf(tool).trim()}`;
}

type CatalogEntry = { name: string; section: string; cost: number };
type CatalogGroup = { namespace: CodemodeNamespace | undefined; entries: CatalogEntry[] };

/**
 * Pick the tool sections that fit the budget: in each round every group (tools without a namespace first, then
 * namespaces by name) places its cheapest remaining tool; a group whose next tool does not fit drops out while the
 * others continue. Every namespace is represented before any namespace is complete.
 */
function selectCatalog(groups: readonly CatalogGroup[], budget: number): Set<string> {
	const queues = groups.map((group) => [...group.entries].sort((a, b) => a.cost - b.cost));
	const shown = new Set<string>();
	let remaining = budget;
	let active = queues.filter((queue) => queue.length > 0);
	while (active.length > 0) {
		active = active.filter((queue) => {
			const next = queue[0]!;
			if (next.cost > remaining) return false;
			remaining -= next.cost;
			shown.add(next.name);
			queue.shift();
			return queue.length > 0;
		});
	}
	return shown;
}

/**
 * The `codemode` section: the tools scripts can call, grouped by namespace, with their declarations as far as the
 * budget allows. `undefined` without callable tools.
 */
export function codemodeSection(
	tools: readonly ToolRegistration[],
	namespaces: readonly CodemodeNamespace[],
	budget: number,
): string | undefined {
	if (tools.length === 0) return undefined;
	const groups = new Map<string, CatalogGroup>([["", { namespace: undefined, entries: [] }]]);
	for (const tool of tools) {
		const namespace = namespaceOf(tool.name, namespaces);
		const key = namespace ? `ns:${namespace.name}` : "";
		const group = groups.get(key) ?? { namespace, entries: [] };
		groups.set(key, group);
		const section = renderToolSection(tool);
		group.entries.push({ name: tool.name, section, cost: Math.ceil(section.length / CHARS_PER_TOKEN) });
	}
	const ordered = [...groups.values()].sort((a, b) =>
		a.namespace === undefined ? -1 : b.namespace === undefined ? 1 : a.namespace.name.localeCompare(b.namespace.name),
	);
	const shown = selectCatalog(ordered, budget);

	const toolSections = ["Tools scripts can call (`await tools.<name>(args)`):"];
	for (const { namespace, entries } of ordered) {
		if (entries.length === 0) continue;
		const visible = entries.filter((entry) => shown.has(entry.name));
		if (namespace) {
			const listing =
				visible.length === entries.length
					? ""
					: visible.length === 0
						? " (tools not listed)"
						: " (some tools not listed)";
			const description = namespace.description?.trim();
			toolSections.push(`## ${namespace.name}${listing}${description ? `\n${description}` : ""}`);
		} else if (visible.length < entries.length) {
			toolSections.push("Some tools are not listed: find them with `searchTools()`.");
		}
		for (const entry of visible) toolSections.push(entry.section);
	}
	return toolSections.join("\n\n");
}

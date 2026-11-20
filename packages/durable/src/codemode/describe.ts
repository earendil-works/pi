/**
 * What the model reads about code mode, copied from the coding agent's code mode: the tool's fixed description (the
 * script environment and its globals), and the `codemode` prompt section, which lists the tools scripts can call as
 * TypeScript declarations, grouped by the namespaces their extensions declare and limited to a token budget. Tools
 * that do not fit, and deferred tools, are found with `searchTools()`. A namespace is listed when at least one of its
 * tools is callable by this agent, or when its extensions declare no tools yet (an MCP server not connected: nothing
 * is known, so it is kept for the section's stability as its deferred tools appear); a namespace whose declared tools
 * are all unreachable for this agent is not listed, so a heading always describes tools a script can call. The tool's
 * description never changes.
 */
import type { CodemodeJsonSchema } from "@earendil-works/pi-codemode";
import { renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import type { Extension, ToolNamespace, ToolRegistration } from "../harness/types.ts";
import { MODELS_DESCRIPTION } from "./models.ts";

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

/**
 * The namespace of each tool the extensions bring, by tool name: the namespace of the extension whose registration
 * wins, the last one naming it (Durable composes tools by name, so the last extension's tool is the one that runs).
 * A name whose winner declares no namespace is ungrouped.
 */
export function namespacesOf(extensions: readonly Extension[]): ReadonlyMap<string, ToolNamespace> {
	const winners = new Map<string, ToolNamespace | undefined>();
	for (const extension of extensions)
		for (const tool of extension.tools ?? []) winners.set(tool.name, extension.namespace);
	const namespaces = new Map<string, ToolNamespace>();
	for (const [name, namespace] of winners) if (namespace !== undefined) namespaces.set(name, namespace);
	return namespaces;
}

/** The namespaces the extensions declare, by name (the first declaration of a name wins), sorted by name. */
export function declaredNamespaces(extensions: readonly Extension[]): readonly ToolNamespace[] {
	const byName = new Map<string, ToolNamespace>();
	for (const { namespace } of extensions)
		if (namespace !== undefined && !byName.has(namespace.name)) byName.set(namespace.name, namespace);
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The namespaces `codemodeSection` lists for an agent whose script-callable tools are `callable` (deferred ones
 * included): a namespace with at least one callable tool, or one whose extensions declare no tools yet. Only static
 * metadata is read, the extensions' tools and `callable`: whether a server is connected, or a tool is deferred or
 * offered to the model, does not decide it.
 */
export function listableNamespaces(
	extensions: readonly Extension[],
	callable: readonly ToolRegistration[],
): readonly ToolNamespace[] {
	const callableNames = new Set(callable.map((tool) => tool.name));
	const owners = namespacesOf(extensions);
	const reachable = new Set<string>();
	for (const name of callableNames) {
		const namespace = owners.get(name);
		if (namespace !== undefined) reachable.add(namespace.name);
	}
	const withTools = new Set<string>();
	for (const extension of extensions)
		if (extension.namespace !== undefined && (extension.tools?.length ?? 0) > 0)
			withTools.add(extension.namespace.name);
	return declaredNamespaces(extensions).filter(
		(namespace) => reachable.has(namespace.name) || !withTools.has(namespace.name),
	);
}

/** `### \`id\` (\`raw name\`)` followed by the tool's description and declaration. */
function renderToolSection(tool: ToolRegistration): string {
	const id = toCodemodeIdentifier(tool.name);
	const heading = id === tool.name ? `### \`${id}\`` : `### \`${id}\` (\`${tool.name}\`)`;
	return `${heading}\n${sampleOf(tool).trim()}`;
}

type CatalogEntry = { name: string; section: string; cost: number };
type CatalogGroup = { namespace: ToolNamespace | undefined; entries: CatalogEntry[] };

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
 * The `codemode` section: the tools scripts can call (ungrouped ones first), then every listable namespace the selected
 * `extensions` declare, by name, as `## <name>` and its description, each followed by its tools' declarations as far as
 * the budget allows. `tools` are the non-deferred callable ones to declare; `callable` is everything scripts can call
 * (deferred included), which decides which namespaces are listed. Headers carry no counts, so the text changes only
 * with the declared tools. `undefined` without callable tools and listable namespaces.
 */
export function codemodeSection(
	tools: readonly ToolRegistration[],
	extensions: readonly Extension[],
	budget: number,
	callable: readonly ToolRegistration[],
): string | undefined {
	const namespaces = listableNamespaces(extensions, callable);
	if (tools.length === 0 && namespaces.length === 0) return undefined;
	const toolNamespaces = namespacesOf(extensions);
	const ungrouped: CatalogGroup = { namespace: undefined, entries: [] };
	const groups = new Map<string, CatalogGroup>(
		namespaces.map((namespace) => [namespace.name, { namespace, entries: [] }]),
	);
	for (const tool of tools) {
		const namespace = toolNamespaces.get(tool.name);
		const group = namespace === undefined ? ungrouped : (groups.get(namespace.name) ?? ungrouped);
		const section = renderToolSection(tool);
		group.entries.push({ name: tool.name, section, cost: Math.ceil(section.length / CHARS_PER_TOKEN) });
	}
	const ordered = [ungrouped, ...groups.values()];
	const shown = selectCatalog(ordered, budget);

	const toolSections = ["Tools scripts can call (`await tools.<name>(args)`):"];
	if (shown.size < tools.length) toolSections.push("Some tools are not listed: find them with `searchTools()`.");
	for (const { namespace, entries } of ordered) {
		if (namespace !== undefined) toolSections.push(`## ${namespace.name}\n${namespace.description.trim()}`);
		for (const entry of entries) if (shown.has(entry.name)) toolSections.push(entry.section);
	}
	return toolSections.join("\n\n");
}

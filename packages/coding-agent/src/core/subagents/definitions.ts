// Discover native agent roles using the existing user/project Markdown frontmatter convention.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { ModelThinkingLevelSchema } from "../pi-ai-schemas.ts";

const roleSchema = Type.Object({
	name: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$" }),
	description: Type.String({ minLength: 1 }),
	tools: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String({ minLength: 1 }))])),
	model: Type.Optional(Type.String({ minLength: 1 })),
	thinkingLevel: Type.Optional(ModelThinkingLevelSchema),
});
const validator = Compile(roleSchema);

export const AgentDefinitionSchema = Type.Object({
	name: roleSchema.properties.name,
	description: roleSchema.properties.description,
	tools: Type.Optional(Type.Array(Type.String())),
	model: roleSchema.properties.model,
	thinkingLevel: roleSchema.properties.thinkingLevel,
	systemPrompt: Type.String(),
	source: Type.Union([Type.Literal("builtin"), Type.Literal("user"), Type.Literal("project")]),
	filePath: Type.Optional(Type.String()),
});

export type AgentDefinition = Static<typeof AgentDefinitionSchema>;
export interface AgentDefinitions {
	agents: AgentDefinition[];
	errors: Array<{ path: string; error: string }>;
}

const readTools = ["read", "grep", "find", "ls"];
const builtinAgents: AgentDefinition[] = [
	{
		name: "worker",
		description: "Implement delegated coding tasks in the shared working tree.",
		systemPrompt:
			"Complete the assigned implementation. Preserve unrelated changes. Report exact files changed, verification performed, and any blockers. Do not commit or push unless the delegated task explicitly authorizes it.",
		source: "builtin",
	},
	{
		name: "librarian",
		description: "Read-only codebase investigation with concise, evidence-backed handoff.",
		tools: readTools,
		systemPrompt:
			"Investigate the assigned topic without changing files. Return relevant paths, symbols, line references, concrete findings, and uncertainties. Distinguish observed facts from inference.",
		source: "builtin",
	},
	{
		name: "reviewer",
		description: "Read-only review for correctness, security, and maintainability.",
		tools: readTools,
		systemPrompt:
			"Review the assigned code without changing files. Report actionable, evidence-backed defects with file and line references, concrete failure scenarios, and severity. Do not invent findings to fill a quota.",
		source: "builtin",
	},
	{
		name: "philosopher",
		description:
			"Read-only implementation planning grounded in the current codebase. Prepare questions, clarifications for the output to help if something seems off the user achieve the desired plan. Do not recommend new major architectural decisions without clarifying with the user.",
		tools: readTools,
		systemPrompt:
			"Inspect the relevant code and propose a concrete implementation plan. Identify interfaces, affected callers, risks, and verification. Do not change files.",
		source: "builtin",
	},
];

/** Discover role precedence; invalid configuration disables new launches instead of widening tool permissions. */
export function discoverAgentDefinitions(cwd: string, agentDir = getAgentDir()): AgentDefinitions {
	const agents = new Map(builtinAgents.map((agent) => [agent.name, agent]));
	const errors: AgentDefinitions["errors"] = [];
	const directories: Array<{ path: string; source: "user" | "project" }> = [
		{ path: join(agentDir, "agents"), source: "user" },
	];
	let directory = cwd;
	while (true) {
		const path = join(directory, CONFIG_DIR_NAME, "agents");
		if (existsSync(path) && statSync(path).isDirectory()) {
			directories.push({ path, source: "project" });
			break;
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	for (const directory of directories) {
		if (!existsSync(directory.path)) continue;
		for (const entry of readdirSync(directory.path, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
			const path = join(directory.path, entry.name);
			try {
				const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(readFileSync(path, "utf8"));
				// Agent files are executable configuration: malformed tool declarations must never widen permissions.
				if (!validator.Check(frontmatter)) {
					throw new Error(
						"Invalid agent frontmatter: require name/description and valid tools/model/thinkingLevel",
					);
				}
				const tools =
					frontmatter.tools === undefined
						? undefined
						: typeof frontmatter.tools === "string"
							? frontmatter.tools
									.split(",")
									.map((name) => name.trim())
									.filter(Boolean)
							: frontmatter.tools;
				agents.set(frontmatter.name, {
					name: frontmatter.name,
					description: frontmatter.description,
					tools,
					model: frontmatter.model,
					thinkingLevel: frontmatter.thinkingLevel,
					systemPrompt: body,
					source: directory.source,
					filePath: path,
				});
			} catch (error) {
				errors.push({ path, error: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	return { agents: errors.length ? [] : [...agents.values()], errors };
}

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import type { ToolName } from "../../src/core/tools/index.js";

export type ManualEvalSuiteName = "discovery" | "plan-mode" | "max-edit";

export interface ManualEvalObservation {
	assistantText: string;
	toolNames: string[];
	toolResults: ToolResultMessage[];
	workspaceDir: string;
}

export interface ManualEvalCheckResult {
	pass: boolean;
	notes: string[];
}

export interface ManualEvalScenario {
	suite: ManualEvalSuiteName;
	name: string;
	description: string;
	prompt: string;
	tools?: ToolName[];
	extensionPaths?: string[];
	setup(workspaceDir: string): Promise<void> | void;
	check(observation: ManualEvalObservation): ManualEvalCheckResult;
}

const planModeExtensionPath = fileURLToPath(new URL("../../examples/extensions/plan-mode", import.meta.url));
const maxEditExtensionPath = fileURLToPath(new URL("../../examples/extensions/max-edit", import.meta.url));

export const MANUAL_EVAL_SCENARIOS: ManualEvalScenario[] = [
	{
		suite: "discovery",
		name: "tree-first-file-localization",
		description: "Verify the agent starts with tree/read_subtree and lands on the right file in a small repo.",
		prompt:
			"Find the file that defines alphaFlag. Start with tree-style discovery before broad reads. Return the file path only.",
		tools: ["read", "grep", "find", "ls", "tree", "read_subtree"],
		setup(workspaceDir) {
			mkdirSync(join(workspaceDir, "src", "feature"), { recursive: true });
			writeFileSync(join(workspaceDir, ".piignore"), "src/feature/ignored.ts\n", "utf-8");
			writeFileSync(join(workspaceDir, "src", "feature", "flags.ts"), "export const alphaFlag = true;\n", "utf-8");
			writeFileSync(
				join(workspaceDir, "src", "feature", "ignored.ts"),
				"export const alphaFlag = false;\n",
				"utf-8",
			);
		},
		check(observation) {
			const toolNames = observation.toolNames;
			return {
				pass:
					observation.assistantText.includes("src/feature/flags.ts") &&
					(toolNames.includes("tree") || toolNames.includes("read_subtree")),
				notes: [`assistant=${observation.assistantText}`, `tools=${toolNames.join(",")}`],
			};
		},
	},
	{
		suite: "plan-mode",
		name: "planning-shape-check",
		description:
			"Check that the loaded plan-mode stack returns a planning-oriented answer instead of implementation output.",
		prompt: "Plan how to add audit logging to the API layer. Do not implement anything.",
		extensionPaths: [planModeExtensionPath],
		setup(workspaceDir) {
			mkdirSync(join(workspaceDir, "src", "api"), { recursive: true });
			writeFileSync(join(workspaceDir, "src", "api", "server.ts"), "export const server = {};\n", "utf-8");
		},
		check(observation) {
			const text = observation.assistantText.toLowerCase();
			return {
				pass: text.includes("plan") || text.includes("step") || text.includes("todo"),
				notes: [`assistant=${observation.assistantText}`],
			};
		},
	},
	{
		suite: "max-edit",
		name: "rename-constant-via-max-edit",
		description: "Run the max-edit pack on a tiny workspace and verify the selected proposal applies cleanly.",
		prompt: "Use max_edit to rename value to total in src/app.ts and keep the file behavior unchanged.",
		extensionPaths: [maxEditExtensionPath],
		setup(workspaceDir) {
			mkdirSync(join(workspaceDir, "src"), { recursive: true });
			writeFileSync(
				join(workspaceDir, "src", "app.ts"),
				"export function getValue() {\n\tconst value = 1;\n\treturn value;\n}\n",
				"utf-8",
			);
		},
		check(observation) {
			const content = readFileSync(join(observation.workspaceDir, "src", "app.ts"), "utf-8");
			return {
				pass: content.includes("const total = 1;") && content.includes("return total;"),
				notes: [`assistant=${observation.assistantText}`, `file=${content}`],
			};
		},
	},
];

export function getManualEvalScenarios(filters?: { suite?: ManualEvalSuiteName; name?: string }): ManualEvalScenario[] {
	return MANUAL_EVAL_SCENARIOS.filter((scenario) => {
		if (filters?.suite && scenario.suite !== filters.suite) {
			return false;
		}
		if (filters?.name && scenario.name !== filters.name) {
			return false;
		}
		return true;
	});
}

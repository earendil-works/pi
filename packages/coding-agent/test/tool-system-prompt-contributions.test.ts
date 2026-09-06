import { describe, expect, test } from "vitest";
import { bashToolSystemPromptContribution, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition, editToolSystemPromptContribution } from "../src/core/tools/edit.ts";
import { createFindToolDefinition, findToolSystemPromptContribution } from "../src/core/tools/find.ts";
import { createGrepToolDefinition, grepToolSystemPromptContribution } from "../src/core/tools/grep.ts";
import { createLsToolDefinition, lsToolSystemPromptContribution } from "../src/core/tools/ls.ts";
import {
	createPowerShellToolDefinition,
	powershellToolSystemPromptContribution,
} from "../src/core/tools/powershell.ts";
import { createReadToolDefinition, readToolSystemPromptContribution } from "../src/core/tools/read.ts";
import { createWriteToolDefinition, writeToolSystemPromptContribution } from "../src/core/tools/write.ts";

const cases = [
	["read", readToolSystemPromptContribution, createReadToolDefinition],
	["bash", bashToolSystemPromptContribution, createBashToolDefinition],
	["powershell", powershellToolSystemPromptContribution, createPowerShellToolDefinition],
	["edit", editToolSystemPromptContribution, createEditToolDefinition],
	["write", writeToolSystemPromptContribution, createWriteToolDefinition],
	["grep", grepToolSystemPromptContribution, createGrepToolDefinition],
	["find", findToolSystemPromptContribution, createFindToolDefinition],
	["ls", lsToolSystemPromptContribution, createLsToolDefinition],
] as const;

describe("built-in tool system prompt contributions", () => {
	test.each(cases)(
		"keeps the %s tool definition aligned with its contribution",
		(_name, contribution, createDefinition) => {
			const definition = createDefinition("/workspace");

			expect(definition.promptSnippet).toBe(contribution.snippet);
			expect(definition.promptGuidelines ?? []).toEqual(contribution.guidelines);
		},
	);

	test.each([
		["bash", createBashToolDefinition],
		["powershell", createPowerShellToolDefinition],
	] as const)("keeps %s session-environment guidance conditional", (_name, createDefinition) => {
		const definition = createDefinition("/workspace", { exposeSessionEnvironment: false });

		expect(definition.promptGuidelines).toBeUndefined();
	});
});

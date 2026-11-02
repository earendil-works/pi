import { existsSync } from "node:fs";
import { join } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import { describeEval, StructuredOutputJudge } from "vitest-evals";
import { createPiDocumentationEvalHarness } from "../src/harness.ts";

const TEMPLATE_NAME = "current-time";
const COMMAND = `/${TEMPLATE_NAME}`;
const TEMPLATE_PROMPT = "Tell me the current time and timezone.";

const SCENARIOS = [
	{
		title: "Create a project prompt template",
		request: `This project is already trusted. Add a ${COMMAND} prompt template for this project containing exactly: ${TEMPLATE_PROMPT}`,
		scope: "project",
	},
	{
		title: "Create a user prompt template",
		request: `Make a ${COMMAND} prompt template available in all my Pi sessions containing exactly: ${TEMPLATE_PROMPT}`,
		scope: "user",
	},
] as const;

function registerScenario(scenario: (typeof SCENARIOS)[number]): void {
	const harness = createPiDocumentationEvalHarness({
		output: ({ session, agentDir }) => {
			const workspace = session.sessionManager.getCwd();
			const projectPath = join(workspace, ".pi", "prompts", `${TEMPLATE_NAME}.md`);
			const userPath = join(agentDir, "prompts", `${TEMPLATE_NAME}.md`);
			const expectedPath = scenario.scope === "project" ? projectPath : userPath;
			const otherPath = scenario.scope === "project" ? userPath : projectPath;
			const { prompts, diagnostics } = session.resourceLoader.getPrompts();
			const extensions = session.resourceLoader.getExtensions();
			const matchingTemplates = prompts.filter(({ name }) => name === TEMPLATE_NAME);
			const template = matchingTemplates.length === 1 ? matchingTemplates[0] : undefined;
			const expandedPrompt = [...session.messages]
				.reverse()
				.find((message) => message.role === "user");
			const expandedText = expandedPrompt?.role === "user" ? contentText(expandedPrompt.content).trim() : "";

			return {
				template: template
					? { scope: template.sourceInfo.scope, atExpectedPath: template.filePath === expectedPath }
					: null,
				promptDiagnostics: diagnostics.map(({ message }) => message),
				extensions: extensions.extensions.filter(({ hidden }) => !hidden).map(({ path }) => path),
				extensionErrors: extensions.errors.map(({ error }) => error),
				skills: session.resourceLoader.getSkills().skills.map(({ name }) => name),
				otherScopeTemplateExists: existsSync(otherPath),
				expandedToTimeRequest: expandedText === TEMPLATE_PROMPT,
			};
		},
	});
	const judge = StructuredOutputJudge({
		expected: {
			template: { scope: scenario.scope, atExpectedPath: true },
			promptDiagnostics: [],
			extensions: [],
			extensionErrors: [],
			skills: [],
			otherScopeTemplateExists: false,
			expandedToTimeRequest: true,
		},
		match: "strict",
		allowExtras: false,
	});

	describeEval(scenario.title, { harness, judges: [judge], judgeThreshold: null }, (it) => {
		it(`creates, reloads, and invokes ${COMMAND}`, async ({ run }) => {
			await run([
				{ type: "prompt", content: scenario.request },
				{ type: "reload" },
				{ type: "prompt", content: COMMAND },
			]);
		});
	});
}

for (const scenario of SCENARIOS) registerScenario(scenario);

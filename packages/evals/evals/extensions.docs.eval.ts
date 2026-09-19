import { contentText } from "@earendil-works/pi-ai";
import { describeEval, StructuredOutputJudge, ToolCallJudge } from "vitest-evals";
import { createPiDocumentationEvalHarness, DOCUMENTATION_EVAL_TOOLS } from "../src/harness.ts";

const TOOL_NAME = "hello";
const TOOL_ARGUMENTS = { name: "Bob" };
const TOOL_RESULT = "Hello, Bob!";

const harness = createPiDocumentationEvalHarness({
	tools: [...DOCUMENTATION_EVAL_TOOLS, TOOL_NAME],
	output: ({ response, session }) => {
		const extensions = session.resourceLoader.getExtensions();
		const result = [...session.messages]
			.reverse()
			.find((message) => message.role === "toolResult" && message.toolName === TOOL_NAME && !message.isError);
		return {
			response,
			extensionErrors: extensions.errors,
			toolLoaded: extensions.extensions.some(({ tools }) => tools.has(TOOL_NAME)),
			toolResult: result?.role === "toolResult" ? contentText(result.content) : null,
		};
	},
});

describeEval(
	"Create and use a tool extension",
	{
		harness,
		judges: [
			StructuredOutputJudge({
				expected: {
					response: TOOL_RESULT,
					extensionErrors: [],
					toolLoaded: true,
					toolResult: TOOL_RESULT,
				},
				match: "strict",
				allowExtras: false,
			}),
			ToolCallJudge({ expectedTools: [{ name: TOOL_NAME, arguments: TOOL_ARGUMENTS }] }),
		],
		judgeThreshold: null,
	},
	(it) => {
		it("creates, reloads, and invokes the extension", async ({ run }) => {
			await run([
				{
					type: "prompt",
					content:
						"Configure this running Pi installation with an extension containing a hello tool that takes a name and returns a greeting. Do not create project source. For example, passing Bob should return `Hello, Bob!`.",
				},
				{ type: "reload" },
				{
					type: "prompt",
					content: "Use the hello tool to greet Bob. Respond with exactly the tool's greeting and nothing else.",
				},
			]);
		});
	},
);

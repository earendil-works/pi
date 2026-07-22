import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import { complete, getModel, getProviders, streamSimple } from "@earendil-works/pi-ai/compat";
import {
	Agent,
	bashExecutionToText,
	convertToLlm,
	createCustomMessage,
	FileError,
	formatPromptTemplateInvocation,
	formatSkillInvocation,
	formatSkillsForSystemPrompt,
	getOrThrow,
	InMemorySessionRepo,
	ok,
	parseCommandArgs,
	streamProxy,
	toError,
	truncateHead,
} from "@earendil-works/pi-agent-core";

// Keep this entry browser-safe. It is bundled by scripts/check-browser-smoke.mjs
// to catch accidental Node-only runtime imports in browser-facing package exports.
const model = getModel("google", "gemini-2.5-flash");
const schema = Type.Object({ prompt: Type.String() });
const stream = createAssistantMessageEventStream();

const agent = new Agent({ initialState: { model }, streamFn: streamSimple });
agent.steer({ role: "user", content: [{ type: "text", text: "queued" }], timestamp: 0 });
const repo = new InMemorySessionRepo();
const result = getOrThrow(ok({ value: 1 }));
const customMessage = createCustomMessage("note", "hello", true, undefined, "2026-01-01T00:00:00.000Z");
const llmMessages = convertToLlm([customMessage]);
const skill = { name: "browser-safe", description: "Smoke test", content: "Use browser APIs.", filePath: "/skills/browser-safe/SKILL.md" };

console.log(
	model.id,
	getProviders().length,
	typeof complete,
	schema.type,
	typeof stream.push,
	agent.hasQueuedMessages(),
	typeof repo.create,
	result.value,
	llmMessages.length,
	bashExecutionToText({
		role: "bashExecution",
		command: "echo ok",
		output: "ok",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 0,
	}),
	formatSkillsForSystemPrompt([skill]).length,
	formatSkillInvocation(skill).length,
	formatPromptTemplateInvocation({ name: "example", content: "$1 $@" }, parseCommandArgs('one "two three"')),
	truncateHead("a\nb", { maxLines: 1 }).content,
	new FileError("not_found", "missing").code,
	toError("boom").message,
	typeof streamProxy,
);

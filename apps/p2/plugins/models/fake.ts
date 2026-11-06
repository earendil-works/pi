// The fake provider of demo and test mode (P2_FAKE, `startServer({ fake: true })`): prompts that make the faux model
// call a tool (SCRIPTED and the `<tool> <json>` forms), one-shot agents' sample answers, and echoes otherwise.
import { appendFileSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import { type CreateModelsOptions, createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { SENDER_PREFIX } from "@p2/app/v1";

// Fake-mode prompts that make the faux model call one tool; anything else is echoed.
const SCRIPTED: Record<string, () => ReturnType<typeof fauxToolCall>> = {
	tool: () => fauxToolCall("read", { path: "fixture.txt" }),
	write: () => fauxToolCall("write", { path: "created.txt", content: "before\n" }),
	edit: () => fauxToolCall("edit", { path: "created.txt", edits: [{ oldText: "before", newText: "after" }] }),
	bash: () => fauxToolCall("bash", { command: "pwd" }),
	"send-file": () => fauxToolCall("send_file", { path: "created.txt" }),
	artifact: () =>
		fauxToolCall("artifact", {
			name: "demo",
			title: "Demo artifact",
			type: "html",
			content: "<!doctype html><title>Demo</title><h1>Artifact demo</h1>",
		}),
	subagent: () =>
		fauxToolCall("subagent", {
			action: "spawn",
			name: "helper",
			message: "hello helper",
			thinkingLevel: "high",
			tools: ["read"],
		}),
	"subagent-configure": () =>
		fauxToolCall("subagent", {
			action: "configure",
			name: "helper",
			model: "faux/faux-1",
			thinkingLevel: "high",
			tools: ["bash", "artifact"],
		}),
	"subagent-second": () =>
		fauxToolCall("subagent", { action: "spawn", name: "second", message: "hello second", tools: ["read"] }),
	"subagent-answer": () => fauxToolCall("subagent", { action: "answer", name: "helper" }),
	"subagent-send": () => fauxToolCall("subagent", { action: "send", name: "helper", message: "hello again" }),
	"subagent-archive": () => fauxToolCall("subagent", { action: "archive", name: "helper" }),
	"subagent-status": () => fauxToolCall("subagent", { action: "status" }),
	"subagent-bad": () =>
		fauxToolCall("subagent", { action: "spawn", name: "bad", message: "x", model: "nope/missing" }),
	// Code mode: a script whose nested calls are two tools (codemode plugin).
	codemode: () =>
		fauxToolCall("codemode", {
			code: [
				'const written = await tools.bash({ command: "echo first >> codemode.log; printf written" }).then((result) => result.output);',
				'const read = await tools.read({ path: "codemode.log" });',
				'text("bash: " + written);',
				"return read;",
			].join("\n"),
		}),
	// Code mode across a worker restart: the slow middle call is interrupted, the script catches it and continues.
	"codemode-restart": () =>
		fauxToolCall("codemode", {
			code: [
				'const one = (await tools.bash({ command: "echo one >> codemode.log; printf one" })).output;',
				"let two;",
				'try { two = (await tools.bash({ command: "sleep 5; echo two >> codemode.log; printf two" })).output; }',
				'catch (error) { two = "two failed: " + error.message; }',
				'const three = (await tools.bash({ command: "echo three >> codemode.log; printf three" })).output;',
				'return [one, two, three].join(" | ");',
			].join("\n"),
		}),
	"slow-tool": () => fauxToolCall("bash", { command: "printf tool-running; sleep 4; printf tool-finished" }),
};

/** The system prompt of a one-shot agent (plugins/agent) ends its instructions with its schema on this line's end. */
const ONE_SHOT_SCHEMA = "matching this JSON Schema, without prose or code fences:\n";

/** The text of a user message, without the sender block in front. */
function userText(message: Message | undefined): string {
	if (message?.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	const first = message.content[0];
	const parts =
		first?.type === "text" && first.text.startsWith(SENDER_PREFIX) ? message.content.slice(1) : message.content;
	return parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** A one-shot agent's answer schema, from its conversation's system messages. */
function oneShotSchema(messages: readonly Message[]): unknown {
	for (const message of messages) {
		if (message.role !== "system") continue;
		const texts = [
			typeof message.content === "string" ? message.content : message.content.map((part) => part.text).join(""),
			...Object.values(message.sections ?? {}).flatMap((section) => (section ? [section] : [])),
		];
		for (const text of texts) {
			const at = text.indexOf(ONE_SHOT_SCHEMA);
			if (at >= 0) return JSON.parse(text.slice(at + ONE_SHOT_SCHEMA.length).split("\n")[0] ?? "null");
		}
	}
	return undefined;
}

/**
 * A small value matching a JSON Schema: the first enum value, every property, one array item, empty strings and
 * minimums. Enough for code mode workflow scripts to run end to end in fake mode (docs/workflows.md).
 */
function sampleOf(schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null) return null;
	const spec = schema as Record<string, unknown>;
	if (Array.isArray(spec.enum)) return spec.enum[0];
	if ("const" in spec) return spec.const;
	switch (spec.type) {
		case "object":
			return Object.fromEntries(
				Object.entries((spec.properties ?? {}) as Record<string, unknown>).map(([key, value]) => [
					key,
					sampleOf(value),
				]),
			);
		case "array":
			return spec.maxItems === 0 ? [] : [sampleOf(spec.items)];
		case "string":
			return "x".repeat(typeof spec.minLength === "number" ? spec.minLength : 0);
		case "integer":
		case "number":
			return typeof spec.minimum === "number" ? spec.minimum : 0;
		case "boolean":
			return false;
		default:
			return null;
	}
}

// Explicit demo/test mode. Responses depend on committed input, not a volatile
// queue position, so reopening an interrupted request is deterministic.
// Tests set P2_FAKE_REQUESTS (via workerEnv) to a file that receives each request's messages as one JSON line.
export function createFakeModels(options: CreateModelsOptions = {}) {
	const requests = process.env.P2_FAKE_REQUESTS;
	const models = createModels(options);
	const faux = fauxProvider({ api: "p2-faux", tokensPerSecond: 200, tokenSize: { min: 4, max: 4 } });
	models.setProvider({
		...faux.provider,
		streamSimple(model, context, options) {
			if (requests) {
				const messages = context.messages.map((message) => ({
					role: message.role,
					content:
						typeof message.content === "string"
							? message.content
							: message.content.map((part) =>
									part.type === "image" ? { type: "image", mimeType: part.mimeType } : part,
								),
				}));
				appendFileSync(requests, `${JSON.stringify(messages)}\n`);
			}
			faux.appendResponses([
				(transcript) => {
					const text = userText(transcript.messages.findLast((message) => message.role === "user"));
					// A one-shot agent answers a small value matching its schema, unless its task is a `json …` or `slow…`
					// test prompt (exact answers, retries with non-JSON echoes, a long stream to stop).
					const schema = oneShotSchema(transcript.messages);
					const task = userText(transcript.messages.find((message) => message.role === "user"));
					if (schema !== undefined && !task.startsWith("json ") && !task.startsWith("slow"))
						return fauxAssistantMessage([fauxText(JSON.stringify(sampleOf(schema)))]);
					// `steps`: a turn as real models make them: thinking and a call, words and another call, thinking and the
					// answer (the transcript's stability tests).
					if (text === "steps") {
						const asked = transcript.messages.findLastIndex((message) => message.role === "user");
						const results = transcript.messages
							.slice(asked + 1)
							.filter((message) => message.role === "toolResult").length;
						if (results === 0)
							return fauxAssistantMessage(
								[
									fauxThinking(`Planning the steps. ${"Looking at the files first. ".repeat(12)}`),
									fauxToolCall("read", { path: "fixture.txt" }),
								],
								{ stopReason: "toolUse" },
							);
						if (results === 1)
							return fauxAssistantMessage(
								[
									fauxText(`The first read is done. ${"Reading it once more to be sure. ".repeat(6)}`),
									fauxToolCall("read", { path: "fixture.txt" }),
								],
								{ stopReason: "toolUse" },
							);
						return fauxAssistantMessage([
							fauxThinking(`Wrapping up. ${"Both reads agree. ".repeat(12)}`),
							fauxText(`Echo: steps. ${"Both reads show the same text, so the file is stable. ".repeat(8)}`),
						]);
					}
					// A section that changed during the run (tools loaded by `tool_search`) adds a system message after the result.
					const last = transcript.messages.findLast((message) => message.role !== "system");
					if (last?.role !== "toolResult") {
						const call = Object.hasOwn(SCRIPTED, text)
							? SCRIPTED[text]?.()
							: text.startsWith("conversations ")
								? fauxToolCall("conversations", JSON.parse(text.slice("conversations ".length)))
								: text.startsWith("rename-session ")
									? fauxToolCall("rename_session", { title: text.slice("rename-session ".length) })
									: text.startsWith("ports ")
										? fauxToolCall("ports", JSON.parse(text.slice("ports ".length)))
										: // `codemode <script>` runs that script (the bare `codemode` above is a fixed one).
											text.startsWith("codemode ")
											? fauxToolCall("codemode", { code: text.slice("codemode ".length) })
											: text.startsWith("subagent ")
												? fauxToolCall("subagent", JSON.parse(text.slice("subagent ".length)))
												: text.startsWith("team ")
													? fauxToolCall("team", JSON.parse(text.slice("team ".length)))
													: /^(artifact|history_(search|read|handoff)|location_(envs|dirs|move)|tool_search|terminal|mcp__\w+) /.test(
																text,
															)
														? fauxToolCall(
																text.slice(0, text.indexOf(" ")),
																JSON.parse(text.slice(text.indexOf(" ") + 1)),
															)
														: undefined;
						if (call)
							return fauxAssistantMessage(
								[fauxText(text === "tool" ? "Reading fixture." : `Running ${call.name}.`), call],
								{ stopReason: "toolUse" },
							);
					}
					return fauxAssistantMessage([
						fauxThinking("private-thinking-sentinel"),
						// `json <text>` answers exactly `<text>` (code mode's one-shot agents parse it).
						fauxText(
							text.startsWith("json ")
								? text.slice("json ".length)
								: text.startsWith("slow")
									? `Echo: ${text} ${"streaming ".repeat(300)}`
									: `Echo: ${text}`,
						),
					]);
				},
			]);
			return faux.provider.streamSimple(model, context, options);
		},
	});
	return models;
}

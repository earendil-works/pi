// Scripted fake LLM provider: deterministic StreamFn for orchestration tests.
// Returns one AssistantMessageEventStream per call from a queued script.

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export const FAKE_MODEL: Model<"fake"> = {
	id: "fake-1",
	name: "Fake 1",
	api: "fake",
	provider: "fake",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
} as unknown as Model<"fake">;

export interface FakeScriptStep {
	text?: string;
	toolCalls?: { name: string; args: Record<string, unknown>; id?: string }[];
	usage?: { input: number; output: number };
	stopReason?: "stop" | "error";
	errorMessage?: string;
}

function buildAssistant(
	text: string,
	toolCalls: FakeScriptStep["toolCalls"],
	usage: { input: number; output: number },
): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (text) content.push({ type: "text", text });
	for (const tc of toolCalls ?? []) {
		content.push({
			type: "toolCall",
			id: tc.id ?? `tc-${Math.random().toString(36).slice(2)}`,
			name: tc.name,
			arguments: tc.args,
		} as never);
	}
	return {
		role: "assistant",
		content,
		api: "fake",
		provider: "fake",
		model: "fake-1",
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: usage.input + usage.output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

export class FakeProvider {
	readonly model: Model<"fake"> = FAKE_MODEL;
	private idx = 0;
	readonly calls: TranscriptContext[] = [];
	readonly script: FakeScriptStep[];

	constructor(script: FakeScriptStep[]) {
		this.script = script;
	}

	readonly streamFn: StreamFn = (model, context) => {
		this.calls.push(context);
		const step: FakeScriptStep = this.script[this.idx++] ?? { text: "done" };
		const final = buildAssistant(step.text ?? "", step.toolCalls, step.usage ?? { input: 10, output: 5 });
		if (step.stopReason === "error") (final as { stopReason: string }).stopReason = "error";
		if (step.errorMessage) (final as { errorMessage?: string }).errorMessage = step.errorMessage;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: final });
			stream.push({ type: "done" as const, reason: "stop" as const, message: final });
		});
		return stream;
	};
}

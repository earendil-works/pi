import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	PROVIDER_PAYLOAD_AUDIT_CUSTOM_TYPE,
	ProviderPayloadAudit,
	type ProviderPayloadAuditRecord,
} from "../src/core/provider-payload-audit.ts";
import { type CustomEntry, SessionManager } from "../src/core/session-manager.ts";

const anthropicModel = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
} as Model<any>;

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value)) deepFreeze(child);
	return value;
}

function records(manager: SessionManager): ProviderPayloadAuditRecord[] {
	return manager
		.getEntries()
		.filter(
			(entry): entry is CustomEntry =>
				entry.type === "custom" && entry.customType === PROVIDER_PAYLOAD_AUDIT_CUSTOM_TYPE,
		)
		.map((entry) => entry.data as ProviderPayloadAuditRecord);
}

function section(record: ProviderPayloadAuditRecord, key: string) {
	return record.sectionContinuity.find((value) => value.key === key);
}

describe("ProviderPayloadAudit", () => {
	it("hashes the final payload without mutation and distinguishes linear appends from rewrites", () => {
		const manager = SessionManager.inMemory();
		const audit = new ProviderPayloadAudit(manager, true);
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "first secret" }], timestamp: 1 });

		const firstPayload = deepFreeze({
			model: anthropicModel.id,
			system: "stable system secret",
			tools: [{ name: "read", input_schema: { type: "object" } }],
			messages: [{ role: "user", content: "first secret" }],
			max_tokens: 4096,
		});
		const firstBytes = JSON.stringify(firstPayload);
		audit.record(firstPayload, anthropicModel);
		expect(JSON.stringify(firstPayload)).toBe(firstBytes);

		manager.appendCustomMessageEntry("test-reply", "reply", false);
		const appendedPayload = deepFreeze({
			...firstPayload,
			messages: [...firstPayload.messages, { role: "assistant", content: "reply" }],
			max_tokens: 8192,
		});
		audit.record(appendedPayload, anthropicModel);

		manager.appendMessage({ role: "user", content: [{ type: "text", text: "next" }], timestamp: 2 });
		const rewrittenPayload = deepFreeze({
			...appendedPayload,
			messages: [
				{ role: "user", content: "changed earlier content" },
				...appendedPayload.messages.slice(1),
				{ role: "user", content: "next" },
			],
		});
		audit.record(rewrittenPayload, anthropicModel);

		const [initial, appended, rewritten] = records(manager);
		expect(initial.classification).toBe("initial-context");
		expect(initial.payloadPrefixBroken).toBe(false);
		expect(JSON.stringify(initial)).not.toContain("secret");

		expect(appended.classification).toBe("linear-append-or-retry");
		expect(appended.sessionContext.change).toBe("appended");
		expect(section(appended, "messages")).toMatchObject({ change: "appended", commonPrefixItems: 1 });

		expect(rewritten.classification).toBe("linear-prefix-break");
		expect(rewritten.payloadPrefixBroken).toBe(true);
		expect(rewritten.sessionContext.change).toBe("appended");
		expect(section(rewritten, "messages")).toMatchObject({ change: "rewritten", commonPrefixItems: 0 });
	});

	it("tracks nested provider context while ignoring non-context request options", () => {
		const manager = SessionManager.inMemory();
		const audit = new ProviderPayloadAudit(manager, true);
		const googleModel = {
			...anthropicModel,
			id: "gemini-test",
			provider: "google",
			api: "google-generative-ai",
		} as Model<any>;
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 });
		audit.record(
			{
				model: googleModel.id,
				contents: [{ role: "user", parts: [{ text: "first" }] }],
				config: {
					systemInstruction: "stable",
					tools: [{ functionDeclarations: [{ name: "read" }] }],
					thinkingConfig: { thinkingLevel: "LOW" },
				},
			},
			googleModel,
		);

		manager.appendMessage({ role: "user", content: [{ type: "text", text: "second" }], timestamp: 2 });
		audit.record(
			{
				model: googleModel.id,
				contents: [
					{ role: "user", parts: [{ text: "first" }] },
					{ role: "user", parts: [{ text: "second" }] },
				],
				config: {
					systemInstruction: "stable",
					tools: [{ functionDeclarations: [{ name: "read" }] }],
					thinkingConfig: { thinkingLevel: "HIGH" },
				},
			},
			googleModel,
		);

		manager.appendMessage({ role: "user", content: [{ type: "text", text: "third" }], timestamp: 3 });
		audit.record(
			{
				model: googleModel.id,
				contents: [
					{ role: "user", parts: [{ text: "first" }] },
					{ role: "user", parts: [{ text: "second" }] },
					{ role: "user", parts: [{ text: "third" }] },
				],
				config: {
					systemInstruction: "stable",
					tools: [{ functionDeclarations: [{ name: "read" }] }, { functionDeclarations: [{ name: "write" }] }],
					thinkingConfig: { thinkingLevel: "HIGH" },
				},
			},
			googleModel,
		);

		const [, appended, toolsChanged] = records(manager);
		expect(appended.classification).toBe("linear-append-or-retry");
		expect(appended.payload.sections.map((value) => value.key)).toEqual([
			"contents",
			"config.systemInstruction",
			"config.tools",
		]);
		expect(section(appended, "contents")).toMatchObject({ change: "appended" });
		expect(toolsChanged.classification).toBe("linear-prefix-break");
		expect(section(toolsChanged, "config.tools")).toMatchObject({ change: "appended" });
	});

	it("classifies compaction and model changes as explicit context transitions", () => {
		const manager = SessionManager.inMemory();
		const audit = new ProviderPayloadAudit(manager, true);
		const firstId = manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "first" }],
			timestamp: 1,
		});
		audit.record({ model: anthropicModel.id, messages: [{ role: "user", content: "first" }] }, anthropicModel);

		manager.appendCompaction("summary", firstId, 100);
		audit.record({ model: anthropicModel.id, messages: [{ role: "user", content: "compacted" }] }, anthropicModel);

		const openAiModel = {
			...anthropicModel,
			id: "gpt-test",
			provider: "openai",
			api: "openai-responses",
		} as Model<any>;
		audit.record({ model: openAiModel.id, input: [{ role: "user", content: "new model" }] }, openAiModel);

		const [, compacted, newModel] = records(manager);
		expect(compacted.classification).toBe("explicit-compaction");
		expect(compacted.latestCompactionEntryId).toEqual(expect.any(String));
		expect(compacted.sessionContext.change).toBe("rewritten");
		expect(newModel.classification).toBe("new-model-context");
	});

	it("does nothing when auditing is disabled", () => {
		const manager = SessionManager.inMemory();
		const audit = new ProviderPayloadAudit(manager, false);
		audit.record({ messages: [] }, anthropicModel);
		expect(records(manager)).toEqual([]);
	});
});

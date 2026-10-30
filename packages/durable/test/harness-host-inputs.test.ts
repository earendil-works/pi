import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Models,
	type SimpleStreamOptions,
	Type,
} from "@earendil-works/pi-ai";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type HarnessOptions,
	type HarnessSettings,
	MemoryStorage,
	type Registry,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { allEntries, textOf } from "./chat-support.ts";
import { context } from "./session-support.ts";

/** A `Models` whose only provider is a faux one answering every request with `text`. */
function answering(text: string): Models {
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText(text)])));
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}

async function open(
	options: Pick<HarnessOptions, "models" | "settings">,
	registry: Registry = createRegistry(),
): Promise<{ harness: Harness; root: Conversation }> {
	const harness = await Harness.open(new MemoryStorage(), { ...options, registry }, context);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	return { harness, root };
}

async function turn(root: Conversation, content: string): Promise<string | undefined> {
	const settled = await (await root.submit({ type: "input", content }, context)).wait(context);
	expect(settled.status).toBe("done");
	const entries = await allEntries(root);
	return textOf(entries.at(-1)?.model?.[0]);
}

describe("HarnessOptions.models and settings as functions", () => {
	it("generation uses the current return value of a models function at each request", async () => {
		let current = answering("first");
		const { harness, root } = await open({ models: () => current });
		expect(await turn(root, "one")).toBe("first");
		current = answering("second");
		expect(await turn(root, "two")).toBe("second");
		await harness.close(context);
	});

	it("still accepts a plain Models object", async () => {
		const { harness, root } = await open({ models: answering("plain") });
		expect(await turn(root, "one")).toBe("plain");
		await harness.close(context);
	});

	it("tools read the current models at each access of api.models", async () => {
		const first = createModels();
		const second = createModels();
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("probe", {}, { id: "call-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		first.setProvider(faux.provider);
		second.setProvider(faux.provider);
		// Marks the second Models: tools see views of the host's Models that add the Harness identity.
		second.setProvider(fauxProvider({ provider: "second-only" }).provider);
		let current = first;
		const seen: Models[] = [];
		const registry = createRegistry();
		registry.install(
			defineExtension({
				name: "probe",
				tools: [
					defineTool({
						name: "probe",
						description: "Records api.models before and after the host swaps it",
						parameters: Type.Object({}),
						execute: async (_args, api) => {
							seen.push(api.models);
							current = second;
							seen.push(api.models);
							return { output: [] };
						},
					}),
				],
			}),
		);
		const { harness, root } = await open({ models: () => current }, registry);
		expect(await turn(root, "go")).toBe("done");
		expect(seen[0]!.getProvider("second-only")).toBeUndefined();
		expect(seen[1]!.getProvider("second-only")).toBeDefined();
		await harness.close(context);
	});

	it("generation reads the current return value of a settings function", async () => {
		const timeouts: (number | undefined)[] = [];
		const faux = fauxProvider();
		const reply = (_request: unknown, options?: SimpleStreamOptions) => {
			timeouts.push(options?.timeoutMs);
			return fauxAssistantMessage([fauxText("ok")]);
		};
		faux.setResponses([reply, reply]);
		const models = createModels();
		models.setProvider(faux.provider);
		let settings: HarnessSettings = { stream: { timeoutMs: 1000 } };
		const { harness, root } = await open({ models, settings: () => settings });
		await turn(root, "one");
		settings = { stream: { timeoutMs: 2000 } };
		await turn(root, "two");
		expect(timeouts).toEqual([1000, 2000]);
		await harness.close(context);
	});
});

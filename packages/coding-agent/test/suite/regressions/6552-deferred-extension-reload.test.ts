import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { type RuntimeReloadCallbacks, RuntimeReloadError } from "../../../src/core/agent-session.ts";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../../src/core/extensions/loader.ts";
import type { ExtensionContext, ExtensionFactory, LoadExtensionsResult, ResourceLoader } from "../../../src/index.ts";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

async function createReloadingResourceLoader(factory: ExtensionFactory): Promise<{
	resourceLoader: ResourceLoader;
	getReloadCount: () => number;
}> {
	const eventBus = createEventBus();
	let reloadCount = 0;
	const load = async (): Promise<LoadExtensionsResult> => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(factory, process.cwd(), eventBus, runtime);
		return { extensions: [extension], errors: [], runtime };
	};
	let extensionsResult = await load();
	return {
		resourceLoader: {
			getExtensions: () => extensionsResult,
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {
				reloadCount++;
				extensionsResult = await load();
			},
		},
		getReloadCount: () => reloadCount,
	};
}

const reloadHooks = (beforeReload?: () => void): RuntimeReloadCallbacks => ({ beforeReload });

describe("issue #6552 deferred extension reload", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("defers and coalesces tool requests until the agent settles", async () => {
		const events: string[] = [];
		const { resourceLoader, getReloadCount } = await createReloadingResourceLoader((pi) => {
			pi.on("agent_settled", () => {
				events.push("settled");
			});
			pi.on("session_shutdown", () => {
				events.push("shutdown");
			});
			pi.registerTool({
				name: "reload_runtime",
				label: "Reload runtime",
				description: "Request a runtime reload",
				parameters: Type.Object({}),
				async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
					events.push("tool");
					ctx.requestReload();
					ctx.requestReload();
					return { content: [{ type: "text", text: "reload requested" }], details: {} };
				},
			});
		});
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		await harness.session.bindExtensions({
			reloadHooks: reloadHooks(() => {
				events.push("reload");
			}),
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("reload_runtime", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("turn complete"),
		]);

		await harness.session.prompt("reload extensions");

		expect(getAssistantTexts(harness)).toContain("turn complete");
		expect(getReloadCount()).toBe(1);
		expect(events).toEqual(["tool", "settled", "reload", "shutdown"]);
	});

	it("reloads after a command handler without model authentication", async () => {
		const { resourceLoader, getReloadCount } = await createReloadingResourceLoader((pi) => {
			pi.registerCommand("reload-runtime", {
				description: "Reload runtime",
				handler: async (_args, ctx) => {
					ctx.requestReload();
				},
			});
		});
		const harness = await createHarness({ resourceLoader, withConfiguredAuth: false });
		harnesses.push(harness);
		await harness.session.bindExtensions({ reloadHooks: reloadHooks() });

		await expect(harness.session.prompt("/reload-runtime")).resolves.toBeUndefined();
		expect(getReloadCount()).toBe(1);
	});

	it("ignores requests from reload lifecycle handlers", async () => {
		const { resourceLoader, getReloadCount } = await createReloadingResourceLoader((pi) => {
			pi.on("session_start", (_event, ctx) => ctx.requestReload());
		});
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		let hostReloadCount = 0;

		await harness.session.bindExtensions({
			reloadHooks: reloadHooks(() => {
				hostReloadCount++;
			}),
		});

		expect(hostReloadCount).toBe(1);
		expect(getReloadCount()).toBe(1);
	});

	it("flushes a request after manual compaction clears its controller", async () => {
		const { resourceLoader, getReloadCount } = await createReloadingResourceLoader((pi) => {
			pi.on("session_before_compact", (event, ctx) => {
				ctx.requestReload();
				return {
					compaction: {
						summary: "summary from extension",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				};
			});
		});
		const harness = await createHarness({ resourceLoader, settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		await harness.session.bindExtensions({ reloadHooks: reloadHooks() });
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		await harness.session.compact();

		expect(getReloadCount()).toBe(1);
	});

	it("flushes a request after branch summarization clears its controller", async () => {
		const { resourceLoader, getReloadCount } = await createReloadingResourceLoader((pi) => {
			pi.on("session_before_tree", (_event, ctx) => {
				ctx.requestReload();
				return { summary: { summary: "summary from extension" } };
			});
		});
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		await harness.session.bindExtensions({ reloadHooks: reloadHooks() });
		const targetId = harness.sessionManager.appendMessage(userMsg("first branch"));
		harness.sessionManager.appendMessage(assistantMsg("first reply"));
		harness.sessionManager.appendMessage(userMsg("abandoned work"));
		harness.sessionManager.appendMessage(assistantMsg("abandoned reply"));

		await harness.session.navigateTree(targetId, { summarize: true });

		expect(getReloadCount()).toBe(1);
	});

	it("rejects direct reload while an extension operation is active", async () => {
		const { resourceLoader, getReloadCount } = await createReloadingResourceLoader(() => {});
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		let releaseOperation = () => {};
		const operationReleased = new Promise<void>((resolve) => {
			releaseOperation = resolve;
		});
		const operation = harness.session.extensionRunner.runExtensionOperation(() => operationReleased);

		await expect(harness.session.reload()).rejects.toThrow("Cannot reload while a runtime operation is active");
		expect(getReloadCount()).toBe(0);
		releaseOperation();
		await operation;
	});

	it("makes post-invalidation failures terminal for reload admission", async () => {
		let oldContext: ExtensionContext | undefined;
		const { resourceLoader } = await createReloadingResourceLoader((pi) => {
			pi.on("input", (_event, ctx) => {
				oldContext = ctx;
				ctx.requestReload();
				return { action: "handled" };
			});
		});
		resourceLoader.reload = async () => {
			throw new Error("resource reload failed");
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		await harness.session.bindExtensions({ reloadHooks: reloadHooks() });

		await expect(harness.session.prompt("reload")).rejects.toBeInstanceOf(RuntimeReloadError);
		expect(() => oldContext?.isIdle()).toThrow("stale after session replacement or reload");
		await expect(harness.session.reload()).rejects.toBeInstanceOf(RuntimeReloadError);
	});

	it("ignores requests when the host does not support reload", async () => {
		const { resourceLoader, getReloadCount } = await createReloadingResourceLoader((pi) => {
			pi.on("input", (_event, ctx) => {
				ctx.requestReload();
				return { action: "handled" };
			});
		});
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "print" });

		await harness.session.prompt("ignored reload");
		expect(getReloadCount()).toBe(0);
	});
});

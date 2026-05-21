import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel, type RawProviderPayload } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionEvent } from "../src/core/extensions/index.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import type { ExtensionFactory } from "../src/core/sdk.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("createAgentSession provider raw events", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-provider-raw-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(extensionFactories: ExtensionFactory[]) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			authStorage,
			resourceLoader,
		});
		await session.bindExtensions({});
		return session;
	}

	it("emits raw request, chunk, and end events to extensions", async () => {
		const events: ExtensionEvent[] = [];
		const session = await createSession([
			(pi) => {
				pi.on("before_provider_raw_request", (event) => {
					events.push(event);
				});
				pi.on("provider_raw_response_chunk", (event) => {
					events.push(event);
				});
				pi.on("provider_raw_response_end", (event) => {
					events.push(event);
				});
			},
		]);
		const model = session.model!;
		const payload: RawProviderPayload = {
			provider: "anthropic",
			api: "anthropic-messages",
			model: "claude-sonnet-4-5",
			requestId: "req_raw",
			status: 200,
			headers: { "request-id": "req_raw" },
			index: 0,
			raw: { provider: "raw" },
			timestamp: 123,
		};

		await session.agent.onRawRequestBody?.(payload, model);
		await session.agent.onRawResponseChunk?.({ ...payload, index: 1 }, model);
		await session.agent.onRawResponseEnd?.({ ...payload, index: 2, raw: { done: true } }, model);

		expect(events.map((event) => event.type)).toEqual([
			"before_provider_raw_request",
			"provider_raw_response_chunk",
			"provider_raw_response_end",
		]);
		expect(events[1]).toMatchObject({ requestId: "req_raw", index: 1, raw: { provider: "raw" } });

		session.dispose();
	});
});

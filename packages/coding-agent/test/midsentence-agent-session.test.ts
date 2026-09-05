/**
 * Integration tests: mid-sentence expansion flows through AgentSession
 * prompt/steer/followUp with a mocked streamFn.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { PromptTemplate } from "../src/core/prompt-templates.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") throw event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const SKILL_BODY = "Run the full build checks.";

describe("AgentSession mid-sentence expansion", () => {
	let session: AgentSession;
	let tempDir: string;
	let userTexts: string[];
	let lastQueue: { steering: string[]; followUp: string[] };

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-midsentence-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		userTexts = [];
		lastQueue = { steering: [], followUp: [] };
	});

	afterEach(() => {
		if (session) session.dispose();
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(loader: ResourceLoader): Promise<AgentSession> {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const msg = createAssistantMessage("ok");
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});

		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: loader,
		});

		session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "user") {
				const content = event.message.content;
				if (Array.isArray(content)) {
					for (const part of content) {
						if (part.type === "text") userTexts.push(part.text);
					}
				}
			}
			if (event.type === "queue_update") {
				lastQueue = { steering: [...event.steering], followUp: [...event.followUp] };
			}
		});
		return session;
	}

	function loaderWith(skillSpecs: Array<{ name: string; body: string }>, templates: PromptTemplate[]): ResourceLoader {
		const skillDir = join(tempDir, "skills");
		mkdirSync(skillDir, { recursive: true });
		const skills = skillSpecs.map(({ name, body }) => {
			const filePath = join(skillDir, name, "SKILL.md");
			mkdirSync(join(skillDir, name), { recursive: true });
			writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name} description\n---\n${body}`);
			return {
				name,
				description: `${name} description`,
				filePath,
				baseDir: join(skillDir, name),
				sourceInfo: {
					path: filePath,
					source: "local",
					scope: "temporary" as const,
					origin: "top-level" as const,
				},
				disableModelInvocation: false,
			};
		});
		return {
			...createTestResourceLoader(),
			getSkills: () => ({ skills, diagnostics: [] }),
			getPrompts: () => ({ prompts: templates, diagnostics: [] }),
		} as ResourceLoader;
	}

	function template(name: string, content: string): PromptTemplate {
		return {
			name,
			description: `${name} description`,
			content,
			sourceInfo: {
				path: `/prompts/${name}.md`,
				source: "local",
				scope: "temporary" as const,
				origin: "top-level" as const,
			},
			filePath: `/prompts/${name}.md`,
		};
	}

	it("prompt() expands a mid-sentence skill token and delivers the block to the model", async () => {
		const s = await createSession(loaderWith([{ name: "verify-build", body: SKILL_BODY }], []));
		await s.prompt("please run\n/verify-build on this branch");
		expect(userTexts[0]).toContain("please run");
		expect(userTexts[0]).toContain('<skill name="verify-build"');
		expect(userTexts[0]).toContain(SKILL_BODY);
		expect(userTexts[0]).toContain("on this branch");
	});

	it("prompt() expands a single-line mid-sentence token (PR example shape)", async () => {
		const s = await createSession(loaderWith([{ name: "verify-build", body: SKILL_BODY }], []));
		await s.prompt("can you check the build please run /verify-build on the current branch and summarize");
		expect(userTexts[0]).toContain('can you check the build please run <skill name="verify-build"');
		expect(userTexts[0]).toContain("on the current branch and summarize");
	});

	it("prompt() expands a mid-sentence prompt template with args", async () => {
		const s = await createSession(loaderWith([], [template("review", "Review this: $ARGUMENTS")]));
		await s.prompt("header\nthen /review the code please");
		expect(userTexts[0]).toBe("header\nthen Review this: the code please");
	});

	it("multiple mid-sentence tokens all expand in position order", async () => {
		const s = await createSession(
			loaderWith([{ name: "verify-build", body: SKILL_BODY }], [template("review", "R: $ARGUMENTS")]),
		);
		await s.prompt("h\nfirst /review the code\nthen /verify-build now");
		const posA = userTexts[0].indexOf("R: the code");
		const posB = userTexts[0].indexOf('<skill name="verify-build"');
		expect(posA).toBeGreaterThan(-1);
		expect(posB).toBeGreaterThan(posA);
	});

	it("native line-1 expansion is unchanged by mid-sentence support", async () => {
		const s = await createSession(
			loaderWith([{ name: "verify-build", body: SKILL_BODY }], [template("review", "R: $ARGUMENTS")]),
		);
		await s.prompt("/skill:verify-build now");
		expect(userTexts[0]).toBe(
			`<skill name="verify-build" location="${join(tempDir, "skills", "verify-build", "SKILL.md")}">\nReferences are relative to ${join(tempDir, "skills", "verify-build")}.\n\n${SKILL_BODY}\n</skill>\n\nnow`,
		);
		await s.prompt("/review the code");
		expect(userTexts[1]).toBe("R: the code");
	});

	it("expandPromptTemplates: false disables mid-sentence expansion", async () => {
		const s = await createSession(loaderWith([{ name: "verify-build", body: SKILL_BODY }], []));
		await s.prompt("please run\n/verify-build now", { expandPromptTemplates: false });
		expect(userTexts[0]).toBe("please run\n/verify-build now");
	});

	it("steer() expands mid-sentence tokens before queuing", async () => {
		const s = await createSession(loaderWith([{ name: "verify-build", body: SKILL_BODY }], []));
		await s.steer("please run\n/verify-build now");
		expect(lastQueue.steering).toHaveLength(1);
		expect(lastQueue.steering[0]).toContain('<skill name="verify-build"');
		expect(lastQueue.steering[0]).toContain("now");
	});

	it("followUp() expands mid-sentence tokens before queuing", async () => {
		const s = await createSession(loaderWith([{ name: "verify-build", body: SKILL_BODY }], []));
		await s.followUp("please run\n/verify-build now");
		expect(lastQueue.followUp).toHaveLength(1);
		expect(lastQueue.followUp[0]).toContain('<skill name="verify-build"');
		expect(lastQueue.followUp[0]).toContain("now");
	});
});

import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { expandPromptTemplate } from "../../src/core/prompt-templates.js";
import {
	bashTool,
	bashToolDefinition,
	buildWorkflowEnvironmentSnapshot,
	CURRENT_SESSION_VERSION,
	emptySessionLogSnapshot,
	initializeWorkflowState,
	readToolDefinition,
	SessionManager,
	type WorkflowToolSnapshot,
} from "../../src/index.js";

describe("emptySessionLogSnapshot", () => {
	it("returns a valid empty snapshot with defaults", () => {
		const snapshot = emptySessionLogSnapshot();
		expect(snapshot.header.type).toBe("session");
		expect(snapshot.header.version).toBe(CURRENT_SESSION_VERSION);
		expect(snapshot.header.id).toBeTruthy();
		expect(snapshot.header.id).not.toBe("");
		expect(snapshot.header.cwd).toBe(process.cwd());
		expect(snapshot.header.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(snapshot.entries).toEqual([]);
		expect(snapshot.leafId).toBeNull();
	});

	it("respects custom options", () => {
		const snapshot = emptySessionLogSnapshot({
			cwd: "/tmp/custom",
			sessionId: "fixed-id",
			timestamp: "2025-01-01T00:00:00.000Z",
		});
		expect(snapshot.header.id).toBe("fixed-id");
		expect(snapshot.header.cwd).toBe("/tmp/custom");
		expect(snapshot.header.timestamp).toBe("2025-01-01T00:00:00.000Z");
	});

	it("round-trips through SessionManager.fromSnapshot", () => {
		const snapshot = emptySessionLogSnapshot({ cwd: "/tmp/roundtrip" });
		const manager = SessionManager.fromSnapshot(snapshot);
		expect(manager.getCwd()).toBe("/tmp/roundtrip");
		expect(manager.getSessionId()).toBe(snapshot.header.id);
		expect(manager.getEntries()).toEqual([]);
		expect(manager.toSnapshot()).toEqual(snapshot);
	});
});

describe("buildWorkflowEnvironmentSnapshot", () => {
	it("returns a minimal snapshot with sensible defaults", () => {
		const snapshot = buildWorkflowEnvironmentSnapshot({ systemPrompt: "hello" });
		expect(snapshot.cwd).toBe(process.cwd());
		expect(snapshot.systemPrompt).toBe("hello");
		expect(snapshot.tools).toEqual([]);
		expect(snapshot.activeToolNames).toEqual([]);
		expect(snapshot.skills).toEqual([]);
		expect(snapshot.promptTemplates).toEqual([]);
		expect(snapshot.agentsFiles).toEqual([]);
		expect(snapshot.model).toBeUndefined();
		expect(snapshot.settings).toBeUndefined();
	});

	it("resolves builtin tools by string name", () => {
		const snapshot = buildWorkflowEnvironmentSnapshot({
			systemPrompt: "s",
			builtinTools: ["read", "bash"],
		});
		expect(snapshot.tools.map((t) => t.name)).toEqual(["read", "bash"]);
		const read = snapshot.tools[0];
		expect(read.label).toBe(readToolDefinition.label);
		expect(read.description).toBe(readToolDefinition.description);
		expect(JSON.parse(JSON.stringify(read.parameters))).toEqual(
			JSON.parse(JSON.stringify(readToolDefinition.parameters)),
		);
	});

	it("resolves builtin tools by Tool instance", () => {
		const snapshot = buildWorkflowEnvironmentSnapshot({
			systemPrompt: "s",
			builtinTools: [bashTool],
		});
		expect(snapshot.tools).toHaveLength(1);
		expect(snapshot.tools[0].name).toBe("bash");
		expect(snapshot.tools[0].label).toBe(bashToolDefinition.label);
	});

	it("throws on unknown builtin tool name", () => {
		expect(() =>
			buildWorkflowEnvironmentSnapshot({
				systemPrompt: "s",
				builtinTools: ["does-not-exist" as unknown as "read"],
			}),
		).toThrow(/Unknown builtin tool/);
	});

	it("includes custom tools and deep-clones parameters", () => {
		const customParams = Type.Object({ q: Type.String() });
		const custom: WorkflowToolSnapshot = {
			name: "my-tool",
			label: "My Tool",
			description: "custom",
			parameters: customParams,
			promptGuidelines: ["be nice"],
		};
		const snapshot = buildWorkflowEnvironmentSnapshot({
			systemPrompt: "s",
			builtinTools: ["read"],
			customTools: [custom],
		});
		expect(snapshot.tools.map((t) => t.name)).toEqual(["read", "my-tool"]);
		expect(snapshot.tools[1].parameters).not.toBe(customParams);
		expect(JSON.parse(JSON.stringify(snapshot.tools[1].parameters))).toEqual(
			JSON.parse(JSON.stringify(customParams)),
		);
		expect(snapshot.tools[1].promptGuidelines).not.toBe(custom.promptGuidelines);
	});

	it("throws when builtin and custom tools share a name", () => {
		expect(() =>
			buildWorkflowEnvironmentSnapshot({
				systemPrompt: "s",
				builtinTools: ["read"],
				customTools: [
					{
						name: "read",
						label: "Read",
						description: "conflict",
						parameters: Type.Object({}),
					},
				],
			}),
		).toThrow(/Duplicate tool name/);
	});

	it("synthesizes skill sourceInfo and passes content through verbatim", () => {
		const snapshot = buildWorkflowEnvironmentSnapshot({
			systemPrompt: "s",
			skills: [
				{
					name: "my-skill",
					description: "does a thing",
					content: "body without frontmatter",
				},
			],
		});
		expect(snapshot.skills).toHaveLength(1);
		const skill = snapshot.skills![0];
		expect(skill.name).toBe("my-skill");
		expect(skill.content).toBe("body without frontmatter");
		expect(skill.location).toBe("<in-memory>/skills/my-skill.md");
		expect(skill.baseDir).toBe("<in-memory>");
		expect(skill.sourceInfo.source).toBe("in-memory");
		expect(skill.sourceInfo.scope).toBe("temporary");
		expect(skill.disableModelInvocation).toBe(false);
	});

	it("respects explicit skill location/baseDir", () => {
		const snapshot = buildWorkflowEnvironmentSnapshot({
			systemPrompt: "s",
			skills: [
				{
					name: "s1",
					description: "d",
					content: "c",
					location: "/abs/s1.md",
					baseDir: "/abs",
					disableModelInvocation: true,
				},
			],
		});
		const skill = snapshot.skills![0];
		expect(skill.location).toBe("/abs/s1.md");
		expect(skill.baseDir).toBe("/abs");
		expect(skill.disableModelInvocation).toBe(true);
	});

	it("synthesizes prompt templates and keeps them usable by expandPromptTemplate", () => {
		const snapshot = buildWorkflowEnvironmentSnapshot({
			systemPrompt: "s",
			promptTemplates: [{ name: "greet", content: "hello $1" }],
		});
		expect(snapshot.promptTemplates).toHaveLength(1);
		const tmpl = snapshot.promptTemplates![0];
		expect(tmpl.name).toBe("greet");
		expect(tmpl.filePath).toBe("<in-memory>/prompts/greet.md");
		expect(tmpl.sourceInfo.source).toBe("in-memory");
		expect(expandPromptTemplate("/greet world", snapshot.promptTemplates!)).toBe("hello world");
	});

	it("defaults activeToolNames to all provided tool names in order", () => {
		const snapshot = buildWorkflowEnvironmentSnapshot({
			systemPrompt: "s",
			builtinTools: ["bash", "read"],
			customTools: [{ name: "zzz", label: "Z", description: "", parameters: Type.Object({}) }],
		});
		expect(snapshot.activeToolNames).toEqual(["bash", "read", "zzz"]);
	});

	it("accepts explicit activeToolNames override", () => {
		const snapshot = buildWorkflowEnvironmentSnapshot({
			systemPrompt: "s",
			builtinTools: ["read", "bash"],
			activeToolNames: ["read"],
		});
		expect(snapshot.activeToolNames).toEqual(["read"]);
	});

	it("deep-clones agentsFiles and appendSystemPrompt", () => {
		const agentsFiles = [{ path: "AGENTS.md", content: "# rules" }];
		const appendSystemPrompt = ["extra"];
		const snapshot = buildWorkflowEnvironmentSnapshot({
			systemPrompt: "s",
			agentsFiles,
			appendSystemPrompt,
		});
		expect(snapshot.agentsFiles).toEqual(agentsFiles);
		expect(snapshot.agentsFiles).not.toBe(agentsFiles);
		expect(snapshot.appendSystemPrompt).toEqual(appendSystemPrompt);
		expect(snapshot.appendSystemPrompt).not.toBe(appendSystemPrompt);
	});
});

describe("buildWorkflowEnvironmentSnapshot + emptySessionLogSnapshot end-to-end", () => {
	it("feeds initializeWorkflowState without booting a runtime", async () => {
		const environment = buildWorkflowEnvironmentSnapshot({ systemPrompt: "be brief" });
		const sessionLog = emptySessionLogSnapshot();
		const state = await initializeWorkflowState("hi", environment, sessionLog);
		expect(state.sessionId).toBe(sessionLog.header.id);
		expect(state.phase).toBeDefined();
		expect(state.environment.systemPrompt).toBe("be brief");
	});
});

import { Type } from "@earendil-works/pi-ai";
import {
	type AgentState,
	CompactionTask,
	createRegistry,
	defineExtension,
	defineTask,
	GenerationTask,
	type HarnessSettings,
	hook,
	type RegistrySnapshot,
	section,
	type ToolRegistration,
	ToolTask,
	wrapSection,
	wrapTool,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { agentHooks, resolveAgent, resolveSettings } from "../src/harness/agent.ts";
import { context } from "./session-support.ts";

type AppTool = ToolRegistration & { readonly snippet?: string };

function tool(name: string, extra: Partial<AppTool> = {}): AppTool {
	return {
		name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [] }),
		...extra,
	};
}

function task(name: string, version = 1) {
	return defineTask<undefined, { phase: "run" }, null>({
		name,
		version,
		initial: () => ({ phase: "run" }),
		phases: { run: async () => {} },
		abort: async () => {},
	});
}

function names(items: readonly { readonly name: string }[]): string[] {
	return items.map((item) => item.name);
}

/** Resolve `state` against `snapshot` and `settings`, collecting reports. */
function resolve(
	state: AgentState | undefined,
	snapshot: RegistrySnapshot<AppTool>,
	settings: HarnessSettings = {},
	reports: unknown[] = [],
) {
	return resolveAgent(state, snapshot, resolveSettings(settings), (error) => reports.push(error));
}

async function rendered(agent: ReturnType<typeof resolve>): Promise<[string, string | undefined][]> {
	const input = {
		conversationId: 1 as never,
		agent,
		env: undefined,
		shown: {},
		read: { snapshot: async () => undefined, snapshotAsOf: async () => undefined },
	};
	return Promise.all(
		agent.sections.map(async (item) => [item.key, await item.render(input, context)] as [string, string | undefined]),
	);
}

describe("registry", () => {
	it("installs, replaces in place, and uninstalls extensions by name", () => {
		const registry = createRegistry<AppTool>();
		const listener: string[] = [];
		registry.subscribe(() => listener.push(names(registry.snapshot().installed()).join(",")));
		const a = defineExtension<AppTool>({ name: "a", tools: [tool("read", { snippet: "Read files" })] });
		const b = defineExtension<AppTool>({ name: "b", tools: [tool("read"), tool("bash")] });
		registry.install(a);
		registry.install(b);
		const before = registry.snapshot();
		// A new object with an installed name replaces it at its position.
		const a2 = defineExtension<AppTool>({ name: "a", tools: [tool("grep")] });
		registry.install(a2);
		expect(names(registry.snapshot().installed())).toEqual(["a", "b"]);
		expect(registry.snapshot().extension("a")).toBe(a2);
		expect(
			registry
				.snapshot()
				.tools()
				.map(({ extension, tool }) => `${tool.name}@${extension.name}`),
		).toEqual(["grep@a", "read@b", "bash@b"]);
		// Old snapshots stay as they were.
		expect(before.extension("a")).toBe(a);
		expect(before.tools()[0]!.tool.snippet).toBe("Read files");
		// Uninstall matches the name, whichever object; a later install appends.
		registry.uninstall(a);
		registry.uninstall(a);
		expect(names(registry.snapshot().installed())).toEqual(["b"]);
		registry.install(a);
		expect(names(registry.snapshot().installed())).toEqual(["b", "a"]);
		expect(listener).toEqual(["a", "a,b", "a,b", "b", "b,a"]);
	});

	it("validates the registry as it would be after an install and publishes nothing when invalid", () => {
		const registry = createRegistry();
		const Tasks = defineExtension({ name: "tasks", tasks: [task("app.index")] });
		registry.install(Tasks);
		const published: number[] = [];
		registry.subscribe(() => published.push(1));
		const before = registry.snapshot();
		const invalid = [
			[defineExtension({ name: "x", tools: [tool("read"), tool("read")] }), "two tools named read"],
			[defineExtension({ name: "x", sections: [section("a", () => "1"), section("a", () => "2")] }), "two sections"],
			[defineExtension({ name: "x", sections: [section("Bad Key", () => "")] }), "must match"],
			[defineExtension({ name: "x", sections: [section("instructions", () => "")] }), "reserved"],
			[defineExtension({ name: "x", tasks: [task("pi.generation")] }), "already installed"],
			[defineExtension({ name: "x", tasks: [task("app.index")] }), "already installed"],
		] as const;
		for (const [extension, message] of invalid) expect(() => registry.install(extension)).toThrow(message);
		expect(registry.snapshot()).toBe(before);
		expect(published).toEqual([]);
		// Replacing the extension that holds a task name is valid: the check runs on the state after replacement.
		registry.install(defineExtension({ name: "tasks", tasks: [task("app.index", 2)] }));
		expect(registry.snapshot().task("app.index")?.definition.version).toBe(2);
	});

	it("always holds the built-in tasks, which are not an extension", () => {
		const registry = createRegistry();
		expect(registry.snapshot().installed()).toEqual([]);
		expect(registry.snapshot().tasks()).toEqual([GenerationTask, ToolTask, CompactionTask]);
		const custom = task("app.custom");
		registry.install(defineExtension({ name: "custom", tasks: [custom] }));
		expect(registry.snapshot().tasks()).toEqual([GenerationTask, ToolTask, CompactionTask, custom]);
		expect(registry.snapshot().task("app.custom")).toBe(custom);
		registry.uninstall(defineExtension({ name: "custom" }));
		expect(registry.snapshot().task("app.custom")).toBeUndefined();
	});
});

describe("agent resolution", () => {
	const read = tool("read");
	const bash = tool("bash");
	const edit = tool("edit");
	const Coding = defineExtension<AppTool>({
		name: "coding",
		tools: [read, bash, edit],
		sections: [section("preamble", () => "You code.", { tag: false }), section("cwd", () => "/repo")],
	});
	const Skills = defineExtension<AppTool>({ name: "skills", sections: [section("skills", () => "S")] });
	const Reviewer = defineExtension<AppTool>({ name: "reviewer", sections: [section("role", () => "Review.")] });
	const registry = createRegistry<AppTool>();
	for (const extension of [Coding, Skills, Reviewer]) registry.install(extension);
	const snapshot = registry.snapshot();

	it("selects the default, an array, or the default edited by add and remove", () => {
		expect(names(resolve(undefined, snapshot).extensions)).toEqual(["coding", "skills", "reviewer"]);
		const settings = { extensions: [Coding, Skills] };
		expect(names(resolve({}, snapshot, settings).extensions)).toEqual(["coding", "skills"]);
		expect(names(resolve({ extensions: ["reviewer", "coding"] }, snapshot, settings).extensions)).toEqual([
			"reviewer",
			"coding",
		]);
		// Add appends, remove drops, duplicates keep their first position, uninstalled names are skipped.
		const edited = { extensions: { add: ["reviewer", "coding", "gone"], remove: ["skills"] } };
		expect(names(resolve(edited, snapshot, settings).extensions)).toEqual(["coding", "reviewer"]);
		// An old object stands for its name: the installed extension is selected.
		const stale = { extensions: [defineExtension({ name: "skills" }), Skills] };
		expect(resolve({}, snapshot, stale).extensions).toEqual([Skills]);
	});

	it("skips uninstalled names and resolves them again once they are installed", () => {
		const local = createRegistry<AppTool>();
		local.install(Coding);
		const state: AgentState = { extensions: ["coding", "skills"] };
		expect(names(resolve(state, local.snapshot()).extensions)).toEqual(["coding"]);
		local.install(Skills);
		expect(names(resolve(state, local.snapshot()).extensions)).toEqual(["coding", "skills"]);
	});

	it("replaces same-name tools in place, wraps the winner, then applies the filter", () => {
		const local = createRegistry<AppTool>();
		const venvBash = tool("bash", { description: "venv bash" });
		const calls: string[] = [];
		const Venv = defineExtension<AppTool>({ name: "venv", tools: [venvBash] });
		const Timing = defineExtension<AppTool>({
			name: "timing",
			wraps: [
				wrapTool(bash, (inner) => ({ ...inner, description: `${inner.description} (timed)` })),
				wrapTool(bash, (inner) => ({ ...inner, description: `${inner.description} [2]` })),
				// No `grep` is selected: the wrapper does nothing and reports nothing.
				wrapTool(tool("grep"), () => {
					calls.push("grep");
					return tool("grep");
				}),
			],
		});
		for (const extension of [Coding, Venv, Timing]) local.install(extension);
		const reports: unknown[] = [];
		const agent = resolve(undefined, local.snapshot(), {}, reports);
		expect(agent.tools.map((each) => [each.name, each.description])).toEqual([
			["read", "read tool"],
			["bash", "venv bash (timed) [2]"],
			["edit", "edit tool"],
		]);
		expect(reports).toEqual([]);
		expect(calls).toEqual([]);

		// An array keeps exactly these names in its order, a repeated name at its first position.
		const filtered = resolve({ tools: ["edit", "missing", "read", "edit"] }, local.snapshot());
		expect(names(filtered.tools)).toEqual(["edit", "read"]);
		expect(names(resolve({ tools: { remove: ["bash"] } }, local.snapshot()).tools)).toEqual(["read", "edit"]);
	});

	it("drops a tool or section whose wrapper throws or renames it and reports the failure", () => {
		const local = createRegistry<AppTool>();
		const Broken = defineExtension<AppTool>({
			name: "broken",
			wraps: [
				wrapTool(read, () => {
					throw new Error("wrapper failed");
				}),
				wrapTool(edit, (inner) => ({ ...inner, name: "renamed" })),
				wrapSection("cwd", () => {
					throw new Error("section wrapper failed");
				}),
			],
		});
		local.install(Coding);
		local.install(Broken);
		const reports: unknown[] = [];
		const agent = resolve(undefined, local.snapshot(), {}, reports);
		expect(names(agent.tools)).toEqual(["bash"]);
		expect(agent.sections.map((each) => each.key)).toEqual(["preamble"]);
		expect(reports.map((error) => (error as Error).message)).toEqual([
			"wrapper failed",
			"Wrapper renamed edit to renamed",
			"section wrapper failed",
		]);
	});

	it("orders sections by extension, replaces same keys in place, and renders instructions last and unwrapped", async () => {
		const local = createRegistry<AppTool>();
		const Override = defineExtension<AppTool>({
			name: "override",
			sections: [section("preamble", () => "You review.", { tag: false })],
			wraps: [
				wrapSection("cwd", (inner) => ({
					...inner,
					render: async (input, ctx) => `${await inner.render(input, ctx)}!`,
				})),
				// Instructions are not wrapped.
				wrapSection("instructions", () => {
					throw new Error("never");
				}),
			],
		});
		for (const extension of [Coding, Skills, Override]) local.install(extension);
		const reports: unknown[] = [];
		const agent = resolve({ instructions: "Be terse." }, local.snapshot(), {}, reports);
		expect(await rendered(agent)).toEqual([
			["preamble", "You review."],
			["cwd", "/repo!"],
			["skills", "S"],
			["instructions", "Be terse."],
		]);
		expect(agent.sections.at(-1)!.tag).toBeUndefined();
		expect(reports).toEqual([]);
	});

	it("collects hooks of the selected extensions in extension order and applies field defaults", () => {
		const local = createRegistry<AppTool>();
		const first = { beforeTool: () => undefined };
		const second = { beforeTool: () => undefined };
		const onYield = { onYield: () => undefined };
		local.install(
			defineExtension<AppTool>({ name: "a", hooks: [hook(ToolTask, first), hook(GenerationTask, onYield)] }),
		);
		local.install(defineExtension<AppTool>({ name: "b", hooks: [hook(ToolTask, second)] }));
		expect(agentHooks(resolve(undefined, local.snapshot()), "pi.tool")).toEqual([first, second]);
		expect(agentHooks(resolve({ extensions: ["b", "a"] }, local.snapshot()), "pi.tool")).toEqual([second, first]);
		expect(agentHooks(resolve({ extensions: ["b"] }, local.snapshot()), "pi.generation")).toEqual([]);

		const defaults = resolve(undefined, local.snapshot());
		expect(defaults.model).toBeUndefined();
		expect(defaults.thinkingLevel).toBe("off");
		expect(defaults.cwd).toBeUndefined();
		expect(
			resolve({ model: { provider: "p", modelId: "m" }, thinkingLevel: "high", cwd: "/w" }, local.snapshot()),
		).toMatchObject({ model: { provider: "p", modelId: "m" }, thinkingLevel: "high", cwd: "/w" });
	});
});

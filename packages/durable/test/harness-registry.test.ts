import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	CompactionTask,
	createRegistry,
	defineTask,
	GenerationTask,
	type ToolRegistration,
	ToolTask,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

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

function task(name: string) {
	const hooks: { beforeRun(): void } = { beforeRun: () => {} };
	return defineTask<undefined, { phase: "run" }, null, { beforeRun(): void }>({
		name,
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: { run: async () => {} },
		abort: async () => {},
		hooks,
	});
}

function names(tools: readonly { readonly name: string }[]): string[] {
	return tools.map((entry) => entry.name);
}

describe("registry", () => {
	it("adds, lists, and disposes tools by exact token", () => {
		const registry = createRegistry<AppTool>();
		const read = registry.tools.add(tool("read", { snippet: "Read files" }));
		registry.tools.add(tool("bash"));
		expect(names(registry.tools.list())).toEqual(["read", "bash"]);
		expect(registry.tools.list()[0]!.snippet).toBe("Read files");
		expect(() => registry.tools.add(tool("read"))).toThrow("Tool read is already registered");

		read.dispose();
		read.dispose();
		expect(names(registry.tools.list())).toEqual(["bash"]);
	});

	it("keeps the original position of a re-registered key and appends new keys", () => {
		const registry = createRegistry();
		const a = registry.tools.add(tool("a"));
		registry.tools.add(tool("b"));
		a.dispose();
		registry.tools.add(tool("c"));
		registry.tools.add(tool("a"));
		expect(names(registry.tools.list())).toEqual(["a", "b", "c"]);

		const first = registry.systemPrompt.section("first", () => "1");
		registry.systemPrompt.section("second", () => "2");
		registry.batch(() => {
			first.dispose();
			registry.systemPrompt.section("third", () => "3");
			registry.systemPrompt.section("first", () => "1b");
		});
		expect(registry.systemPrompt.sections().map((section) => section.key)).toEqual(["first", "second", "third"]);
	});

	it("publishes a batch at once and validates only its final state", () => {
		const registry = createRegistry();
		const old = registry.tools.add(tool("grep"));
		const replacement = registry.batch(() => {
			registry.tools.add(tool("grep", { description: "v2" }));
			registry.tools.add(tool("find"));
			old.dispose();
		});
		expect(registry.tools.list().map((entry) => [entry.name, entry.description])).toEqual([
			["grep", "v2"],
			["find", "find tool"],
		]);
		replacement.dispose();
		expect(registry.tools.list()).toEqual([]);
	});

	it("rolls back staged registrations and disposals when a batch fails", () => {
		const registry = createRegistry();
		const kept = registry.tools.add(tool("kept"));
		let staged: ReturnType<typeof registry.tools.add> | undefined;
		expect(() =>
			registry.batch(() => {
				kept.dispose();
				staged = registry.tools.add(tool("new"));
				throw new Error("activation failed");
			}),
		).toThrow("activation failed");
		expect(names(registry.tools.list())).toEqual(["kept"]);
		staged!.dispose();
		expect(names(registry.tools.list())).toEqual(["kept"]);

		expect(() =>
			registry.batch(() => {
				registry.tools.add(tool("dup"));
				registry.tools.add(tool("dup"));
			}),
		).toThrow("Tool dup is already registered");
		expect(names(registry.tools.list())).toEqual(["kept"]);

		expect(() =>
			registry.batch((async () => {
				registry.tools.add(tool("async"));
			}) as unknown as () => void),
		).toThrow("must be synchronous");
		expect(names(registry.tools.list())).toEqual(["kept"]);
		kept.dispose();
		expect(registry.tools.list()).toEqual([]);
	});

	it("rejects nested batches as a programming error", () => {
		const registry = createRegistry();
		expect(() =>
			registry.batch(() => {
				registry.tools.add(tool("a"));
				registry.batch(() => {});
			}),
		).toThrow("Registry batches cannot be nested");
		expect(registry.tools.list()).toEqual([]);
	});

	it("keeps old snapshots immutable while new ones see replacements", () => {
		const registry = createRegistry();
		const registration = registry.tools.add(tool("read"));
		const before = registry.snapshot();
		registration.dispose();
		expect(before.tool("read")?.name).toBe("read");
		expect(registry.snapshot().tool("read")).toBeUndefined();
	});

	it("covers only the batch's surviving registrations with its token", () => {
		const registry = createRegistry();
		const outside = registry.tools.add(tool("outside"));
		const batch = registry.batch(() => {
			const staged = registry.tools.add(tool("staged"));
			registry.tools.add(tool("kept"));
			staged.dispose();
		});
		expect(names(registry.tools.list())).toEqual(["outside", "kept"]);
		batch.dispose();
		expect(names(registry.tools.list())).toEqual(["outside"]);
		outside.dispose();
	});

	it("composes tool wrappers per snapshot against the current base and fails closed", () => {
		const registry = createRegistry();
		registry.tools.wrap("read", "audit", (base) => ({ ...base, description: `${base.description} +audit` }));
		expect(registry.tools.list()).toEqual([]);
		const base = registry.tools.add(tool("read"));
		registry.tools.wrap("read", "limit", (inner) => ({ ...inner, description: `${inner.description} +limit` }));
		expect(registry.tools.list()[0]!.description).toBe("read tool +audit +limit");

		registry.batch(() => {
			base.dispose();
			registry.tools.add(tool("read", { description: "read v2" }));
		});
		expect(registry.tools.list()[0]!.description).toBe("read v2 +audit +limit");

		const failure = new Error("wrapper failed");
		const broken = registry.tools.wrap("read", "broken", () => {
			throw failure;
		});
		const snapshot = registry.snapshot();
		expect(snapshot.tools()).toEqual([]);
		expect(snapshot.tool("read")).toBeUndefined();
		expect(snapshot.toolNames()).toEqual(["read"]);
		expect(snapshot.failures()).toEqual([{ kind: "tool", name: "read", error: failure }]);

		broken.dispose();
		// Identity is checked after every wrapper, so a later wrapper cannot restore it.
		registry.tools.wrap("read", "rename", (inner) => ({ ...inner, name: "other" }));
		registry.tools.wrap("read", "restore", (inner) => ({ ...inner, name: "read" }));
		expect(registry.tools.list()).toEqual([]);
	});

	it("validates section keys and composes section wrappers", () => {
		const registry = createRegistry();
		expect(() => registry.systemPrompt.section("1", () => "x")).toThrow("must match");
		expect(() => registry.systemPrompt.section("Upper", () => "x")).toThrow("must match");
		registry.systemPrompt.section("preamble", () => "x");
		expect(() => registry.systemPrompt.section("preamble", () => "y")).toThrow(
			"Section preamble is already registered",
		);

		const wrapped = registry.systemPrompt.section("cwd", () => "/repo", { tag: false });
		registry.systemPrompt.wrap("cwd", "upper", (section) => ({ ...section, tag: true }));
		expect(registry.systemPrompt.sections().map((section) => [section.key, section.tag])).toEqual([
			["preamble", undefined],
			["cwd", true],
		]);
		wrapped.dispose();
		expect(registry.systemPrompt.sections().map((section) => section.key)).toEqual(["preamble"]);
	});

	it("stores tasks and returns typed hooks by task name", () => {
		const registry = createRegistry();
		const worker = task("worker");
		registry.tasks.add(worker);
		expect(() => registry.tasks.add(task("worker"))).toThrow("Task worker is already registered");
		expect(registry.tasks.list()).toEqual([GenerationTask, ToolTask, CompactionTask, worker]);

		const first = { beforeRun: () => {} };
		const second = { beforeRun: () => {} };
		const keyed = registry.hooks.add(worker, first, { key: "audit" });
		registry.hooks.add(worker, second, { scope: { conversationId: 5 as never, subtree: true } });
		expect(() => registry.hooks.add(worker, first, { key: "audit" })).toThrow("already registered");
		registry.batch(() => {
			keyed.dispose();
			registry.hooks.add(task("worker"), first, { key: "audit" });
		});
		const snapshot = registry.snapshot();
		expect(snapshot.task("worker")).toBe(worker);
		// A reloaded definition with the same name still finds hooks registered against the old token.
		const hooks = snapshot.hooks(task("worker"));
		expect(hooks.map((hook) => hook.handlers)).toEqual([first, second]);
		hooks[0]!.handlers.beforeRun?.();
		expect(hooks[1]!.scope).toEqual({ conversationId: 5, subtree: true });
	});

	it("starts with undisposable, non-overridable built-in tasks", () => {
		const registry = createRegistry();
		expect(registry.tasks.list()).toEqual([GenerationTask, ToolTask, CompactionTask]);
		expect(registry.snapshot().task("pi.generation")).toBe(GenerationTask);
		expect(() => registry.tasks.add({ definition: { ...GenerationTask.definition } })).toThrow(
			"Task pi.generation is already registered",
		);
		expect(
			registry
				.snapshot()
				.conversationSetups()
				.map(({ key }) => key),
		).toEqual(["pi"]);
		expect(() => registry.conversations.setup("pi", () => {})).toThrow("Setup pi is already registered");
	});

	it("keeps application tool fields on listed tools", () => {
		const execute = async (args: JsonValue) => ({ details: args });
		const registry = createRegistry<AppTool>();
		registry.tools.add(tool("echo", { execute, snippet: "Echo" }));
		expect(registry.tools.list()[0]!.execute).toBe(execute);
	});
});

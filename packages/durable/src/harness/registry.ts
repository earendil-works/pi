import { INSTRUCTIONS_KEY } from "./agent.ts";
import { CompactionTask } from "./compaction.ts";
import { GenerationTask } from "./generation.ts";
import { ToolTask } from "./tool.ts";
import type { AnyTask, Extension, PromptSection, Registry, RegistrySnapshot, ToolRegistration } from "./types.ts";

const SECTION_KEY = /^[a-z][a-z0-9_-]*$/;

/** Built-in task definitions every registry holds; they are not an extension and cannot be removed or replaced. */
export const BUILTIN_TASKS: readonly AnyTask[] = [GenerationTask, ToolTask, CompactionTask];

/** Immutable published registry state. */
class RegistryState<Tool extends ToolRegistration> implements RegistrySnapshot<Tool> {
	readonly #extensions: readonly Extension<Tool>[];
	readonly #byName: ReadonlyMap<string, Extension<Tool>>;
	readonly #tasks: ReadonlyMap<string, AnyTask>;

	constructor(extensions: readonly Extension<Tool>[]) {
		this.#extensions = extensions;
		this.#byName = new Map(extensions.map((extension) => [extension.name, extension]));
		const tasks = new Map<string, AnyTask>();
		for (const task of BUILTIN_TASKS) tasks.set(task.definition.name, task);
		for (const extension of extensions) {
			for (const task of extension.tasks ?? []) {
				const name = task.definition.name;
				if (tasks.has(name)) throw new Error(`Task ${name} of extension ${extension.name} is already installed`);
				tasks.set(name, task);
			}
		}
		this.#tasks = tasks;
	}

	installed(): readonly Extension<Tool>[] {
		return this.#extensions;
	}

	extension(name: string): Extension<Tool> | undefined {
		return this.#byName.get(name);
	}

	tools(): readonly { readonly extension: Extension<Tool>; readonly tool: Tool }[] {
		return this.#extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => ({ extension, tool })));
	}

	sections(): readonly { readonly extension: Extension<Tool>; readonly section: PromptSection<Tool> }[] {
		return this.#extensions.flatMap((extension) =>
			(extension.sections ?? []).map((section) => ({ extension, section })),
		);
	}

	tasks(): readonly AnyTask[] {
		return [...this.#tasks.values()];
	}

	task(name: string): AnyTask | undefined {
		return this.#tasks.get(name);
	}
}

class RegistryImpl<Tool extends ToolRegistration> implements Registry<Tool> {
	#current = new RegistryState<Tool>([]);
	readonly #listeners = new Set<() => void>();

	snapshot(): RegistrySnapshot<Tool> {
		return this.#current;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	install(extension: Extension<Tool>): void {
		validateExtension(extension);
		const current = this.#current.installed();
		const index = current.findIndex((installed) => installed.name === extension.name);
		const next =
			index < 0 ? [...current, extension] : current.map((installed, at) => (at === index ? extension : installed));
		this.#publish(next);
	}

	uninstall(extension: Extension): void {
		const current = this.#current.installed();
		if (!current.some((installed) => installed.name === extension.name)) return;
		this.#publish(current.filter((installed) => installed.name !== extension.name));
	}

	/** Build and validate the next state, which throws on a task name collision, then publish it synchronously. */
	#publish(extensions: readonly Extension<Tool>[]): void {
		this.#current = new RegistryState(extensions);
		for (const listener of [...this.#listeners]) listener();
	}
}

/** Unique tool names and section keys within one extension; valid, unreserved section keys. */
function validateExtension(extension: Extension): void {
	const tools = new Set<string>();
	for (const tool of extension.tools ?? []) {
		if (tools.has(tool.name)) throw new Error(`Extension ${extension.name} has two tools named ${tool.name}`);
		tools.add(tool.name);
	}
	const sections = new Set<string>();
	for (const { key } of extension.sections ?? []) {
		if (!SECTION_KEY.test(key)) throw new TypeError(`Section key ${JSON.stringify(key)} must match ${SECTION_KEY}`);
		if (key === INSTRUCTIONS_KEY) throw new Error(`Section key ${key} is reserved for the agent's instructions`);
		if (sections.has(key)) throw new Error(`Extension ${extension.name} has two sections with key ${key}`);
		sections.add(key);
	}
}

/** Create an application-owned registry holding only the built-in tasks. */
export function createRegistry<Tool extends ToolRegistration = ToolRegistration>(): Registry<Tool> {
	return new RegistryImpl<Tool>();
}

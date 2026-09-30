import type { ConversationRecord, Tx } from "../types.ts";
import { CompactionTask } from "./compaction.ts";
import { ConversationConfig } from "./config.ts";
import { GenerationTask } from "./generation.ts";
import { InboxDoc } from "./inbox.ts";
import { LiveDoc } from "./live.ts";
import { ToolTask } from "./tool.ts";
import type {
	AnyTask,
	ConversationSetup,
	HookRegistration,
	HookScope,
	HooksOf,
	PromptSection,
	PromptSectionWrapper,
	Registration,
	Registry,
	RegistryFailure,
	RegistrySnapshot,
	ToolRegistration,
	ToolWrapper,
} from "./types.ts";
import { UsageDoc } from "./usage.ts";

const SECTION_KEY = /^[a-z][a-z0-9_-]*$/;

/** Built-in task definitions every registry starts with; they cannot be disposed or replaced. */
export const BUILTIN_TASKS: readonly AnyTask[] = [GenerationTask, ToolTask, CompactionTask];

export const BUILTIN_SETUP_KEY = "pi";

/**
 * Built-in documents: empty `pi.live`, `pi.inbox`, and `pi.usage`, and for a new conversation the default
 * configuration with every registered tool active.
 */
async function builtinSetup(tx: Tx, conversation: ConversationRecord, registry: RegistrySnapshot): Promise<void> {
	await tx.doc(LiveDoc, conversation.id);
	await tx.doc(InboxDoc, conversation.id);
	await tx.doc(UsageDoc, conversation.id);
	if (conversation.parent !== undefined) return;
	(await tx.doc(ConversationConfig, conversation.id)).activeTools = [...registry.toolNames()];
}

type Slot<Tool extends ToolRegistration> =
	| { readonly kind: "tool"; readonly tool: Tool }
	| { readonly kind: "toolWrap"; readonly name: string; readonly wrapper: ToolWrapper<Tool> }
	| { readonly kind: "hook"; readonly taskName: string; readonly hook: StoredHook }
	| { readonly kind: "task"; readonly task: AnyTask }
	| { readonly kind: "setup"; readonly key: string; readonly setup: ConversationSetup }
	| { readonly kind: "section"; readonly section: PromptSection<Tool> }
	| { readonly kind: "sectionWrap"; readonly key: string; readonly wrapper: PromptSectionWrapper<Tool> };

/** Hook handlers erased across task definitions; lookup by task token restores their type. */
type StoredHook = {
	readonly handlers: unknown;
	readonly scope?: HookScope;
};

/** One registration and its lifecycle. */
type RegistryRecord<Tool extends ToolRegistration> = {
	readonly slot: Slot<Tool>;
	/** Uniqueness and position key; absent for keyless hooks, which always append. */
	readonly key: string | undefined;
	/** Human-readable identity for duplicate errors. */
	readonly label: string;
	position: number;
	status: "staged" | "published" | "disposed" | "rejected";
};

type Batch<Tool extends ToolRegistration> = {
	/** Records to publish; a record disposed while staged is removed. */
	readonly added: RegistryRecord<Tool>[];
	readonly disposed: Set<RegistryRecord<Tool>>;
};

type Composition<Tool extends ToolRegistration> = {
	readonly tools: readonly Tool[];
	readonly toolsByName: ReadonlyMap<string, Tool>;
	readonly sections: readonly PromptSection<Tool>[];
	readonly failures: readonly RegistryFailure[];
};

/** Immutable published registry state; wrappers are composed lazily once per state. */
class RegistryState<Tool extends ToolRegistration> implements RegistrySnapshot<Tool> {
	readonly records: readonly RegistryRecord<Tool>[];
	#composition: Composition<Tool> | undefined;

	constructor(records: readonly RegistryRecord<Tool>[]) {
		this.records = records;
	}

	tools(): readonly Tool[] {
		return this.#composed().tools;
	}

	tool(name: string): Tool | undefined {
		return this.#composed().toolsByName.get(name);
	}

	toolNames(): readonly string[] {
		const names: string[] = [];
		for (const record of this.records) if (record.slot.kind === "tool") names.push(record.slot.tool.name);
		return names;
	}

	task(name: string): AnyTask | undefined {
		for (const record of this.records) {
			if (record.slot.kind === "task" && record.slot.task.definition.name === name) return record.slot.task;
		}
		return undefined;
	}

	conversationSetups(): readonly { readonly key: string; readonly setup: ConversationSetup }[] {
		const setups: { key: string; setup: ConversationSetup }[] = [];
		for (const record of this.records) if (record.slot.kind === "setup") setups.push(record.slot);
		return setups;
	}

	tasks(): AnyTask[] {
		const tasks: AnyTask[] = [];
		for (const record of this.records) if (record.slot.kind === "task") tasks.push(record.slot.task);
		return tasks;
	}

	hooks<K extends AnyTask>(task: K): readonly HookRegistration<K>[] {
		// Registration was typed by a token with this name; matching by name lets hooks survive a task reload.
		const hooks: StoredHook[] = [];
		for (const record of this.records) {
			if (record.slot.kind === "hook" && record.slot.taskName === task.definition.name) hooks.push(record.slot.hook);
		}
		return hooks as readonly HookRegistration<K>[];
	}

	sections(): readonly PromptSection<Tool>[] {
		return this.#composed().sections;
	}

	failures(): readonly RegistryFailure[] {
		return this.#composed().failures;
	}

	#composed(): Composition<Tool> {
		if (this.#composition !== undefined) return this.#composition;
		const failures: RegistryFailure[] = [];
		const toolWraps = new Map<string, ToolWrapper<Tool>[]>();
		const sectionWraps = new Map<string, PromptSectionWrapper<Tool>[]>();
		for (const record of this.records) {
			const slot = record.slot;
			if (slot.kind === "toolWrap") appendTo(toolWraps, slot.name, slot.wrapper);
			if (slot.kind === "sectionWrap") appendTo(sectionWraps, slot.key, slot.wrapper);
		}
		const tools: Tool[] = [];
		const toolsByName = new Map<string, Tool>();
		const sections: PromptSection<Tool>[] = [];
		for (const record of this.records) {
			const slot = record.slot;
			if (slot.kind === "tool") {
				const name = slot.tool.name;
				try {
					let tool = slot.tool;
					for (const wrap of toolWraps.get(name) ?? []) {
						tool = wrap(tool);
						if (tool.name !== name) throw new Error(`Tool wrapper renamed ${name} to ${tool.name}`);
					}
					tools.push(tool);
					toolsByName.set(name, tool);
				} catch (error) {
					failures.push({ kind: "tool", name, error });
				}
			} else if (slot.kind === "section") {
				const key = slot.section.key;
				try {
					let section = slot.section;
					for (const wrap of sectionWraps.get(key) ?? []) {
						section = wrap(section);
						if (section.key !== key) throw new Error(`Section wrapper renamed ${key} to ${section.key}`);
					}
					sections.push(section);
				} catch (error) {
					failures.push({ kind: "section", name: key, error });
				}
			}
		}
		this.#composition = { tools, toolsByName, sections, failures };
		return this.#composition;
	}
}

class RegistryImpl<Tool extends ToolRegistration> implements Registry<Tool> {
	#current = new RegistryState<Tool>([]);
	#batch: Batch<Tool> | undefined;
	/** First position of every key ever published; re-registered keys keep it. */
	readonly #positions = new Map<string, number>();
	readonly #listeners = new Set<() => void>();
	#nextPosition = 0;

	readonly tools: Registry<Tool>["tools"];
	readonly hooks: Registry<Tool>["hooks"];
	readonly tasks: Registry<Tool>["tasks"];
	readonly conversations: Registry<Tool>["conversations"];
	readonly systemPrompt: Registry<Tool>["systemPrompt"];

	constructor() {
		this.tools = {
			add: (tool) => this.#register({ kind: "tool", tool }, `tool\0${tool.name}`, `Tool ${tool.name}`),
			wrap: (name, key, wrapper) =>
				this.#register(
					{ kind: "toolWrap", name, wrapper },
					`toolWrap\0${name}\0${key}`,
					`Tool wrapper ${key} for ${name}`,
				),
			list: () => this.#current.tools(),
		};
		this.hooks = {
			add: <K extends AnyTask>(
				task: K,
				handlers: Partial<HooksOf<K>>,
				options?: { readonly scope?: HookScope; readonly key?: string },
			) => {
				const taskName = task.definition.name;
				const hook: StoredHook = options?.scope === undefined ? { handlers } : { handlers, scope: options.scope };
				const key = options?.key;
				return this.#register(
					{ kind: "hook", taskName, hook },
					key === undefined ? undefined : `hook\0${taskName}\0${key}`,
					`Hook ${key} for ${taskName}`,
				);
			},
		};
		this.tasks = {
			add: (task) => {
				const name = task.definition.name;
				return this.#register({ kind: "task", task }, `task\0${name}`, `Task ${name}`);
			},
			list: () => this.#current.tasks(),
		};
		this.conversations = {
			setup: (key, setup) => this.#register({ kind: "setup", key, setup }, `setup\0${key}`, `Setup ${key}`),
		};
		this.systemPrompt = {
			section: (key, render, options) => {
				requireSectionKey(key);
				const section: PromptSection<Tool> =
					options?.tag === undefined ? { key, render } : { key, render, tag: options.tag };
				return this.#register({ kind: "section", section }, `section\0${key}`, `Section ${key}`);
			},
			wrap: (key, wrapperKey, wrapper) => {
				requireSectionKey(key);
				return this.#register(
					{ kind: "sectionWrap", key, wrapper },
					`sectionWrap\0${key}\0${wrapperKey}`,
					`Section wrapper ${wrapperKey} for ${key}`,
				);
			},
			sections: () => this.#current.sections(),
		};
	}

	snapshot(): RegistrySnapshot<Tool> {
		return this.#current;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	batch(register: () => void): Registration {
		if (this.#batch !== undefined) throw new Error("Registry batches cannot be nested");
		const batch: Batch<Tool> = { added: [], disposed: new Set() };
		this.#batch = batch;
		let added: RegistryRecord<Tool>[];
		try {
			rejectThenable(register());
			added = [...batch.added];
			this.#batch = undefined;
			this.#publish(batch);
		} catch (error) {
			this.#batch = undefined;
			for (const record of batch.added) record.status = "rejected";
			throw error;
		}
		return {
			dispose: () => {
				if (this.#batch !== undefined) {
					for (const record of added) this.#dispose(record);
					return;
				}
				this.batch(() => {
					for (const record of added) this.#dispose(record);
				});
			},
		};
	}

	#register(slot: Slot<Tool>, key: string | undefined, label: string): Registration {
		const record: RegistryRecord<Tool> = { slot, key, label, position: -1, status: "staged" };
		const batch = this.#batch;
		if (batch !== undefined) {
			batch.added.push(record);
		} else {
			try {
				this.#publish({ added: [record], disposed: new Set() });
			} catch (error) {
				record.status = "rejected";
				throw error;
			}
		}
		return { dispose: () => this.#dispose(record) };
	}

	#dispose(record: RegistryRecord<Tool>): void {
		const batch = this.#batch;
		if (record.status === "staged") {
			const index = batch?.added.indexOf(record) ?? -1;
			if (index < 0) return;
			batch!.added.splice(index, 1);
			record.status = "disposed";
		} else if (record.status === "published") {
			if (batch !== undefined) batch.disposed.add(record);
			else this.#publish({ added: [], disposed: new Set([record]) });
		}
	}

	/** Validate the final staged state, then publish it synchronously. */
	#publish(batch: Batch<Tool>): void {
		if (batch.added.length === 0 && batch.disposed.size === 0) return;
		const records = [...this.#current.records.filter((record) => !batch.disposed.has(record)), ...batch.added];
		const keys = new Set<string>();
		for (const record of records) {
			if (record.key === undefined) continue;
			if (keys.has(record.key)) throw new Error(`${record.label} is already registered`);
			keys.add(record.key);
		}
		for (const record of batch.added) {
			if (record.key === undefined) {
				record.position = this.#nextPosition++;
				continue;
			}
			let position = this.#positions.get(record.key);
			if (position === undefined) {
				position = this.#nextPosition++;
				this.#positions.set(record.key, position);
			}
			record.position = position;
		}
		records.sort((left, right) => left.position - right.position);
		this.#current = new RegistryState(records);
		for (const record of batch.added) record.status = "published";
		for (const record of batch.disposed) record.status = "disposed";
		for (const listener of [...this.#listeners]) listener();
	}
}

/** Create an application-owned registry holding only the built-ins. */
export function createRegistry<Tool extends ToolRegistration = ToolRegistration>(): Registry<Tool> {
	const registry = new RegistryImpl<Tool>();
	// Their registrations are dropped, so nothing can dispose them.
	for (const task of BUILTIN_TASKS) registry.tasks.add(task);
	registry.conversations.setup(BUILTIN_SETUP_KEY, builtinSetup);
	return registry;
}

function appendTo<T>(map: Map<string, T[]>, key: string, value: T): void {
	const list = map.get(key);
	if (list === undefined) map.set(key, [value]);
	else list.push(value);
}

function requireSectionKey(key: string): void {
	if (!SECTION_KEY.test(key)) throw new TypeError(`Section key ${JSON.stringify(key)} must match ${SECTION_KEY}`);
}

function rejectThenable(result: unknown): void {
	if (
		(typeof result === "object" || typeof result === "function") &&
		result !== null &&
		typeof (result as { then?: unknown }).then === "function"
	) {
		(result as PromiseLike<unknown>).then(undefined, () => undefined);
		throw new TypeError("Registry batch callbacks must be synchronous");
	}
}

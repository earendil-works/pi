import type {
	AssistantMessage,
	Message,
	StopReason,
	SystemMessage,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { createModels, Type } from "@earendil-works/pi-ai";
import {
	type AnyTask,
	createRegistry,
	defineExtension,
	defineTool,
	type Extension,
	Harness,
	type HooksOf,
	hook,
	type PromptSection,
	type Registry,
	type Storage,
	section,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { context } from "./session-support.ts";

export function tool(name: string, description = `${name} tool`): ToolRegistration {
	return defineTool({ name, description, parameters: Type.Object({}), execute: async () => ({ output: [] }) });
}

/** Open a Harness with a fresh registry holding the named tools. */
export async function openHarness(
	storage: Storage,
	toolNames: readonly string[] = [],
	options: { readonly registry?: Registry; readonly onReport?: (error: unknown) => void } = {},
): Promise<{ readonly harness: Harness; readonly registry: Registry }> {
	const registry = options.registry ?? createRegistry();
	if (toolNames.length > 0)
		registry.install(defineExtension({ name: "tools", tools: toolNames.map((name) => tool(name)) }));
	const harness = await Harness.open(
		storage,
		{ models: createModels(), registry, ...(options.onReport === undefined ? {} : { onReport: options.onReport }) },
		context,
	);
	return { harness, registry };
}

export function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

export function assistant(
	text: string,
	options: { readonly calls?: readonly string[]; readonly stopReason?: StopReason } = {},
): AssistantMessage {
	const calls: ToolCall[] = (options.calls ?? []).map((id) => ({
		type: "toolCall",
		id,
		name: `tool-${id}`,
		arguments: {},
	}));
	return {
		role: "assistant",
		content: [{ type: "text", text }, ...calls],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.stopReason ?? (calls.length > 0 ? "toolUse" : "stop"),
		timestamp: 2,
	};
}

export function toolResult(id: string, text = `result ${id}`): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: `tool-${id}`,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	};
}

export function system(sections: Record<string, string | null>): SystemMessage {
	return { role: "system", content: "", sections, timestamp: 4 };
}

/** Compact message rendering for assertions. */
export function describeMessage(message: Message): string {
	switch (message.role) {
		case "user":
			return `user:${message.content as string}`;
		case "assistant": {
			const text = message.content.find((content) => content.type === "text");
			return `assistant:${text?.type === "text" ? text.text : ""}`;
		}
		case "toolResult": {
			const text = message.content.find((content) => content.type === "text");
			return `result:${message.toolCallId}:${message.isError ? "error" : text?.type === "text" ? text.text : ""}`;
		}
		case "system":
			return `system:${Object.keys(message.sections ?? {}).join(",")}`;
	}
}

/** Uninstalls what one of the helpers below installed. */
export type Installed = { dispose(): void };

function installOne<Tool extends ToolRegistration>(registry: Registry<Tool>, extension: Extension<Tool>): Installed {
	registry.install(extension);
	return { dispose: () => registry.uninstall(extension) };
}

/** Install a one-tool extension named after the tool. */
export function addTool<Tool extends ToolRegistration>(
	registry: Registry<Tool>,
	tool: Tool,
	name = `tool:${tool.name}`,
): Installed {
	return installOne(registry, defineExtension<Tool>({ name, tools: [tool] }));
}

/** Install a one-task extension named after the task. */
export function addTask(registry: Registry, task: AnyTask, name = `task:${task.definition.name}`): Installed {
	return installOne(registry, defineExtension({ name, tasks: [task] }));
}

let hookExtensions = 0;

/** Install an extension with one hook registration for `task`. */
export function addHooks<K extends AnyTask>(
	registry: Registry,
	task: K,
	handlers: Partial<HooksOf<K>>,
	name = `hooks:${++hookExtensions}`,
): Installed {
	return installOne(registry, defineExtension({ name, hooks: [hook(task, handlers)] }));
}

/** Install a one-section extension named after the section. */
export function addSection<Tool extends ToolRegistration = ToolRegistration>(
	registry: Registry<Tool>,
	key: string,
	render: PromptSection<Tool>["render"],
	options?: { readonly tag?: boolean },
	name = `section:${key}`,
): Installed {
	return installOne(registry, defineExtension<Tool>({ name, sections: [section(key, render, options)] }));
}

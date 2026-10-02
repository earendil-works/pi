import type { JsonValue } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import type { AnyTask, Extension, HookRegistration, HooksOf, PromptSection, ToolRegistration, Wrap } from "./types.ts";

/** Identity function that types an extension. */
export function defineExtension<Tool extends ToolRegistration = ToolRegistration>(
	extension: Extension<Tool>,
): Extension<Tool> {
	return extension;
}

/** Identity function that types a tool: `args` from `parameters`, details from what it reports. */
export function defineTool<TParameters extends TSchema, TDetails extends JsonValue = JsonValue>(
	tool: ToolRegistration<TParameters, TDetails>,
): ToolRegistration<TParameters, TDetails> {
	return tool;
}

/** A prompt section; tagged unless `tag` is false. */
export function section<Tool extends ToolRegistration = ToolRegistration>(
	key: string,
	render: PromptSection<Tool>["render"],
	options?: { readonly tag?: boolean },
): PromptSection<Tool> {
	return options?.tag === undefined ? { key, render } : { key, render, tag: options.tag };
}

/** Hook handlers for tasks with `task`'s name. */
export function hook<K extends AnyTask>(task: K, handlers: Partial<HooksOf<K>>): HookRegistration {
	return { task: task.definition.name, handlers };
}

/** Wrap the tool named like `tool` wherever the wrapping extension is selected. */
export function wrapTool<Tool extends ToolRegistration>(tool: Tool, wrapper: (tool: Tool) => Tool): Wrap<Tool> {
	return { tool: tool.name, wrap: wrapper };
}

/** Wrap the section `key` wherever the wrapping extension is selected. */
export function wrapSection<Tool extends ToolRegistration = ToolRegistration>(
	key: string,
	wrapper: (section: PromptSection<Tool>) => PromptSection<Tool>,
): Wrap<Tool> {
	return { section: key, wrap: wrapper };
}

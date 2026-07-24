import type { Tool } from "../types.ts";

interface JsonSchemaObject {
	type?: unknown;
	properties?: Record<string, JsonSchemaObject | undefined>;
	required?: unknown;
}

export interface GrammarConstrainedSampling {
	format: "lark" | "regex";
	definition: string;
	inputProperty: string;
}

export interface GrammarToolInputJsonBuffer {
	input: string;
	started: boolean;
	closed: boolean;
}

export function getGrammarToolInput(
	toolName: string,
	arguments_: Record<string, unknown>,
	inputProperty: string,
): string {
	const input = arguments_[inputProperty];
	if (typeof input !== "string") {
		throw new Error(`Grammar tool call "${toolName}" requires argument "${inputProperty}" to be a string.`);
	}
	return input;
}

export function appendGrammarToolInputJsonDelta(
	buffer: GrammarToolInputJsonBuffer,
	inputProperty: string,
	nextInput: string,
	close: boolean,
): string | undefined {
	if (buffer.closed) {
		if (close && nextInput === buffer.input) return undefined;
		throw new Error(`grammar tool input for property "${inputProperty}" changed after it was closed`);
	}
	if (!nextInput.startsWith(buffer.input)) {
		throw new Error(`grammar tool input for property "${inputProperty}" changed non-monotonically`);
	}

	const inputDelta = nextInput.slice(buffer.input.length);
	if (!close && inputDelta.length === 0) return undefined;

	let delta = "";
	if (!buffer.started) {
		delta += `{${JSON.stringify(inputProperty)}:"`;
		buffer.started = true;
	}
	delta += JSON.stringify(inputDelta).slice(1, -1);
	buffer.input = nextInput;

	if (close) {
		delta += '"}';
		buffer.closed = true;
	}
	return delta;
}

function inferGrammarInputProperty(tool: Tool): string {
	const schema = tool.parameters as JsonSchemaObject;
	if (schema.type !== "object") {
		throw new Error("grammar constrained sampling requires an object parameter schema");
	}
	if (!Array.isArray(schema.required) || schema.required.length !== 1 || typeof schema.required[0] !== "string") {
		throw new Error("grammar constrained sampling requires exactly one required string property");
	}

	const inputProperty = schema.required[0];
	if (!schema.properties?.[inputProperty]) {
		throw new Error(`grammar constrained sampling requires a properties entry for ${inputProperty}`);
	}
	if (schema.properties[inputProperty]?.type !== "string") {
		throw new Error(`grammar constrained sampling property ${inputProperty} must have type string`);
	}
	return inputProperty;
}

export function resolveJsonSchemaStrictSampling(tool: Tool, supportsStrictMode: boolean): boolean | undefined {
	const config = tool.constrainedSampling;
	if (!config || config.type !== "json_schema") {
		return undefined;
	}

	if (supportsStrictMode) {
		return true;
	}
	if (config.strict === "require") {
		throw new Error(
			`Tool "${tool.name}" requires JSON-schema constrained sampling, but strict tools are unsupported.`,
		);
	}
	return undefined;
}

export function resolveGrammarConstrainedSampling(
	tool: Tool,
	supportsOpenAIGrammarTools: boolean,
): GrammarConstrainedSampling | undefined {
	const config = tool.constrainedSampling;
	if (!config || config.type !== "grammar") {
		return undefined;
	}

	if (!supportsOpenAIGrammarTools) {
		return undefined;
	}

	const larkDefinition = config.variants.openai_lark;
	const regexDefinition = config.variants.openai_regex;
	const hasLarkDefinition = typeof larkDefinition === "string" && larkDefinition.trim().length > 0;
	const hasRegexDefinition = typeof regexDefinition === "string" && regexDefinition.trim().length > 0;
	if (!hasLarkDefinition && !hasRegexDefinition) {
		throw new Error(
			`Tool "${tool.name}" cannot use grammar constrained sampling: no supported grammar variant was provided.`,
		);
	}

	try {
		return {
			format: hasLarkDefinition ? "lark" : "regex",
			definition: hasLarkDefinition ? larkDefinition : regexDefinition!,
			inputProperty: inferGrammarInputProperty(tool),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Tool "${tool.name}" cannot use grammar constrained sampling: ${message}.`);
	}
}

export function createGrammarToolInputProperties(
	tools: Tool[] | undefined,
	supportsOpenAIGrammarTools: boolean,
): ReadonlyMap<string, string> {
	const properties = new Map<string, string>();
	for (const tool of tools ?? []) {
		const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
		if (grammar) {
			properties.set(tool.name, grammar.inputProperty);
		}
	}
	return properties;
}
